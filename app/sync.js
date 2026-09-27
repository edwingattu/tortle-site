import { supabase } from './auth.js';
import { CONFIG } from './config.js';
import { buildAreaHexes, getPack, getRegion, getRollup } from './areas.js';
import { myRole } from './roles.js';

// Cloud sync: offline-first, delta-additive merge.
// - localStorage stays the fast local cache; Supabase is source of truth.
// - Pushes carry time DELTAS (never absolute totals) via the
//   apply_tile_deltas RPC, so two devices add up instead of overwriting.
// - Pulls happen on launch; pushes flush every syncIntervalMs + on hide.
// - Every failure is silent-local: the outbox survives in localStorage and
//   retries on the next flush. The map never blocks on the network.

async function currentUserId() {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.warn('[sync] getUser failed:', error.message);
      return null;
    }
    return data.user?.id ?? null;
  } catch (err) {
    console.warn('[sync] getUser threw:', err?.message || err);
    return null;
  }
}

/** Launch pull: tiles + activities + profile merged into the local store. */
export async function pullAll(engine) {
  const uid = await currentUserId();
  if (!uid) {
    console.warn('[sync] pull skipped: no user');
    return false;
  }
  const [tiles, acts, prof] = await Promise.all([
    supabase.from('tile_progress').select('*').eq('user_id', uid),
    supabase.from('activities').select('*').eq('user_id', uid).order('created_at'),
    supabase.from('tortle_profiles').select('*').eq('user_id', uid).limit(1),
  ]);
  if (tiles.error || acts.error || prof.error) {
    console.warn('[sync] pull failed:', tiles.error?.message, acts.error?.message, prof.error?.message);
    return false;
  }
  engine.applyServerTiles(tiles.data || []);
  engine.mergeActivities(acts.data || []);
  // Diagnostic footprint: what the cloud profile claimed (base fills local
  // only when local never located — see adoptProfile). Readable via
  // window.__tortlePull / the area-name tap toast.
  try {
    const prow = prof.data?.[0] || null;
    const adopted = prow ? engine.adoptProfile(prow) : false;
    window.__tortlePull = {
      at: new Date().toISOString(),
      cloudBase: prow?.base_cell ? String(prow.base_cell).slice(0, 8) : null,
      adoptedBase: !!adopted,
    };
  } catch {
    if (prof.data?.[0]) engine.adoptProfile(prof.data[0]);
  }
  console.log(
    `[sync] pull ok: ${tiles.data?.length || 0} tiles, ${acts.data?.length || 0} activities, profile ${prof.data?.[0] ? 'found' : 'none'}`,
  );
  return true;
}

let flushing = false;

