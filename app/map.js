import * as maplibreNs from 'https://esm.sh/maplibre-gl@5.6.0';
const maplibregl = maplibreNs.default ?? maplibreNs;
import { CONFIG, CATEGORY_COLORS } from './config.js';
import * as areas from './areas.js';
import {
  cellAt,
  cellBoundary,
  cellCenter,
  cellResolution,
  cellsInBounds,
  childrenOf,
  diskCells,
  gridDistance,
  neighbors,
  parentCell,
  tileStatus,
  unlockedNeighborSet,
  isUnlocked,
} from './engine.js';

export function createMap({ onHexSelect, onMove, onLevelSelect, onUserGesture, onUserDotTap, onQuestMark, onQuestSelect }) {
  const map = new maplibregl.Map({
    container: 'liveMap',
    style: CONFIG.mapStyle,
    // Neutral wide view until the gate grants a real place — never a street.
    center: [0, 22],
    zoom: CONFIG.defaultZoom,
    pitch: 50,
    maxPitch: 50,
    minPitch: 50,
    attributionControl: true,
  });

  // Screen-fixed user puck: always dead-center, the map moves behind it.
  // Follow mode recenters on every fix (full opacity); any user gesture on
  // the map drops to browse mode (puck dims to 30%, camera stays put).
  const puck = document.createElement('div');
  puck.id = 'userPuck';
  map.getContainer().appendChild(puck);
  let following = true;
  function setPuckDimmed(dimmed) {
    puck.classList.toggle('dimmed', !!dimmed);
  }
  function enterBrowse() {
    if (!following) return;
    following = false;
    setPuckDimmed(true);
    onUserGesture?.();
  }
  let selectedCell = null;
  // Quest marking: while armed, map taps report a point instead of selecting.
  let markingMode = false;
  // Quest mode: street hexes render unlocked by default and selection runs
  // amber (outline + pulse). The user dot and mastered schematic are untouched.
  let questMode = false;
  // Selection pulse: loops until another tile is tapped. Green for open
  // (unlocked/mastered) taps, white for active/locked. Runs on the
  // selected-outline layer only — the mastered border schematic is untouched.
  let pulseTimer = 0;
  let pulsePhase = 0;
  // Tap-gated pin fade: showTilePins/hideTilePins (API, below) live outside
  // the load callback, so the timer lives here at createMap scope.
  let pinFadeTimer = 0;
  // Same-scope rule for the opacity driver: the API methods call it, so it
  // lives here — `map` is in closure either way. Fill AND ring fade as one:
  // the stroke has its own opacity channel that would otherwise survive.
  function setPinsOpacity(v, transitionMs) {
    try {
      map.setPaintProperty('activity-pins', 'circle-opacity-transition', { duration: transitionMs, delay: 0 });
      map.setPaintProperty('activity-pins', 'circle-opacity', v);
      map.setPaintProperty('activity-pins', 'circle-stroke-opacity-transition', { duration: transitionMs, delay: 0 });
      map.setPaintProperty('activity-pins', 'circle-stroke-opacity', v);
    } catch {}
  }
  function pulseTick() {
    try {
      pulsePhase += 0.35;
      const k = 0.5 + 0.5 * Math.sin(pulsePhase);
      // Quest-tile pulse: fill + border breathe on the same phase (in sync).
      if (map.getLayer('quest-tile-pulse')) {
        map.setPaintProperty('quest-tile-pulse', 'fill-opacity', 0.08 + 0.2 * k);
      }
      if (map.getLayer('quest-tile-edge')) {
        map.setPaintProperty('quest-tile-edge', 'line-opacity', 0.55 + 0.45 * k);
        map.setPaintProperty('quest-tile-edge', 'line-width', 2 + 1.5 * k);
      }
      if (!map.getLayer('selected-fill') || !selectedCell) return;
      map.setPaintProperty('selected-fill', 'fill-opacity', 0.1 + 0.2 * k);
    } catch {}
  }
  // Live quest cells for the tile pulse (pushed from the quests cache).
  let questCellList = [];
  function questPulseFilter() {
    return ['in', ['get', 'h3'], ['literal', questCellList]];
  }
  function applyQuestPulse() {
    try {
      const f = questPulseFilter();
      if (map.getLayer('quest-tile-pulse')) map.setFilter('quest-tile-pulse', f);
      if (map.getLayer('quest-tile-edge')) map.setFilter('quest-tile-edge', f);
      const vis = questCellList.length ? 'visible' : 'none';
      if (map.getLayer('quest-tile-pulse')) map.setLayoutProperty('quest-tile-pulse', 'visibility', vis);
      if (map.getLayer('quest-tile-edge')) map.setLayoutProperty('quest-tile-edge', 'visibility', vis);
      // The selection loop used to own the timer — quest cells start it too
      // so the pulse breathes with no tile ever tapped.
      if (questCellList.length && !pulseTimer) pulseTimer = window.setInterval(pulseTick, 120);
    } catch {}
  }
  // No silent user position: null until a real fix lands via the gate,
  // tracking, or the sandbox joystick. Nothing defaults to any street.
  let userLngLat = null;

  // ---- Paint scheduler + caches (perf) ----
  // paint() is called up to twice per second (dwell tick + HUD) plus on every
  // pan/zoom. Rebuilding 2800 H3 polygons + setData each time blocks the main
  // thread and janks panning. So: coalesce calls into one rAF, reuse cached
  // geometry for an unchanged viewport, and skip setData entirely when no
  // tile status actually changed.
  let paintQueued = false;
  let pendingStore = null;
  let lastStoreRef = null;
  let lastFogKey = null;
  let lastStatusSig = null;
  let cachedCellsKey = null;
  let cachedCells = null;
  const boundaryCache = new Map();
  const BOUNDARY_CACHE_MAX = 20000;

  // ---- City-core grid cache ----
  // One gridDisk(k=45) around the base cell ≈ 6.2k cells / GHMC core.
  // Centers are precomputed once (cheap, synchronous); per-pan rendering
  // filters this list by viewport bounds instead of re-running the H3
  // polygon polyfill. Rebuilt only when the base moves >15 rings (~4.5km).
  // Viewports outside the cached disk fall back to polygonToCells below.
  let cityCenter = null;
  let cityList = [];

  function ensureCityCache(baseCell) {
    if (cityCenter && gridDistance(baseCell, cityCenter) <= 15) return false;
    const ids = diskCells(baseCell, CONFIG.cityCacheK);
    const list = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const center = cellCenter(ids[i]);
      list[i] = { cell: ids[i], lat: center.lat, lng: center.lng };
    }
    cityCenter = baseCell;
    cityList = list;
    return true;
  }

  function cityCovers(centerCell) {
    if (!cityCenter || cityList.length === 0) return false;
    return gridDistance(centerCell, cityCenter) <= CONFIG.cityCacheK - 15;
  }

  function sliceCityCells(bounds) {
    const pad = 0.002;
    const n = bounds.getNorth() + pad;
    const s = bounds.getSouth() - pad;
    const e = bounds.getEast() + pad;
    const w = bounds.getWest() - pad;
    const out = [];
    for (let i = 0; i < cityList.length; i++) {
      const c = cityList[i];
      if (c.lat <= n && c.lat >= s && c.lng <= e && c.lng >= w) out.push(c.cell);
    }
    return out;
  }

  // ---- Resolution ladder: fog at every zoom ----
  // Res-9 cells for a zoomed-out viewport would be millions of polygons, so
  // coarser parent cells render instead (same 3 tints, statuses aggregated
  // from the res-9 store). An adaptive loop guarantees a render: step down
  // while over budget, one refinement step up via children when it fits.
  function fogResolutionForZoom(zoom) {
    if (zoom >= 13) return 9;
    if (zoom >= 11) return 8;
    if (zoom >= 9) return 7;
    if (zoom >= 7) return 6;
    if (zoom >= 5) return 4;
    if (zoom >= 3) return 3;
    return 2;
  }

  function coarseStatusMaps(store, res) {
    const unlocked = new Set();
    const touched = new Set();
    const entries = Object.entries(store.tiles);
    for (const [cell, rec] of entries) {
      const anc = parentCell(cell, res);
      if (isUnlocked(rec)) unlocked.add(anc);
      else touched.add(anc);
    }
    // Mirror the res-9 rule: an unlocked tile activates its neighbors.
    for (const [cell, rec] of entries) {
      if (!isUnlocked(rec)) continue;
      for (const nb of neighbors(cell)) {
        const a = parentCell(nb, res);
        if (!unlocked.has(a)) touched.add(a);
      }
    }
    return { unlocked, touched };
  }

  function resolveCells(bounds, centerCell, zoom) {
    // Res 9 inside the cached city disk: slice, no polyfill at all.
    if (fogResolutionForZoom(zoom) === CONFIG.h3Resolution && cityCovers(centerCell)) {
      return { res: CONFIG.h3Resolution, cells: sliceCityCells(bounds) };
    }
    const guess = fogResolutionForZoom(zoom);
    const key = `${viewportKey()}#${guess}`;
    if (key === cachedCellsKey) return cachedCells;
    let res = guess;
    let cells = cellsInBounds(bounds, res);
    let guard = 0;
    while (cells.length > CONFIG.maxRenderCells && res > 1 && guard++ < 5) {
      res -= 1;
      cells = cellsInBounds(bounds, res);
    }
    // One refinement step via children (cheap, no polyfill) when it fits.
    if (res < CONFIG.h3Resolution && cells.length * 7 <= CONFIG.maxRenderCells) {
      const kids = [];
      for (const c of cells) {
        const ch = childrenOf(c, res + 1);
        for (const k of ch) kids.push(k);
      }
      res += 1;
      cells = kids;
    }
    const out = { res, cells };
    cachedCellsKey = key;
    cachedCells = out;
    return out;
  }

  function viewportKey() {
    const b = map.getBounds();
    const z = map.getZoom();
    const r = (n) => n.toFixed(4);
    return `${z.toFixed(2)}|${r(b.getNorth())}|${r(b.getSouth())}|${r(b.getEast())}|${r(b.getWest())}`;
  }

  function boundaryFor(cell) {
    let ring = boundaryCache.get(cell);
    if (!ring) {
      ring = cellBoundary(cell);
      if (boundaryCache.size > BOUNDARY_CACHE_MAX) boundaryCache.clear();
      boundaryCache.set(cell, ring);
    }
    return ring;
  }

  const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

  // POI allowlist mirrors the poi-symbols layer's icon match (data side).
  const POI_SUBCLASSES = new Set([
    'restaurant', 'cafe', 'bar', 'pub', 'beer', 'nightclub',
    'resort', 'hotel', 'hostel', 'motel', 'guest_house',
    'museum', 'art_gallery', 'gallery',
    'garden', 'park', 'police',
    'stadium', 'pitch', 'swimming_pool', 'swimming', 'golf', 'tennis', 'cricket',
    'spa', 'fuel', 'hospital', 'pharmacy', 'mall',
    'bus_stop', 'bus_station', 'station', 'railway_station', 'halt', 'subway', 'metro',
    'monument', 'attraction', 'castle', 'historic',
  ]);

  // POIs render unfiltered on both maps: every in-scope symbol shows with
  // full icon + dark label, whatever the tile beneath reads.
  let lastPoiKey = null;
  function refreshPois(store, memoKey) {
    const src = map.getSource('poi-geo');
    if (!src) return;
    if (!store) {
      if (lastPoiKey === 'cleared') return;
      lastPoiKey = 'cleared';
      try {
        src.setData(EMPTY_COLLECTION);
      } catch {}
      return;
    }
    if (memoKey && memoKey === lastPoiKey) return;
    lastPoiKey = memoKey || 'live';
    const feats = [];
    try {
      const raw = map.querySourceFeatures('openmaptiles', { sourceLayer: 'poi', filter: ['has', 'name'] }) || [];
      const seen = new Set();
      for (const f of raw) {
        const p = f.properties || {};
        const sub = p.subclass;
        if (!sub || !POI_SUBCLASSES.has(sub)) continue;
        const coords = f.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;
        const lng = coords[0];
        const lat = coords[1];
        const dedupe = `${sub}|${lng.toFixed(5)},${lat.toFixed(5)}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        feats.push({
          type: 'Feature',
          properties: { name: p.name_en || p.name || '', subclass: sub, st: 'unlocked' },
          geometry: { type: 'Point', coordinates: [lng, lat] },
        });
      }
    } catch {}
    try {
      src.setData({ type: 'FeatureCollection', features: feats });
    } catch {}
  }
  const semSig = {};

  function schedulePaint(store) {
    pendingStore = store;
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const next = pendingStore;
      pendingStore = null;
      if (next) doPaint(next);
    });
  }

  // ---- Semantic bands ----
  // Above the street band the map shows Area > District > City > State >
  // Country > Continent tiles. Zoom is free everywhere; tile appearance
  // transitions at band edges via layer min/maxzoom.
  function bandForZoom(zoom) {
    // Hex base at every zoom; exactly one polygon band visible at a time.
    // Street (per-hex exploration) takes over at 12.70.
    if (zoom >= 12.7) return 'street';
    if (zoom >= 10.5) return 'area';
    if (zoom >= 9.3) return 'city';
    if (zoom >= 6.5) return 'district';
    if (zoom >= 3.0) return 'state';
    if (zoom >= 2.0) return 'country';
    return 'continent';
  }

  function bandCovers(band, lng, lat) {
    switch (band) {
      case 'area':
        return !!areas.areaAt(lng, lat);
      case 'district':
      case 'city':
        return !!areas.districtAt(lng, lat);
      case 'state':
        return !!areas.stateAt(lng, lat);
      default:
        return true; // country + continent packs are global
    }
  }

  function statusSigOf(items, stats) {
    if (!items) return '0';
    const parts = new Array(items.length);
    for (let i = 0; i < items.length; i++) parts[i] = stats.get(items[i].id)?.status || 'u';
    return parts.join(',');
  }

  function updateBandLabels(band, labels, labelStats, extraLabel) {
    const labelSource = map.getSource(`${band}-labels`);
    if (labelSource) {
      const lsig = `${band}-labels:${statusSigOf(labels, labelStats)}`;
      if (lsig !== semSig[`${band}-labels`]) {
        const feats = areas.labelFeatures(labels, labelStats);
        if (extraLabel) feats.features.push(extraLabel);
        labelSource.setData(feats);
        semSig[`${band}-labels`] = lsig;
      }
    }
  }

  function updateBandSources(band, items, stats, labels, labelStats, extraLabel) {
    const tileSource = map.getSource(`${band}-tiles`);
    if (tileSource) {
      const sig = `${band}:${statusSigOf(items, stats)}`;
      if (sig !== semSig[band]) {
        tileSource.setData(areas.levelFeatures(items, stats));
        semSig[band] = sig;
      }
    }
    updateBandLabels(band, labels, labelStats, extraLabel);
  }

  // Hex base layer: painted at every zoom via the resolution ladder (H9
  // forced at street). Below street, exploration stays hidden — every hex
  // renders locked and polygons carry the signal. Street + no-data regions
  // reveal per-hex statuses.
  function paintHexFog(store, { forceRes9 = false, reveal = false } = {}) {
    const fogSource = map.getSource('hex-fog');
    const bounds = map.getBounds();
    const c = map.getCenter();
    let res;
    let cells;
    if (forceRes9) {
      // Street band always renders true H9 cells, never the ladder.
      res = CONFIG.h3Resolution;
      const centerCell = cellAt(c.lat, c.lng);
      if (cityCovers(centerCell)) {
        cells = sliceCityCells(bounds);
      } else {
        const key = `${viewportKey()}#9`;
        if (key === cachedCellsKey) {
          cells = cachedCells.cells;
        } else {
          cells = cellsInBounds(bounds, CONFIG.h3Resolution);
          cachedCellsKey = key;
          cachedCells = { res, cells };
        }
      }
    } else {
      ({ res, cells } = resolveCells(bounds, cellAt(c.lat, c.lng), map.getZoom()));
    }
    if (cells.length > CONFIG.maxRenderCells) {
      if (fogSource && lastFogKey !== 'empty') {
        fogSource.setData(EMPTY_COLLECTION);
        lastFogKey = 'empty';
        lastStatusSig = null;
      }
      return;
    }
    let statuses;
    if (!reveal) {
      // Polygons carry the signal here: uniform locked base, no per-hex cost.
      statuses = new Array(cells.length).fill('unclaimed');
    } else if (res === CONFIG.h3Resolution) {
      const neighborSet = unlockedNeighborSet(store);
      // Mastered = unlocked + stored media (blob, path, or legacy url).
      // Quest mode skips both (regular context is invisible there).
      const mediaCells = new Set();
      if (!questMode) {
        for (const a of store.activities || []) {
          if (a.cell && (a.localUrl || a.media_path || a.media_url)) mediaCells.add(a.cell);
        }
      }
      statuses = new Array(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        if (questMode) {
          // Quest map reads clear/unlocked everywhere — no states at all.
          statuses[i] = 'unlocked';
          continue;
        }
        const rec = store.tiles[cell];
        if (isUnlocked(rec)) statuses[i] = mediaCells.has(cell) ? 'mastered' : 'unlocked';
        else if (rec || neighborSet.has(cell)) statuses[i] = 'activated';
        else statuses[i] = 'unclaimed';
      }
    } else {
      const { unlocked, touched } = reveal ? coarseStatusMaps(store, res) : { unlocked: new Set(), touched: new Set() };
      statuses = new Array(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        statuses[i] = unlocked.has(cell) ? 'unlocked' : touched.has(cell) ? 'activated' : 'unclaimed';
      }
    }
    const sig = `${res}:${statuses.join(',')}`;
    const key = viewportKey();
    if (fogSource && (sig !== lastStatusSig || key !== lastFogKey)) {
      fogSource.setData({
        type: 'FeatureCollection',
        features: cells.map((cell, i) => ({
          type: 'Feature',
          id: cell,
          properties: { h3: cell, status: statuses[i] },
          geometry: { type: 'Polygon', coordinates: [boundaryFor(cell)] },
        })),
      });
      lastStatusSig = sig;
      lastFogKey = key;
    }
  }

  function paintSemanticBand(store, band) {
    // Packs lazy-load on first zoom-out; full hex fog covers the wait and
    // any region without semantic data (the only place hexes still fill).
    if (!areas.levelReady(band)) {
      areas.ensureLevel(band).then((loaded) => {
        if (loaded && lastStoreRef) schedulePaint(lastStoreRef);
      });
      paintHexFog(store, { reveal: true });
      return;
    }
    const ctr = map.getCenter();
    if (!bandCovers(band, ctr.lng, ctr.lat)) {
      paintHexFog(store, { reveal: true });
      return;
    }
    const { areaStats, rollup: fullRollup } = areas.getRollup(store);
    const rollup = band === 'area' ? null : fullRollup;
    let items;
    let stats;
    let labels;
    let labelStats;
    let extraLabel = null;
    if (band === 'area') {
      // Area band: uniform locked hex base (ladder) + ward polygons, whose
      // fills/labels carry every state. Quest mode skips the overlay —
      // regular area states must not render on the quest map.
      paintHexFog(store);
      if (!questMode) {
        const areaItems = areas.getPack('areas');
        updateBandSources('area', areaItems, areaStats, areaItems, areaStats, null);
      }
      return;
    } else if (band === 'district') {
      // If exploration has begun inside the city's districts, the city tile
      // persists through this band and those small member districts don't
      // render — the ward union replaces them one-for-one (all-or-nothing,
      // since the union spatially overlaps every one of them).
      const cityDistricts = areas.getCityDistrictIds();
      const cityItem = areas.getCityItem();
      let cityLive = false;
      if (cityItem) {
        const wardList = areas.getPack('areas') || [];
        for (const a of wardList) {
          if (cityDistricts.has(a.parent) && (areaStats.get(a.id)?.status || 'unclaimed') !== 'unclaimed') {
            cityLive = true;
            break;
          }
        }
      }
      if (cityLive && cityItem) {
        const districts = areas.getPack('districts') || [];
        const rest = districts.filter((d) => !cityDistricts.has(d.id));
        items = [...rest, cityItem];
        stats = new Map();
        labelStats = new Map();
        for (const d of rest) {
          const st = rollup.districts.get(d.id) || { status: 'unclaimed', total: 0, unlocked: 0 };
          stats.set(d.id, st);
          labelStats.set(d.id, st);
        }
        const cst = rollup.city || { status: 'unclaimed', total: 0, unlocked: 0 };
        stats.set(cityItem.id, cst);
        labelStats.set(cityItem.id, cst);
        labels = items;
      } else {
        items = areas.getPack('districts');
        stats = rollup.districts;
        labels = items;
        labelStats = rollup.districts;
      }
    } else if (band === 'city') {
      // City tile = the GHMC ward union: one polygon, one status, one
      // label. Outside ward coverage the hex base stands alone.
      const cityItem = areas.getCityItem();
      items = cityItem ? [cityItem] : [];
      stats = new Map();
      labels = items;
      labelStats = new Map();
      if (cityItem) {
        const st = rollup.city || { status: 'unclaimed', total: 0, unlocked: 0 };
        stats.set(cityItem.id, st);
        labelStats.set(cityItem.id, st);
      }
    } else if (band === 'state') {
      items = areas.getPack('states');
      stats = rollup.states;
      labels = items;
      labelStats = rollup.states;
    } else if (band === 'country') {
      items = areas.getPack('countries');
      stats = rollup.countries;
      labels = items;
      labelStats = rollup.countries;
    } else {
      const countries = areas.getPack('countries') || [];
      items = countries;
      stats = new Map();
      for (const cn of countries) {
        stats.set(
          cn.id,
          rollup.continents.get(cn.continent || 'Other') || { status: 'unclaimed', total: 0, unlocked: 0 },
        );
      }
      const meta = areas.getMeta();
      labels = (meta?.continents || []).map((k) => ({ id: k.name, name: k.name, c: k.c }));
      labelStats = rollup.continents;
    }
    updateBandSources(
      band,
      items,
      questMode ? new Map() : stats,
      labels,
      questMode ? new Map() : labelStats,
      extraLabel,
    );
    // Hex base under every polygon band (uniform locked — statuses reveal
    // at street only). The ladder auto-degrades resolution to stay in
    // budget, so the base never blanks. Quest mode keeps shapes + names
    // neutral: no regular states above either.
    paintHexFog(store);
  }

  function doPaint(store) {
    try {
      doPaintInner(store);
    } catch (err) {
      // Diagnostic tripwire: a silent paint death looks exactly like "tiles
      // don't light up". Name it loudly instead.
      console.error('[paint] failed:', err?.message || err, err?.stack);
      if (!window.__paintErrorShown) {
        window.__paintErrorShown = true;
        const t = document.getElementById('toast');
        if (t) {
          t.textContent = `Paint error: ${err?.message || err}`;
          t.classList.add('visible');
        }
      }
    }
  }

  function doPaintInner(store) {
    lastStoreRef = store;
    if (store.baseCell) ensureCityCache(store.baseCell);
    if (areas.levelReady('area')) areas.buildAreaHexes();
    const band = bandForZoom(map.getZoom());
    if (band === 'street') {
      const areaStats = areas.levelReady('area') ? areas.getRollup(store).areaStats : null;
      // Street base = H9 hex fog with full per-hex exploration; ward
      // fills + labels overlay it for orientation (no ward borders).
      paintHexFog(store, { forceRes9: true, reveal: true });
      // Area fills + labels overlay the street hexes for orientation —
      // skipped in quest mode (regular context stays off the quest map).
      if (areaStats && !questMode) {
        const items = areas.getPack('areas');
        updateBandSources('area', items, areaStats, items, areaStats, null);
      }
      // State-filtered POIs ride the street paint (memoized inside).
      try {
        const b = map.getBounds();
        refreshPois(
          store,
          `${b.getNorth().toFixed(4)}|${b.getSouth().toFixed(4)}|${b.getEast().toFixed(4)}|${b.getWest().toFixed(4)}#${store.rev || 0}#${questMode ? 'q' : 'r'}`,
        );
      } catch {}
    } else {
      paintSemanticBand(store, band);
      // Off street: no POIs (cleared + memoized inside).
      try {
        refreshPois(null);
      } catch {}
    }

    // Activity pins are tap-driven (showTilePins/hideTilePins) — never painted here.
  }

  function activityCollection(activities) {
    return {
      type: 'FeatureCollection',
      features: activities.map((activity) => ({
        type: 'Feature',
        properties: {
          id: activity.id,
          category: activity.category,
          color: CATEGORY_COLORS[activity.category] || '#173668',
          title: activity.title,
        },
        geometry: { type: 'Point', coordinates: [activity.lng, activity.lat] },
      })),
    };
  }

  map.on('load', () => {
    map.addSource('hex-fog', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('activities', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // Tap feedback: single-feature sources, fed from the clicked hex.
    map.addSource('tap-flash', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('tap-ring', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    for (const band of ['area', 'district', 'city', 'state', 'country', 'continent']) {
      map.addSource(`${band}-tiles`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource(`${band}-labels`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    // Ward borders are the true OSM ward polygons (area-tiles); the hex fog
    // underneath stays hexes. No dissolved hex-edge overlay anymore.
      // (area-edges source retired: ward outlines now come from area-tiles.)

    // Polygon states: unclaimed draws borders only (hexes are the fill).
    // Activated carries no fill at all — it borrows the hex layer below —
    // and reads purely through its blue edge-light. Unlocked fills green,
    // mastered (areas only) fills gold.
    // Live fills get a white hairline (unclaimed opacity is 0, so its
    // outline stays invisible).
    const TILE_FILL_COLOR = [
      'match',
      ['get', 'status'],
      'unlocked',
      '#5cc581',
      'mastered',
      '#d9a13b',
      '#3e4a57',
    ];
    const TILE_FILL_OPACITY = [
      'match',
      ['get', 'status'],
      'unlocked',
      0.7,
      'mastered',
      0.7,
      0,
    ];

    // One fill + glow border + core border + labels per semantic level.
    // Activated edge-light, shared by every polygon band: blurred blue
    // halo under a bright core, same as the street hexes. Grey fill stays.
    function addBandEdgeLight(source, minzoom, maxzoom) {
      map.addLayer({
        id: `${source}-edge-glow`,
        type: 'line',
        source,
        minzoom,
        maxzoom,
        filter: ['==', ['get', 'status'], 'activated'],
        paint: {
          'line-color': '#8fd0f2',
          'line-width': 7,
          'line-blur': 5,
          'line-opacity': 0.55,
        },
      });
      map.addLayer({
        id: `${source}-edge`,
        type: 'line',
        source,
        minzoom,
        maxzoom,
        filter: ['==', ['get', 'status'], 'activated'],
        paint: {
          'line-color': '#c4e4f7',
          'line-width': 2,
          'line-opacity': 0.95,
        },
      });
    }
    // Bands mirror app/data/meta.json; area borders/labels extend into the
    // street band as an orientation overlay. Adjacent bands overlap by FADE
    // on each side with a zoom-ramped opacity, so levels crossfade instead
    // of popping. A uniform locked hex base renders under every band, so
    // land without deeper data never goes bare. Hex features carry stable
    // H3 ids so status changes animate through paint transitions.
    const FADE = 0.4;
    const BAND_VIS = {
      area: { min: 10.5, max: 12.7, text: [11.0, 10, 13, 14] },
      district: { min: 6.5, max: 9.3, text: [6.5, 10, 12, 15] },
      city: { min: 9.3, max: 10.5, text: [8.5, 11, 10, 16] },
      state: { min: 3.0, max: 6.5, text: [3.0, 10, 8, 15] },
      country: { min: 2.0, max: 3.0, text: [2.0, 9, 6, 14] },
      continent: { min: 0, max: 2.0, text: [0, 12, 4, 20] },
    };
    // 0→1 ramp across the overlap below the band, 1→0 above (unless open).
    // NOTE: zoom must feed a top-level interpolate (style-spec rule), so the
    // status match sits inside the output stops — never multiplied outside.
    // (Labels only now; polygon fills are hard on/off via min/maxzoom.)
    function bandRamp(lo, hi, topOpen) {
      const stops = [];
      if (lo > FADE) stops.push(lo - FADE, 0, lo, 1);
      else stops.push(0, 1);
      if (topOpen) stops.push(Math.max(hi, 22), 1);
      else stops.push(hi, 1, hi + FADE, 0);
      return ['interpolate', ['linear'], ['zoom'], ...stops];
    }
    const LABEL_COLOR = [
      'match',
      ['get', 'status'],
      'unclaimed',
      '#ffffff',
      'mastered',
      '#8a6d1f',
      '#0e4a7a',
    ];
    // Locked labels sit on dark fills: white text with a dark drop-shadow
    // halo. Live states keep navy text on a light halo.
    const LABEL_HALO = [
      'match',
      ['get', 'status'],
      'unclaimed',
      'rgba(10,20,35,0.65)',
      'rgba(255,255,255,0.9)',
    ];
    // Hex base MUST be added before every polygon layer: insertion order
    // is paint order, so this keeps hexes under all fills and labels.
    // Seamless fill, antialias off, no seams. Activated fills sky-blue;
    // unlocked + mastered (stored media) are clear.
    map.addLayer({
      id: 'hex-fills',
      type: 'fill',
      source: 'hex-fog',
      paint: {
        'fill-antialias': false,
        'fill-color': [
          'match',
          ['get', 'status'],
          'unlocked',
          '#4ea7da',
          'mastered',
          'rgba(0,0,0,0)',
          'activated',
          '#4ea7da',
          '#1d242e',
        ],
        'fill-opacity': [
          'match',
          ['get', 'status'],
          'unlocked',
          0.2,
          'mastered',
          0,
          'activated',
          0.65,
          0.62,
        ],
        'fill-opacity-transition': { duration: 300, delay: 0 },
      },
    });
    // Activated edge-light lives on the polygon bands only now — the
    // street hexes read pure blue fill.
    // Mastered tiles read as-is: clear fill, no border. The stored media
    // in the gallery carries the reward, not the map.
    // Area labels overlay the street hexes for orientation (their window
    // runs open-top); polygon fills hard-switch per FILL_WINDOW.
    for (const [band, vis] of Object.entries(BAND_VIS)) {
      const openTop = band === 'area';
      const ramp = bandRamp(vis.min, vis.max, openTop);
      // Labels are strictly windowed (no FADE lead-in/out): each band's
      // names enter exactly at its lower edge and leave at its upper edge
      // (area labels continue as the street overlay). Quick 0.15-zoom
      // fades inside the edges keep it smooth without breaking the
      // Country → State → District → City → Area → Street order.
      const labelMax = band === 'area' ? 22 : vis.max;
      const labelOpacity = band === 'area'
        ? ramp
        : ['interpolate', ['linear'], ['zoom'],
           vis.min, 0, vis.min + 0.15, 1, vis.max - 0.15, 1, vis.max, 0];
      // Polygon fills are hard on/off at band edges — no zoom fades.
      // Window per band (on → off); continent fill disabled entirely.
      const FILL_WINDOW = {
        area: [10.5, 12.7],
        city: [9.3, 10.5],
        district: [6.5, 9.3],
        state: [3.0, 6.5],
        country: [0, 3.0],
        continent: null,
      };
      const LIVE_FILL = ['match', ['get', 'status'], 'unlocked', 0.7, 0];
      if (band === 'country') {
        // Live countries only (activated grey + edge-light, unlocked green
        // — unclaimed stays bare). Hard off at 3.0.
        map.addLayer({
          id: 'country-fill',
          type: 'fill',
          source: 'country-tiles',
          minzoom: 0,
          maxzoom: 3.0,
          paint: {
            'fill-color': TILE_FILL_COLOR,
            'fill-opacity': LIVE_FILL,
            'fill-outline-color': '#ffffff',
            'fill-opacity-transition': { duration: 300, delay: 0 },
          },
        });
        addBandEdgeLight('country-tiles', 0, 3.0);
      } else if (band === 'continent') {
        // Continent fill disabled entirely — no layer. (Labels still render.)
      } else {
        const [fillMin, fillMax] = FILL_WINDOW[band];
        map.addLayer({
          id: `${band}-fill`,
          type: 'fill',
          source: `${band}-tiles`,
          minzoom: fillMin,
          maxzoom: fillMax,
          paint: {
            'fill-color': TILE_FILL_COLOR,
            'fill-opacity': TILE_FILL_OPACITY,
            'fill-outline-color': '#ffffff',
            'fill-opacity-transition': { duration: 300, delay: 0 },
          },
        });
        addBandEdgeLight(`${band}-tiles`, fillMin, fillMax);
      }
      // Polygons carry no borders at any state — fills alone (plus labels)
      // distinguish unclaimed / activated / unlocked / mastered.
      map.addLayer({
        id: `${band}-labels`,
        type: 'symbol',
        source: `${band}-labels`,
        minzoom: vis.min,
        maxzoom: labelMax,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], vis.text[0], vis.text[1], vis.text[2], vis.text[3]],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': LABEL_COLOR,
          'text-opacity': labelOpacity,
          'text-opacity-transition': { duration: 300, delay: 0 },
          'text-halo-color': LABEL_HALO,
          'text-halo-width': 1.5,
        },
      });
    }
    // Our tile labels replace the basemap's: hide every base symbol layer.
    for (const l of map.getStyle().layers) {
      if (l.type === 'symbol' && !/^(area|district|city|state|country|continent)-labels$/.test(l.id)) {
        map.setLayoutProperty(l.id, 'visibility', 'none');
      }
    }

    // Activity pins: hidden unless a mastered tile is tapped. Same green as
    // the mastered border, pitch-aligned so they sit flat on the tilted map.
    map.addLayer({
      id: 'activity-pins',
      type: 'circle',
      source: 'activities',
      paint: {
        'circle-radius': 7,
        'circle-color': '#2ed67c',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
        'circle-pitch-alignment': 'map',
        'circle-opacity': 0,
        'circle-opacity-transition': { duration: 300, delay: 0 },
      },
    });
    map.addSource('objective-pins', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // Objective pins: exact blip locations dropped per objective.
    // Role colors: Main amber, Trail green, End red, Main+End red w/ amber core.
    map.addLayer({
      id: 'objective-pins',
      type: 'circle',
      source: 'objective-pins',
      paint: {
        'circle-radius': 8,
        'circle-color': [
          'match', ['get', 'role'],
          'main', '#e8a33d',
          'trail', '#2fbf71',
          'end', '#e53935',
          'main_end', '#e53935',
          '#e8a33d',
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
        'circle-pitch-alignment': 'map',
      },
    });
    // Combined Main+End dot: amber core over the red base (circles can't do
    // true half-half; the list badge carries the exact half-amber/half-red).
    map.addLayer({
      id: 'objective-pins-core',
      type: 'circle',
      source: 'objective-pins',
      filter: ['==', ['get', 'role'], 'main_end'],
      paint: {
        'circle-radius': 3.5,
        'circle-color': '#e8a33d',
        'circle-pitch-alignment': 'map',
      },
    });
    // Tortle POIs: business/amenity symbols filtered by live tile state.
    // Locked tiles contribute nothing (blank map underneath untouched);
    // unlocked renders full icon + dark label, activated renders the same
    // icon with a blue label to match the tile. Quest mode reads everything
    // unlocked. Source features come from the loaded vector tiles, so this
    // needs no new data plumbing — just a viewport/status-memoized refresh.
    map.addSource('poi-geo', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'poi-symbols',
      type: 'symbol',
      source: 'poi-geo',
      minzoom: 13,
      layout: {
        'icon-image': [
          'match',
          ['get', 'subclass'],
          'restaurant', 'restaurant_11',
          'cafe', 'cafe_11',
          'bar', 'bar_11',
          'pub', 'beer_11',
          'beer', 'beer_11',
          'nightclub', 'music_11',
          'resort', 'lodging_11',
          'hotel', 'lodging_11',
          'hostel', 'lodging_11',
          'motel', 'lodging_11',
          'guest_house', 'lodging_11',
          'museum', 'museum_11',
          'art_gallery', 'art_gallery_11',
          'gallery', 'art_gallery_11',
          'garden', 'garden_11',
          'park', 'park_11',
          'police', 'police_11',
          'stadium', 'stadium_11',
          'pitch', 'pitch_11',
          'swimming_pool', 'swimming_11',
          'swimming', 'swimming_11',
          'golf', 'golf_11',
          'tennis', 'tennis_11',
          'cricket', 'cricket_11',
          'fuel', 'fuel_11',
          'hospital', 'hospital_11',
          'pharmacy', 'pharmacy_11',
          'mall', 'shop_11',
          'bus_stop', 'bus_11',
          'bus_station', 'bus_11',
          'station', 'railway_11',
          'railway_station', 'railway_11',
          'halt', 'railway_11',
          'subway', 'railway_metro_11',
          'metro', 'railway_metro_11',
          'monument', 'monument_11',
          'attraction', 'attraction_11',
          'castle', 'castle_11',
          'historic', 'monument_11',
          'marker_11',
        ],
        'icon-size': 1,
        'text-anchor': 'top',
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-max-width': 8,
        'text-offset': [0, 0.6],
        'text-optional': true,
        'text-size': 12,
      },
      paint: {
        'text-color': ['match', ['get', 'st'], 'activated', '#2a69aa', '#3d4a57'],
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.2,
      },
    },
    'hex-fills');
    // Tap feedback: the tapped hex flashes white, then its edge echoes
    // outward and fades — the six-edge trace is what sells "tile". One
    // rAF timeline on single-feature sources; retaps restart it.
    map.addLayer({
      id: 'tap-flash',
      type: 'fill',
      source: 'tap-flash',
      paint: { 'fill-color': '#ffffff', 'fill-opacity': 0 },
    });
    map.addLayer({
      id: 'tap-ring',
      type: 'line',
      source: 'tap-ring',
      paint: {
        'line-color': '#cfeafb',
        'line-width': 2,
        'line-opacity': 0,
      },
    });
    let tapRaf = 0;
    const TAP_DUR = 650;
    // Tap flash is status-blind like selection: white on the regular map,
    // amber on the quest map. No green anywhere in either.
    function playTapTile(geometry, status) {
      let flash, ring;
      try {
        flash = map.getSource('tap-flash');
        ring = map.getSource('tap-ring');
        if (!flash || !ring) return;
      } catch { return; }
      const feat = { type: 'Feature', properties: {}, geometry };
      try {
        flash.setData({ type: 'FeatureCollection', features: [feat] });
        ring.setData({ type: 'FeatureCollection', features: [feat] });
        map.setPaintProperty('tap-flash', 'fill-color', questMode ? '#e8a33d' : '#ffffff');
        map.setPaintProperty('tap-ring', 'line-color', questMode ? '#f0c069' : '#cfeafb');
      } catch { return; }
      cancelAnimationFrame(tapRaf);
      const t0 = performance.now();
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / TAP_DUR);
        const ease = 1 - (1 - t) * (1 - t); // fast edge light, slow echo out
        try {
          map.setPaintProperty('tap-flash', 'fill-opacity', 0.45 * (1 - t));
          map.setPaintProperty('tap-ring', 'line-width', 2 + 7 * ease);
          map.setPaintProperty('tap-ring', 'line-opacity', 0.95 * (1 - t));
        } catch {}
        if (t < 1) {
          tapRaf = requestAnimationFrame(frame);
        } else {
          try {
            map.setPaintProperty('tap-flash', 'fill-opacity', 0);
            map.setPaintProperty('tap-ring', 'line-opacity', 0);
            flash.setData({ type: 'FeatureCollection', features: [] });
            ring.setData({ type: 'FeatureCollection', features: [] });
          } catch {}
        }
      };
      tapRaf = requestAnimationFrame(frame);
    }
    // Selected tile edge: steady static binding between the tapped tile
    // and its card (the fill below does the pulsing; this just holds).
    // Sits above every fill so it reads at all bands.
    // Filter-matched on the hex id — no geometry work per tap.
    map.addLayer({
      id: 'selected-outline',
      type: 'line',
      source: 'hex-fog',
      filter: ['==', ['get', 'h3'], ''],
      paint: {
        'line-color': '#ffffff',
        'line-width': 3,
        'line-opacity': 0.95,
      },
    });
    // Quest-tile pulse: permanent amber breathing over every live quest
    // cell (creator map). Same hex-fog source as selection — the filter is
    // the quest cell list, pushed from the quests cache (no geometry work).
    // Sits with selected-fill so the selected edge + mastered border draw
    // above it untouched.
    map.addLayer(
      {
        id: 'quest-tile-pulse',
        type: 'fill',
        source: 'hex-fog',
        filter: ['in', ['get', 'h3'], ['literal', []]],
        paint: {
          'fill-color': '#e8a33d',
          'fill-opacity': 0.12,
        },
      },
      'selected-outline',
    );
    // Quest-tile border: amber edge pulsing in sync with the fill.
    map.addLayer(
      {
        id: 'quest-tile-edge',
        type: 'line',
        source: 'hex-fog',
        filter: ['in', ['get', 'h3'], ['literal', []]],
        paint: {
          'line-color': '#e8a33d',
          'line-width': 2.5,
          'line-opacity': 0.8,
        },
      },
      'selected-outline',
    );
    // Selected tile fill: the looping pulse lives here (green for open
    // taps, white for active/locked). Sits above the base fills (and below
    // the selected edge + mastered border, which both draw on top untouched).
    map.addLayer(
      {
        id: 'selected-fill',
        type: 'fill',
        source: 'hex-fog',
        filter: ['==', ['get', 'h3'], ''],
        paint: {
          'fill-color': '#ffffff',
          'fill-opacity': 0,
        },
      },
      'selected-outline',
    );
    // (Pin opacity driver lives at createMap scope — see setPinsOpacity above.)

    // User-driven camera moves (pan/zoom/rotate) enter browse mode.
    // Programmatic moves carry no originalEvent, so follow never trips.
    map.on('movestart', (e) => {
      if (!e?.originalEvent) return;
      enterBrowse();
      onUserGesture?.();
    });
    // The puck is pointer-transparent, so dot taps arrive as map clicks:
    // anything within 18px of screen center belongs to the dot, not the tile.
    function isDotTap(event) {
      try {
        const p = event?.point;
        if (!p) return false;
        const c = map.getContainer();
        const dx = p.x - c.clientWidth / 2, dy = p.y - c.clientHeight / 2;
        return dx * dx + dy * dy <= 18 * 18;
      } catch { return false; }
    }
    map.on('click', 'hex-fills', (event) => {
      // Quest marking preempts selection at every band.
      if (markingMode) {
        const ll = event.lngLat;
        if (ll) onQuestMark?.({ lng: ll.lng, lat: ll.lat });
        return;
      }
      if (isDotTap(event)) { onUserDotTap?.(); return; }
      const feature = event.features?.[0];
      if (!feature) return;
      selectedCell = feature.properties.h3;
      // Tile feel: flash + echo ring + a 12ms haptic tick (Android only —
      // iOS Safari exposes no web haptics; the guard makes it a no-op).
      playTapTile(feature.geometry, feature.properties.status);
      try { navigator.vibrate?.(12); } catch {}
      onHexSelect?.(selectedCell, feature.properties.status);
    });

    map.on('mouseenter', 'hex-fills', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'hex-fills', () => {
      map.getCanvas().style.cursor = '';
    });

    for (const band of ['area', 'district', 'city', 'state', 'country', 'continent']) {
      map.on('click', `${band}-tiles`, (event) => {
        if (markingMode) {
          const ll = event.lngLat;
          if (ll) onQuestMark?.({ lng: ll.lng, lat: ll.lat });
          return;
        }
        if (isDotTap(event)) { onUserDotTap?.(); return; }
        const feature = event.features?.[0];
        if (!feature) return;
        onLevelSelect?.(band, feature.properties);
      });
      map.on('mouseenter', `${band}-tiles`, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', `${band}-tiles`, () => {
        map.getCanvas().style.cursor = '';
      });
    }

    let moveTimer = 0;
    const refreshViewport = () => {
      onMove?.({ zoom: map.getZoom(), cellCountHint: 1 });
    };
    map.on('moveend', () => {
      window.clearTimeout(moveTimer);
      moveTimer = window.setTimeout(refreshViewport, 80);
    });
    // Free zoom everywhere: tile appearance transitions at band edges via
    // layer min/maxzoom. No snapping — the camera stays where the user puts it.
    map.on('zoomend', refreshViewport);
    // Track gestures live: paints are rAF-coalesced and status-skipped, so
    // per-frame cost is one small polyfill (or a cache slice) at most.
    map.on('move', refreshViewport);
    // Diagnostic readouts for transient tuning (named pills).
    const zoomEl = document.getElementById('zoomLevel');
    const tiltEl = document.getElementById('tiltLevel');
    const refreshDiag = () => {
      if (zoomEl) zoomEl.textContent = `ZOOM ${map.getZoom().toFixed(2)}`;
      if (tiltEl) tiltEl.textContent = `TILT ${map.getPitch().toFixed(0)}°`;
    };
    map.on('move', refreshDiag);
    map.on('zoomend', refreshDiag);
    map.on('pitch', refreshDiag);
    map.on('rotate', refreshDiag);
    // Late vector tiles change the POI pool without moving the camera —
    // re-run the (memoized) paint so symbols arrive when their tiles do.
    map.on('sourcedata', (e) => {
      try {
        if (e?.sourceId === 'openmaptiles' && e?.isSourceLoaded && lastStoreRef) {
          schedulePaint(lastStoreRef);
        }
      } catch {}
    });
    refreshDiag();
  });

  return {
    map,
    async ready() {
      await (map.loaded() ? Promise.resolve() : new Promise((resolve) => map.once('load', resolve)));
      // Area pack powers street-level activation + borders; without it the
      // map still works (H3 + ladder fallback).
      try {
        await areas.loadCore();
      } catch {
        /* offline or missing pack — ladder fallback covers rendering */
      }
    },
    paint(store) {
      schedulePaint(store);
    },
    showTilePins(store, cell) {
      const pinsSource = map.getSource('activities');
      if (!pinsSource) return;
      window.clearTimeout(pinFadeTimer);
      // Pin every activity on the tile; activities missing coords (older
      // rows, sandbox touches) fall back to the hex center so the dots
      // still reveal instead of silently rendering nothing.
      let fallback = null;
      const acts = (store.activities || [])
        .filter((a) => a.cell === cell)
        .map((a) => {
          if (a.lat != null && a.lng != null) return a;
          fallback = fallback || cellCenter(cell);
          return { ...a, lat: fallback.lat, lng: fallback.lng };
        });
      pinsSource.setData(activityCollection(acts));
      setPinsOpacity(1, 300);
      pinFadeTimer = window.setTimeout(() => setPinsOpacity(0, 60000), 500);
    },
    hideTilePins() {
      const pinsSource = map.getSource('activities');
      if (!pinsSource) return;
      window.clearTimeout(pinFadeTimer);
      setPinsOpacity(0, 300);
    },
    // Quest-tile pulse: feed the live quest cell list (both maps —
    // quest map takes all live quests, explorer takes launched only).
    setQuestCells(cells) {
      questCellList = Array.isArray(cells) ? [...new Set(cells.filter(Boolean))] : [];
      applyQuestPulse();
    },
    // Objective pins: repaint the open quest's dropped blips (role-colored).
    showObjectivePins(points) {
      const src = map.getSource('objective-pins');
      if (!src) return;
      try {
        src.setData({
          type: 'FeatureCollection',
          features: (points || []).map((p) => ({
            type: 'Feature',
            properties: { role: p.role || 'trail' },
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          })),
        });
      } catch {}
    },
    // Quest-tile pulse: feed the live quest cell list (creator map).
    setQuestCells(cells) {
      questCellList = Array.isArray(cells) ? [...new Set(cells.filter(Boolean))] : [];
      applyQuestPulse();
    },
    // Marking mode: map taps report points instead of selecting tiles.
    setMarkingMode(on) {
      markingMode = !!on;
      try {
        map.getCanvas().style.cursor = markingMode ? 'crosshair' : '';
      } catch {}
    },
    // Quest mode: uniform unlocked street map + amber selection. Repaints
    // from the last store so the switch applies instantly.
    setQuestMode(on) {
      questMode = !!on;
      // Unlocked wash lives on the explorer map only — quest mode reports
      // every tile unlocked, so it keeps the clear treatment there.
      try {
        if (map.getLayer('hex-fills')) {
          map.setPaintProperty('hex-fills', 'fill-color', [
            'match', ['get', 'status'],
            'unlocked', questMode ? 'rgba(0,0,0,0)' : '#4ea7da',
            'mastered', 'rgba(0,0,0,0)',
            'activated', '#4ea7da',
            '#1d242e',
          ]);
          map.setPaintProperty('hex-fills', 'fill-opacity', [
            'match', ['get', 'status'],
            'unlocked', questMode ? 0 : 0.2,
            'mastered', 0,
            'activated', 0.65,
            0.62,
          ]);
        }
      } catch {}
      applyQuestPulse();
      if (lastStoreRef) schedulePaint(lastStoreRef);
    },
    setSelected(cell, status = null) {
      selectedCell = cell;
      try {
        // Selection is status-blind: steady white edge + white pulse fill
        // for every tile on the regular map (amber rules quest mode).
        if (map.getLayer('selected-outline')) {
          map.setFilter('selected-outline', ['==', ['get', 'h3'], cell || '']);
          map.setPaintProperty('selected-outline', 'line-color', questMode ? '#e8a33d' : '#ffffff');
          map.setPaintProperty('selected-outline', 'line-width', 3);
          map.setPaintProperty('selected-outline', 'line-opacity', 0.95);
        }
        if (map.getLayer('selected-fill')) {
          map.setFilter('selected-fill', ['==', ['get', 'h3'], cell || '']);
          map.setPaintProperty('selected-fill', 'fill-color', questMode ? '#e8a33d' : '#ffffff');
        }
      } catch {}
      // Start the loop on first selection; every later tap just retargets it.
      if (cell && !pulseTimer) pulseTimer = window.setInterval(pulseTick, 120);
    },
    setUserLocation(lng, lat, { fly = false } = {}) {
      userLngLat = [lng, lat];
      if (fly) {
        following = true;
        setPuckDimmed(false);
        map.easeTo({ center: userLngLat, zoom: Math.max(map.getZoom(), 14), duration: 700 });
      } else if (following) {
        map.jumpTo({ center: userLngLat });
      }
      // Browse mode: logical position updates, camera stays (no fight).
    },
    isFollowing() {
      return following;
    },
    setFollowing(on) {
      following = !!on;
      if (following) setPuckDimmed(false);
    },
    setPuckDimmed(dimmed) {
      setPuckDimmed(dimmed);
    },
    // Attention-loop animation hooks: '' clears, 'bouncing'/'pulsing' play.
    setPuckAnim(name) {
      puck.classList.remove('bouncing', 'pulsing');
      if (name) puck.classList.add(name);
    },

    getUserLocation() {
      if (!userLngLat) return null;
      return { lng: userLngLat[0], lat: userLngLat[1] };
    },
    cellUnderUser() {
      if (!userLngLat) return null;
      return cellAt(userLngLat[1], userLngLat[0]);
    },
    recenter(target = userLngLat) {
      if (!target) return;
      const to = Array.isArray(target) ? target : [target.lng, target.lat];
      following = true;
      setPuckDimmed(false);
      map.easeTo({ center: to, zoom: Math.max(map.getZoom(), CONFIG.defaultZoom), duration: 750 });
    },
    currentCellCenter(cell) {
      return cellCenter(cell);
    },
    inspectCell(store, cell) {
      if (cellResolution(cell) === CONFIG.h3Resolution) {
        const rec = store.tiles[cell];
        const neighborSet = unlockedNeighborSet(store);
        // Per-hex truth only: a tile is unlocked by its own progress,
        // activated as a 1-ring neighbor of an opened tile, else locked.
        // Area membership never promotes a hex — the Area tile itself
        // activates via the rollup when a member opens.
        const status = tileStatus(cell, store, neighborSet);
        return {
          cell,
          status,
          rec,
          unlocked: isUnlocked(rec),
          center: cellCenter(cell),
        };
      }
      // Coarse fog cell tapped while zoomed out: aggregate from the res-9 store.
      const { unlocked, touched } = coarseStatusMaps(store, cellResolution(cell));
      const status = unlocked.has(cell) ? 'unlocked' : touched.has(cell) ? 'activated' : 'unclaimed';
      return { cell, status, rec: store.tiles[cell], unlocked: status === 'unlocked', center: cellCenter(cell) };
    },
  };
}