/** Push everything pending: tile deltas, new activities, profile + outing. */
export async function flush(engine) {
  if (flushing) return false;
  const uid = await currentUserId();
  if (!uid) return false;
  flushing = true;
  try {
    const snap = engine.getSnapshot();

    // 1. Tile deltas (batched; leftovers stay pending for next flush).
    const pending = engine.getPending();
    const cells = Object.keys(pending);
    if (cells.length) {
      const batch = cells.slice(0, CONFIG.syncBatchCells);
      const deltas = batch.map((cell) => {
        const rec = snap.store.tiles[cell] || {};
        // Dwell ticks are fractional ms (performance.now diffs); the
        // columns are bigint, so round — sub-ms precision is meaningless.
        return {
          h3_cell: cell,
          dwell_ms: Math.round(pending[cell].dwell || 0),
          boost_ms: Math.round(pending[cell].boost || 0),
          first_seen_at: rec.firstSeenAt ? new Date(rec.firstSeenAt).toISOString() : null,
          unlocked_at: rec.unlockedAt ? new Date(rec.unlockedAt).toISOString() : null,
        };
      });
      const { error } = await supabase.rpc('apply_tile_deltas', { deltas });
      if (error) throw error;
      const sent = {};
      batch.forEach((cell, i) => {
        sent[cell] = { dwell: deltas[i].dwell_ms, boost: deltas[i].boost_ms };
      });
      engine.markPushed(batch, sent);
    }

    // 2. Activities since cursor (upsert by id: retries are idempotent).
    // Sandbox-tagged activities never leave the device.
    const cursor = snap.store.activityCursor;
    const fresh = snap.store.activities.filter(
      (a) => !a.sandbox && (!cursor || new Date(a.createdAt).toISOString() > cursor),
    );
    if (fresh.length) {
      const rows = fresh.map((a) => ({
        id: a.id,
        user_id: uid,
        title: a.title,
        category: a.category,
        capture_type: a.captureType,
        lat: a.lat,
        lng: a.lng,
        h3_cell: a.cell,
        tiles: a.tiles || [],
        media_url: a.media_url || null,
        media_type: a.captureType || null,
        media_path: a.media_path || null,
        created_at: new Date(a.createdAt).toISOString(),
      }));
      const { error } = await supabase.from('activities').upsert(rows, { onConflict: 'id' });
      if (error) throw error;
      const newest = Math.max(...fresh.map((a) => a.createdAt));
      engine.setActivityCursor(new Date(newest).toISOString());
    }

    // Media backfill: activities already flushed before their upload finished
    // get their media_url patched (partial upsert by id).
    const withMedia = snap.store.activities.filter((a) => !a.sandbox && (a.media_url || a.media_path));
    if (withMedia.length) {
      const rows = withMedia.map((a) => ({
        id: a.id,
        user_id: uid,
        media_url: a.media_url,
        media_type: a.captureType || null,
        media_path: a.media_path || null,
      }));
      const { error } = await supabase.from('activities').upsert(rows, { onConflict: 'id' });
      if (error) console.warn('[sync] media backfill failed:', error.message);
    }

    // 2b. Pending deletes: drop server rows + private-storage objects.
    // Tombstones stay local so pulls never resurrect them. Idempotent:
    // re-running after a partial success is a harmless no-op.
    const pendingDeletes = snap.store.pendingDeletes || [];
    if (pendingDeletes.length) {
      const ids = pendingDeletes.map((d) => d.id);
      const paths = pendingDeletes.map((d) => d.path).filter(Boolean);
      if (paths.length) {
        const { error } = await supabase.storage.from('tortle-media').remove(paths);
        if (error) console.warn('[sync] media delete failed:', error.message);
      }
      const { error } = await supabase.from('activities').delete().in('id', ids);
      if (error) throw error;
      engine.clearPendingDeletes(); // clears + persists via emit
    }

    // 3. Profile: base, streak, and the live outing (mid-outing sync rides
    // here — every flush carries the current touched list).
    const outing = snap.store.outing;
    const { error: profileError } = await supabase.from('tortle_profiles').upsert(
      {
        user_id: uid,
        base_cell: snap.store.baseCell,
        streak_days: snap.store.streakDays,
        last_active_date: snap.store.lastActiveDate,
        current_outing: outing
          ? { startedAt: outing.startedAt, lastTouchAt: outing.lastTouchAt, touched: outing.touched }
          : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    if (profileError) throw profileError;
    console.log(
      `[sync] flush ok: ${cells.length} pending cells, ${fresh.length} activities, profile upserted`,
    );
    return true;
  } catch (err) {
    console.warn('[sync] flush failed:', err?.message || err);
    return false;
  } finally {
    flushing = false;
  }
}

// First-sync migration: pre-cloud local totals become one additive seed.
// Overwrites (not adds to) any pending entries, since those touches are
// already inside the totals. Runs once, then cloudLinked persists.
function seedMigration(engine) {
  const snap = engine.getSnapshot();
  if (snap.store.cloudLinked) return;
  for (const [cell, rec] of Object.entries(snap.store.tiles)) {
    snap.store.pending[cell] = { dwell: rec.dwellMs || 0, boost: rec.boostMs || 0 };
  }
  snap.store.cloudLinked = true;
  engine.markPushed([]); // persist seed + flag
}

/** Launch sequence: roll back any sandbox gains (never seedable/uploadable),
 * seed local history, push it up, then pull canonical state. */
export async function bootstrap(engine) {
  try {
    console.log('[sync] bootstrap start');
    engine.rollbackSandbox();
    seedMigration(engine);
    await flush(engine);
    await pullAll(engine);
    console.log('[sync] bootstrap done');
    return true;
  } catch (err) {
    console.warn('[sync] bootstrap failed:', err?.message || err);
    return false;
  }
}

// Dev hook: window.__tortleSync.flush() / .pullAll() / .engine from console.
export function exposeDebug(target, engine) {
  try {
      target.__tortleSync = {
      flush: () => flush(engine),
      pullAll: () => pullAll(engine),
      pending: () => engine.getPending(),
      store: () => engine.getSnapshot().store,
      role: () => myRole(),
      // Truth-teller for "tiles not lighting up": pack loadout + status
      // distribution per level + every non-unclaimed tile by name.
      diag: () => {
        buildAreaHexes();
        const snap = engine.getSnapshot();
        const { areaStats, rollup } = getRollup(snap.store);
        const dist = (m) => {
          const o = {};
          for (const s of m.values()) o[s.status] = (o[s.status] || 0) + 1;
          return o;
        };
        const live = (items, stats) =>
          (items || [])
            .filter((it) => (stats.get(it.id)?.status || 'unclaimed') !== 'unclaimed')
            .map((it) => `${it.name}:${stats.get(it.id).status}`);
        return {
          region: getRegion(),
          packs: {
            areas: getPack('areas')?.length || 0,
            districts: getPack('districts')?.length || 0,
            states: getPack('states')?.length || 0,
            countries: getPack('countries')?.length || 0,
          },
          hexes: Object.keys(snap.store.tiles).length,
          areaStats: dist(areaStats),
          city: rollup.city,
          liveAreas: live(getPack('areas'), areaStats).slice(0, 12),
          liveDistricts: live(getPack('districts'), rollup.districts).slice(0, 12),
          liveStates: live(getPack('states'), rollup.states),
          liveCountries: live(getPack('countries'), rollup.countries),
        };
      },
    };
  } catch {
    /* non-browser */
  }
}
