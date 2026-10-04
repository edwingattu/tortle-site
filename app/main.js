import { CONFIG } from './config.js';
import { getSession, requireSessionOrRedirect, signOut } from './auth.js';
import {
  cellAt,
  cellCenter,
  createEngine,
  isUnlocked,
  progressPercent,
  remainingMs,
} from './engine.js';
import { createMap } from './map.js';
import { bootstrap, exposeDebug, flush } from './sync.js';
import { setupJoystick } from './joystick.js';
import { regionCenter, regionCredit, regionForPoint, savedRegion, setRegion } from './areas.js';
import * as areasDbg from './areas.js';
import { isAdmin, isSuperadmin } from './roles.js';
import { createQuest, fetchRegionQuests, questsForCell, questById, updateQuestStatus, updateQuestTitle, deleteQuest, fetchObjectives, createObjective, updateObjective, deleteObjective, currentObjectiveId, setCurrentObjectiveId } from './quests.js';
import { compressPhoto, flushMediaOutbox, hasMedia, mediaOutbox, pathFromActivity, pickAudioMime, pickPhotoMime, pickVideoMime, signedUrl, uploadMedia } from './media.js';

const $ = (sel) => document.querySelector(sel);

// PWA: register shell SW (network-first for HTML, offline fallback). nosw=1 bypasses for dev.
if ('serviceWorker' in navigator && !new URLSearchParams(window.location.search).has('nosw')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Auth gate: unauthenticated visitors go to auth.html (Google + magic link).
// Throws/redirects when signed out, so nothing below runs without a user.
const session = await requireSessionOrRedirect();
const currentUser = session.user;

// Role gate: sandbox + zoom for admin+, tilt for superadmin only.
const adminUser = await isAdmin();
const superadminUser = await isSuperadmin();
if (!adminUser) {
  $('#joystickButton')?.remove();
  $('#zoomLevel')?.remove();
  $('#tiltLevel')?.remove();
} else if (!superadminUser) {
  $('#tiltLevel')?.remove();
}

const engine = createEngine(currentUser?.id || null);
// Debug hook early: available even while auth/map/sync are still loading.
exposeDebug(window, engine);
const mapView = createMap({
  // User taps pin the selection: GPS fixes must not yank the card back.
  // Tapping the live tile itself unpins (resume follow).
  onHexSelect: (cell) => {
    selectionPinned = cell !== lastLiveCell;
    selectCell(cell, { toastOnSelect: true, src: 'tap' });
  },
  // Every map gesture restarts the dot attention clock (browse mode only —
  // the map already dropped out of follow before this fires).
  onUserGesture: () => {
    interruptDotSequence(false);
    try { if (mapView && !mapView.isFollowing()) scheduleDotAttention(); } catch {}
  },
  // Dot tap centers the live location (same as recenter, silent).
  onUserDotTap: () => {
    interruptDotSequence(true);
    mapView.recenter();
    selectionPinned = false;
    try { selectCell(mapView.cellUnderUser(), { src: 'dottap' }); } catch {}
  },
  // Quest framework: marker taps toast (detail UI comes with the builder).
  onQuestSelect: (props) => {
    toast(props?.title || 'Quest');
  },
  onMove: () => {
    mapView.paint(engine.getSnapshot().store);
    try {
      layoutQuestCreate();
    } catch {}
  },
  onLevelSelect: (band, props) => {
    const detail = props.status === 'unclaimed' ? '' : ` · ${props.frac}% explored`;
    toast(`${props.name} · ${props.status}${detail}`);
  },
});

const locationFilter = {
  samples: [],
  // No silent seed: the first real fix anchors it. Weak fixes before that
  // are dropped instead of rolling back onto a street never stood on.
  lastGood: null,
  frozen: false,
};

let tracking = false;
let watchId = null;
let selectedCell = engine.getSnapshot().store.baseCell;
// Pinned selection: a user tap sticks until they tap the live tile, hit
// recenter, or physically move (live cell stable across 3 fixes — kills GPS
// jitter unpinning a pinned card while standing still).
let selectionPinned = false;
let lastLiveCell = null;
let liveCandidate = null;
// Selection trail (last 10): who set the card's tile and why. Readable via
// window.__tortleSel when the card ever looks wrong.
const selTrail = [];
function noteSel(source, cell) {
  selTrail.push({
    t: new Date().toISOString().slice(11, 19),
    source,
    cell: cell ? cell.slice(0, 8) : null,
    pinned: selectionPinned,
  });
  if (selTrail.length > 10) selTrail.shift();
  try { window.__tortleSel = selTrail.slice(); } catch {}
}
let liveCandidateHits = 0;
let captureType = 'photo';
let selectedCategory = 'dining';
let placeCache = new Map();
let lastDwellAt = performance.now();

function toast(message) {
  // Muted per request — keep console for debugging, no navy pill
  console.log('[toast muted]', message);
  return;
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.remove('visible'), 2800);
}
// Diagnostic toast: ALWAYS visible (normal toasts are muted) and sticky
// until tapped — PWA has no console, so this is the readable surface.
function toastDiag(message) {
  console.log('[diag]', message);
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(window.toastTimer);
}

function smoothFix(coords) {
  if (typeof coords.speed === 'number' && coords.speed > CONFIG.implausibleSpeedMps) return null;
  if (coords.accuracy > CONFIG.weakAccuracyM) {
    locationFilter.frozen = true;
    if (!locationFilter.lastGood) return null;
    return { ...locationFilter.lastGood, weak: true };
  }
  locationFilter.frozen = false;
  locationFilter.samples.push({ lat: coords.latitude, lng: coords.longitude, t: Date.now() });
  if (locationFilter.samples.length > CONFIG.smoothWindow) locationFilter.samples.shift();
  const lat =
    locationFilter.samples.reduce((sum, s) => sum + s.lat, 0) / locationFilter.samples.length;
  const lng =
    locationFilter.samples.reduce((sum, s) => sum + s.lng, 0) / locationFilter.samples.length;
  locationFilter.lastGood = { lat, lng };
  return { lat, lng, weak: false };
}

// Summary card helpers: tile info row, state pill, live mm:ss countdown.

function formatCountdown(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateCityTitle() {
  const el = $('#cityTitle');
  if (!el) return;
  // My City — word City replaced by the actual city name the user is in.
  const label = areasDbg.regionLabel();
  el.textContent = `My ${label}`;
}

function updateAreaName(cell = selectedCell) {
  const el = $('#areaName');
  const hexEl = $('#hexLine');
  if (!el) return;
  // Gated (no location yet): never name the default Ramgopalpet tile.
  if (gateOpen) {
    el.textContent = 'Choose your city to begin';
    if (hexEl) hexEl.textContent = 'Waiting for location';
    return;
  }
  let lat, lng, id;
  if (cell) {
    const c = cellCenter(cell);
    lat = c.lat; lng = c.lng; id = cell;
  } else if (mapView) {
    const p = mapView.getUserLocation();
    if (!p) {
      el.textContent = 'Locating…';
      if (hexEl) hexEl.textContent = 'H3 · —';
      return;
    }
    lat = p.lat; lng = p.lng; id = cellAt(lat, lng);
  } else {
    el.textContent = 'Locating…';
    if (hexEl) hexEl.textContent = 'H3 · —';
    return;
  }
  const area = areasDbg.areaAt(lng, lat) || areasDbg.districtAt(lng, lat);
  el.textContent = area ? area.name : 'Outside mapped areas';
  if (hexEl) hexEl.textContent = `H3 · ${id}`;
}

function updateCountdown(rec, status) {
  const row = $('#countdownRow');
  const textEl = $('#countdownText');
  const track = $('#tileProgressTrack');
  const bar = $('#tileProgressBar');
  const pill = $('#tileStatePill');
  if (!textEl || !bar) return;
  // Gated (no location yet): neutral row, no default-tile countdown.
  if (gateOpen) {
    textEl.textContent = 'Share your location to begin';
    bar.style.width = '0%';
    if (track) { track.classList.remove('unlocked'); track.hidden = false; }
    if (row) { row.classList.remove('unlocked'); row.hidden = false; }
    if (pill) pill.hidden = true;
    return;
  }
  if (questMode) {
    // Quest tile states read quest rows only: Empty / Generating / Quests: N.
    // Nothing here feeds from the regular map.
    const qs = questsForCell(selectedCell);
    const card = $('#bottomCard');
    const expanded = !!card?.classList.contains('expanded');
    if (pill) {
      pill.hidden = false;
      if (qs.length) {
        pill.textContent = `Quests: ${qs.length}`;
        pill.className = 'tile-state-pill is-quests';
      } else if (expanded && selectedCell) {
        pill.textContent = 'Generating';
        pill.className = 'tile-state-pill is-active';
      } else {
        pill.textContent = 'Empty';
        pill.className = 'tile-state-pill is-locked';
      }
    }
    if (row) row.hidden = true;
    if (track) track.hidden = true;
    return;
  }
  const open = status === 'unlocked' || status === 'mastered' || isUnlocked(rec);
  if (open) {
    // Open tiles: the pill is the whole story — countdown + bar hide.
    if (pill) { pill.hidden = false; pill.textContent = 'Unlocked'; pill.className = 'tile-state-pill is-open'; }
    if (row) row.hidden = true;
    if (track) track.hidden = true;
    return;
  }
  if (row) { row.classList.remove('unlocked'); row.hidden = false; }
  if (track) { track.classList.remove('unlocked'); track.hidden = false; }
  if (status === 'activated') {
    if (pill) { pill.hidden = false; pill.textContent = 'Active'; pill.className = 'tile-state-pill is-active'; }
    const left = remainingMs(rec);
    const mmss = formatCountdown(left);
    textEl.innerHTML = `This Tile Will Open in <b id="countdown">${mmss}</b>`;
  } else {
    if (pill) { pill.hidden = false; pill.textContent = 'Locked'; pill.className = 'tile-state-pill is-locked'; }
    textEl.textContent = 'Pass Through this Tile to Activate it';
  }
  const pct = progressPercent(rec);
  bar.style.width = `${pct}%`;
}

// Tile naming: view mode (title + Edit Title) vs edit mode (field + Save).
// The field follows the selected tile, never the 1s HUD refresh: while the
// user is typing, nothing yanks mode or text.
let lastTitleCell = undefined;
function showTitleView(name) {
  const input = $('#tileTitleInput');
  const display = $('#tileTitleDisplay');
  const message = $('#tileTitleMessage');
  const btn = $('#tileTitleSave');
  if (input) input.hidden = true;
  if (message) message.hidden = true;
  if (display) { display.hidden = false; display.textContent = name || ''; }
  if (btn) { btn.hidden = false; btn.textContent = 'Edit'; btn.classList.add('is-edit'); }
}
function showTitleEdit(preset) {
  const input = $('#tileTitleInput');
  const display = $('#tileTitleDisplay');
  const message = $('#tileTitleMessage');
  const btn = $('#tileTitleSave');
  if (display) display.hidden = true;
  if (message) message.hidden = true;
  if (input) {
    input.hidden = false;
    if (preset !== null && preset !== undefined) input.value = preset;
  }
  if (btn) { btn.hidden = false; btn.textContent = 'Save'; btn.classList.remove('is-edit'); }
}
function showTitleMessage(text) {
  const input = $('#tileTitleInput');
  const display = $('#tileTitleDisplay');
  const message = $('#tileTitleMessage');
  const btn = $('#tileTitleSave');
  if (input) input.hidden = true;
  if (display) display.hidden = true;
  if (message) { message.hidden = false; message.textContent = text; }
  if (btn) btn.hidden = true;
}
function renderTitleField(name, status) {
  const input = $('#tileTitleInput');
  if (!input) return;
  // Quest mode: the summary field is retired — creation lives in the open
  // quest row. Collapsed and expanded alike show info + status only here.
  if (questMode) {
    lastTitleCell = selectedCell;
    if (document.activeElement === input) input.blur();
    input.hidden = true;
    const save = $('#tileTitleSave');
    if (save) save.hidden = true;
    const display = $('#tileTitleDisplay');
    if (display) display.hidden = true;
    const message = $('#tileTitleMessage');
    if (message) message.hidden = true;
    return;
  }
  const switched = selectedCell !== lastTitleCell;
  if (switched) {
    // New tile: drop any in-progress edit and render its truth.
    lastTitleCell = selectedCell;
    if (document.activeElement === input) input.blur();
  } else if (document.activeElement === input) {
    return; // mid-typing on the same tile — never yank
  }
  const open = status === 'unlocked' || status === 'mastered';
  if (!open) {
    showTitleMessage(status === 'activated' ? "It's just a matter of Time.." : 'Activate Me..');
    return;
  }
  if (name) showTitleView(name);
  else showTitleEdit(switched ? '' : null);
}

// Per-tile media gallery: module scope so renderHud/selectCell can refresh it
// on every tile change (bindUi-local defs are invisible here).
let viewerItems = [];
let viewerIndex = 0;
let navTimer = 0;
// While the voice recorder is open the gallery stays hidden (returns on save/close)
let voiceCaptureOpen = false;
// Assigned in bindUi: closes the floating recorder with full cleanup.
let closeVoiceFn = null;
// Assigned in bindUi: closes the recorder, reports whether audio existed.
let dismissVoiceCapture = null;
const VOICE_SVG = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';
function mediaKind(a, url) {
  if (a.captureType === 'video') return 'video';
  if (a.captureType === 'voice') return 'audio';
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['m4a', 'mp3', 'wav', 'ogg', 'aac', 'opus'].includes(ext)) return 'audio';
  return 'image';
}
function pokeNav() {
  const multi = viewerItems.length > 1;
  const prev = $('#viewerPrev'), next = $('#viewerNext');
  if (!multi) { if (prev) prev.hidden = true; if (next) next.hidden = true; return; }
  if (prev) prev.hidden = false;
  if (next) next.hidden = false;
  clearTimeout(navTimer);
  navTimer = setTimeout(() => { if (prev) prev.hidden = true; if (next) next.hidden = true; }, 1000);
}
function hideNavNow() {
  clearTimeout(navTimer);
  const prev = $('#viewerPrev'), next = $('#viewerNext');
  if (prev) prev.hidden = true;
  if (next) next.hidden = true;
}
function fmtClock(s) {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function resetViewerAudioUi() {
  stopPlayhead();
  vBars.forEach((b) => b.classList.remove('played'));
  const fill = $('#viewerAudioFill'), t = $('#viewerAudioRemain');
  if (fill) fill.style.width = '0%';
  if (t) t.textContent = '0:00';
}
// Waveform: decode peaks once (truthful static wave) + clock-driven playhead.
// No live analyser graph for playback — it fails silently on some devices.
let decodeCtx = null;
function getDecodeCtx() {
  if (!decodeCtx) decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (decodeCtx.state === 'suspended') decodeCtx.resume().catch(() => {});
  return decodeCtx;
}
async function decodePeaks(source, n) {
  try {
    const buf = source instanceof Blob ? await source.arrayBuffer() : await (await fetch(source)).arrayBuffer();
    const audio = await getDecodeCtx().decodeAudioData(buf.slice(0));
    const ch = audio.getChannelData(0);
    const peaks = new Array(n).fill(0.08);
    const step = Math.max(1, Math.floor(ch.length / n));
    for (let i = 0; i < n; i++) {
      let m = 0;
      const start = i * step;
      for (let j = start; j < Math.min(start + step, ch.length); j += 7) {
        const v = Math.abs(ch[j]);
        if (v > m) m = v;
      }
      peaks[i] = Math.max(0.08, Math.min(1, m));
    }
    return peaks;
  } catch {
    return null;
  }
}
function paintPeaks(bars, peaks, maxPx) {
  for (let i = 0; i < bars.length; i++) {
    const p = peaks ? peaks[Math.min(i, peaks.length - 1)] : 0.3;
    bars[i].style.height = `${Math.max(3, Math.round(p * maxPx))}px`;
    bars[i].classList.remove('played');
  }
}
let playheadRaf = 0;
function stopPlayhead() {
  cancelAnimationFrame(playheadRaf);
  playheadRaf = 0;
}
function startPlayhead(audioEl, bars) {
  stopPlayhead();
  const tick = () => {
    if (audioEl.paused) return;
    if (audioEl.duration) {
      const p = audioEl.currentTime / audioEl.duration;
      for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('played', i / bars.length <= p);
    }
    playheadRaf = requestAnimationFrame(tick);
  };
  tick();
}
// Viewer waveform plumbing (module scope — survives tile switches)
let vBars = [];
function buildViewerBars() {
  const wave = $('#viewerAudioWave');
  const remain = $('#viewerAudioRemain');
  if (!wave) return;
  wave.innerHTML = '';
  if (remain) wave.appendChild(remain);
  vBars = [];
  const w = wave.clientWidth || 280;
  const n = Math.max(16, Math.floor(w / 5));
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'bar';
    wave.insertBefore(s, remain);
    vBars.push(s);
  }
}

// Custom video chrome: center cluster (±10s + play), seek ~26% from the
// bottom, vertical volume at the right edge. Fades 2s after play starts;
// tap on empty video toggles it back. Pause/end always reveal.
const V_PLAY_SVG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg>';
const V_PAUSE_SVG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
let vChromeTimer = 0;
function videoWrapEl() { return $('#viewerVideoWrap'); }
function videoChromeVisible() { return !!videoWrapEl()?.classList.contains('visible'); }
function showVideoChrome() {
  const w = videoWrapEl();
  if (!w) return;
  w.classList.add('visible');
  clearTimeout(vChromeTimer);
  vChromeTimer = setTimeout(() => {
    const v = $('#viewerVideo');
    if (v && !v.paused && !v.ended) w.classList.remove('visible');
  }, 2000);
}
function setVPlayIcon(playing) {
  const b = $('#vPlay');
  if (b) b.innerHTML = playing ? V_PAUSE_SVG : V_PLAY_SVG;
}

function showViewerIndex(i) {
  if (!viewerItems.length) return;
  viewerIndex = (i + viewerItems.length) % viewerItems.length;
  const { url, kind } = viewerItems[viewerIndex];
  const img = $('#viewerImg'), vid = $('#viewerVideo'), vWrap = $('#viewerVideoWrap'), wrap = $('#viewerAudioWrap'), aud = $('#viewerAudio');
  img.hidden = true; if (vWrap) vWrap.hidden = true; wrap.hidden = true;
  try { vid.pause?.(); } catch {}
  try { aud.pause?.(); } catch {}
  resetViewerAudioUi();
  if (kind === 'video') {
    vid.src = url;
    const seek = $('#vSeek'), cur = $('#vCur'), dur = $('#vDur');
    if (seek) seek.value = '0';
    if (cur) cur.textContent = '0:00';
    if (dur) dur.textContent = '0:00';
    setVPlayIcon(false);
    if (vWrap) vWrap.hidden = false;
    showVideoChrome();
  }
  else if (kind === 'audio') {
    aud.src = url;
    wrap.hidden = false;
    buildViewerBars();
    paintPeaks(vBars, null, 60);
    aud.onloadedmetadata = () => {
      const r = $('#viewerAudioRemain');
      if (r && aud.duration) r.textContent = fmtClock(aud.duration);
    };
    // Decode true peaks in background; repaints when ready
    decodePeaks(url, vBars.length).then((peaks) => {
      if (peaks && aud.src === url) paintPeaks(vBars, peaks, 60);
    });
  }
  else { img.src = url; img.hidden = false; }
  // Arrows flash for 1s; tap media to bring back
  pokeNav();
}
function openViewer(url) {
  const dlg = $('#mediaViewer');
  if (!dlg) return;
  const idx = viewerItems.findIndex((it) => it.url === url);
  if (!dlg.open) { try { dlg.showModal(); } catch {} }
  showViewerIndex(idx >= 0 ? idx : 0);
}

// Gallery select + delete: per-item × (two-tap) plus a Select mode with a
// Delete (n) bar (two-tap). Deletes tombstone server-side via sync.
let galleryToken = 0;
let gallerySelectMode = false;
const gallerySelected = new Set();
let gallerySig = null; // null = must rebuild ('' is a valid empty-tile signature)
let galleryBuiltAt = 0;
let deleteArmTimer = 0;
const PLAY_BADGE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M7 4l13 8-13 8z"/></svg>';
// Media failure trace: every unloadable item lands here with its requested
// path. Read via console, or quote the sticky area-name toast which now
// includes the failure count. Compare paths against Storage dashboard keys.
const mediaErrors = [];
function noteMediaError(id, path, stage) {
  mediaErrors.push({ t: new Date().toISOString().slice(11, 19), id: String(id || '').slice(0, 8), path, stage });
  if (mediaErrors.length > 20) mediaErrors.shift();
  try { window.__tortleMediaErrors = mediaErrors.slice(); } catch {}
  console.warn('[media] unloadable:', stage, path);
}

function exitGallerySelect() {
  gallerySelectMode = false;
  gallerySelected.clear();
  disarmDeleteConfirm();
  const bar = $('#galleryDeleteBar');
  if (bar) bar.hidden = true;
}

function updateGalleryChrome(n) {
  const bar = $('#galleryBar');
  if (bar) bar.hidden = n === 0 && !gallerySelectMode;
  const count = $('#galleryCount');
  if (count) count.textContent = `${n} memor${n === 1 ? 'y' : 'ies'}`;
  const sel = $('#gallerySelect');
  if (sel) sel.textContent = gallerySelectMode ? 'Done' : 'Select';
  const del = $('#galleryDeleteBar');
  if (del) del.hidden = !gallerySelectMode;
  refreshDeleteConfirm();
}

function refreshDeleteConfirm() {
  const dc = $('#galleryDeleteConfirm');
  if (!dc) return;
  if (dc.dataset.armed) return;
  const n = gallerySelected.size;
  dc.textContent = n ? `Delete (${n})` : 'Delete';
  dc.disabled = n === 0;
}

function disarmDeleteConfirm() {
  clearTimeout(deleteArmTimer);
  const dc = $('#galleryDeleteConfirm');
  if (dc) { delete dc.dataset.armed; dc.classList.remove('armed'); }
  refreshDeleteConfirm();
}

function toggleGalleryItem(id, wrap) {
  if (gallerySelected.has(id)) { gallerySelected.delete(id); wrap?.classList.remove('selected'); }
  else { gallerySelected.add(id); wrap?.classList.add('selected'); }
  disarmDeleteConfirm();
}

function deleteGalleryItems(ids) {
  if (!ids.length) return;
  try {
    engine.deleteActivities(ids);
  } catch (e) {
    toast('Delete failed — try again.');
    return;
  }
  exitGallerySelect();
  gallerySig = null; // force rebuild; renderHud recounts + repaints
  toast(ids.length === 1 ? 'Memory deleted.' : `${ids.length} memories deleted.`);
  // Pins follow mastered state: un-mastered tiles lose their dots.
  const snap = engine.getSnapshot();
  try {
    if (isMasteredCell(snap.store, selectedCell)) mapView.showTilePins(snap.store, selectedCell);
    else mapView.hideTilePins();
  } catch {}
  renderHud();
}

// Voice slabs: one shared audio element, one open inline player at a time.
let slabAudio = null;
let openSlabId = null;
let openSlabUi = null;
let lastGridCount = 0;
function slabEnsureAudio() {
  if (!slabAudio) {
    slabAudio = new Audio();
    slabAudio.preload = 'auto';
    slabAudio.addEventListener('loadedmetadata', () => {
      if (openSlabUi && slabAudio.duration && slabAudio.currentTime === 0) {
        openSlabUi.time.textContent = fmtClock(slabAudio.duration);
      }
    });
    slabAudio.addEventListener('timeupdate', () => {
      if (!openSlabUi || !slabAudio.duration) return;
      openSlabUi.fill.style.width = `${(slabAudio.currentTime / slabAudio.duration) * 100}%`;
      openSlabUi.time.textContent = fmtClock(slabAudio.duration - slabAudio.currentTime);
    });
    slabAudio.addEventListener('ended', () => {
      if (!openSlabUi) return;
      openSlabUi.fill.style.width = '0%';
      if (slabAudio.duration) openSlabUi.time.textContent = fmtClock(slabAudio.duration);
      if (openSlabUi.play) openSlabUi.play.hidden = false;
      if (openSlabUi.pause) openSlabUi.pause.hidden = true;
    });
  }
  return slabAudio;
}
function closeSlabPlayer() {
  try { slabAudio?.pause(); } catch {}
  if (openSlabUi?.player) openSlabUi.player.hidden = true;
  openSlabId = null;
  openSlabUi = null;
}
function fmtDateShort(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}
function armTwoTap(btn, onFire) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      const prev = btn.textContent;
      btn.textContent = '!';
      setTimeout(() => {
        if (!btn.isConnected) return;
        delete btn.dataset.armed;
        btn.classList.remove('armed');
        btn.textContent = prev === '!' ? '×' : prev;
      }, 3000);
      return;
    }
    onFire();
  });
}
function buildVoiceSlab(v, forCell) {
  const slab = document.createElement('div');
  slab.className = 'vslab';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'vslab-main';
  main.setAttribute('aria-label', 'Open voice note player');
  const icon = document.createElement('span');
  icon.className = 'vslab-icon';
  icon.innerHTML = VOICE_SVG;
  const meta = document.createElement('span');
  meta.className = 'vslab-meta';
  const title = document.createElement('b');
  title.textContent = v.title || 'Voice note';
  const date = document.createElement('small');
  date.textContent = fmtDateShort(v.createdAt);
  meta.append(title, date);
  const wave = document.createElement('span');
  wave.className = 'vslab-wave';
  const bars = [];
  for (let i = 0; i < 36; i++) {
    const s = document.createElement('span');
    wave.appendChild(s);
    bars.push(s);
  }
  paintPeaks(bars, null, 24);
  const dur = document.createElement('span');
  dur.className = 'vslab-dur';
  dur.textContent = '0:00';
  main.append(icon, meta, wave, dur);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'vslab-del';
  del.setAttribute('aria-label', 'Delete voice note');
  del.textContent = '×';
  armTwoTap(del, () => deleteGalleryItems([v.id]));
  const player = document.createElement('div');
  player.className = 'vslab-player';
  player.hidden = true;
  const mkBtn = (label, cls, hidden) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.hidden = !!hidden;
    return b;
  };
  const playB = mkBtn('Play', 'vslab-pbtn primary', false);
  const pauseB = mkBtn('Pause', 'vslab-pbtn', true);
  const stopB = mkBtn('Stop', 'vslab-pbtn', false);
  const track = document.createElement('div');
  track.className = 'vslab-track';
  const fill = document.createElement('span');
  track.appendChild(fill);
  const time = document.createElement('span');
  time.className = 'vslab-time';
  time.textContent = '0:00';
  player.append(playB, pauseB, stopB, track, time);
  const ui = { player, fill, time, play: playB, pause: pauseB };
  const audio = slabEnsureAudio();
  const setPlaying = (playing) => {
    playB.hidden = playing;
    pauseB.hidden = !playing;
  };
  main.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openSlabId && openSlabId !== v.id) closeSlabPlayer();
    if (openSlabId === v.id) { closeSlabPlayer(); return; }
    openSlabId = v.id;
    openSlabUi = ui;
    if (audio.src !== v.url) {
      try { audio.src = v.url; } catch {}
    }
    player.hidden = false;
    setPlaying(true);
    audio.play().catch(() => setPlaying(false));
  });
  playB.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.play().catch(() => {});
    setPlaying(true);
  });
  pauseB.addEventListener('click', (e) => {
    e.stopPropagation();
    try { audio.pause(); } catch {}
    setPlaying(false);
  });
  stopB.addEventListener('click', (e) => {
    e.stopPropagation();
    try { audio.pause(); audio.currentTime = 0; } catch {}
    fill.style.width = '0%';
    if (audio.duration) time.textContent = fmtClock(audio.duration);
    setPlaying(false);
  });
  track.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!audio.duration) return;
    const r = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    try { audio.currentTime = ratio * audio.duration; } catch {}
  });
  slab.append(main, del, player);
  // Duration + true waveform resolve in background; stale renders die here.
  try {
    const tmp = new Audio();
    tmp.preload = 'metadata';
    tmp.src = v.url;
    tmp.onloadedmetadata = () => {
      if (!slab.isConnected || forCell !== selectedCell) return;
      if (tmp.duration) dur.textContent = fmtClock(tmp.duration);
    };
  } catch {}
  decodePeaks(v.url, bars.length).then((peaks) => {
    if (!slab.isConnected || forCell !== selectedCell) return;
    if (peaks) paintPeaks(bars, peaks, 24);
  });
  return slab;
}

async function renderTileGallery() {
  const gal = $('#tileGallery');
  const vgal = $('#voiceGallery');
  if (!gal) return;
  if (voiceCaptureOpen) {
    gal.hidden = true;
    if (vgal) vgal.hidden = true;
    return;
  }
  const my = ++galleryToken;
  // Tile ownership: this render belongs to the tile selected at call time.
  // Re-verified after every await — a tile switch mid-resolve discards it.
  const forCell = selectedCell;
  try {
    const acts = engine.getSnapshot().store.activities.filter((a) => a.cell === forCell && hasMedia(a));
    const sigIds = acts.map((a) => a.id).sort().join(',');
    // renderHud runs every second while tracking — skip the rebuild when the
    // item set is unchanged (signed URLs are re-minted hourly instead).
    if (sigIds === gallerySig && Date.now() - galleryBuiltAt < 50 * 60 * 1000 &&
        (gal.childElementCount > 0 || (vgal && vgal.childElementCount > 0))) {
      updateGalleryChrome(lastGridCount);
      return;
    }
    // Resolve view URLs: same-session blob first (instant + private), else a
    // fresh signed URL from the stored path (never persisted).
    const items = [];
    for (const a of acts) {
      let url = a.localUrl || null;
      if (!url) {
        const p = pathFromActivity(a);
        if (!p) continue;
        try {
          url = await signedUrl(p);
        } catch (e) {
          // Signed-URL failures (bucket/policy) mean the whole tile is
          // unloadable — trace the path so dashboard keys can be compared.
          noteMediaError(a.id, p, `sign:${e?.message || e}`);
          continue;
        }
        if (my !== galleryToken || forCell !== selectedCell) return;
      }
      items.push({ id: a.id, url, kind: mediaKind(a, url), title: a.title, createdAt: a.createdAt });
    }
    if (my !== galleryToken || forCell !== selectedCell) return;
    gallerySig = sigIds;
    galleryBuiltAt = Date.now();
    // Photo/video keep the square grid (and the fullscreen viewer); voice
    // notes get their own slab list with inline players.
    const gridItems = items.filter((it) => it.kind !== 'audio');
    const voiceItems = items
      .filter((it) => it.kind === 'audio')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    viewerItems = gridItems;
    lastGridCount = gridItems.length;
    // Prune selections that no longer exist.
    const alive = new Set(gridItems.map((it) => it.id));
    for (const id of [...gallerySelected]) if (!alive.has(id)) gallerySelected.delete(id);
    gal.innerHTML = '';
    gal.hidden = gridItems.length === 0;
    for (const { id, url, kind } of gridItems) {
      const wrap = document.createElement('div');
      wrap.className = 'g-item' + (gallerySelectMode ? ' selecting' : '') + (gallerySelected.has(id) ? ' selected' : '');
      let el;
      if (kind === 'video') {
        el = document.createElement('video');
        // #t=0.1 forces a real first frame (metadata-only preload renders
        // blank on most mobile browsers); badge marks it as video regardless.
        el.src = url + '#t=0.1';
        el.preload = 'auto';
        el.muted = true;
        el.playsInline = true;
        el.addEventListener('error', () => {
          el.style.opacity = '0.25';
          noteMediaError(id, url.split('#')[0].split('?')[0].slice(-64), 'video-load');
        });
        const badge = document.createElement('span');
        badge.className = 'g-play';
        badge.innerHTML = PLAY_BADGE;
        wrap.appendChild(badge);
      }
      else {
        el = document.createElement('img'); el.alt = 'memory';
        el.addEventListener('error', () => {
          el.style.opacity = '0.25';
          noteMediaError(id, url.split('?')[0].slice(-64), 'img-load');
        });
        el.src = url;
      }
      el.className = 'g-thumb';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (gallerySelectMode) toggleGalleryItem(id, wrap);
        else openViewer(url);
      });
      const check = document.createElement('span');
      check.className = 'g-check';
      check.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
      check.addEventListener('click', (e) => { e.stopPropagation(); toggleGalleryItem(id, wrap); });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'g-del';
      del.setAttribute('aria-label', 'Delete memory');
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!del.dataset.armed) {
          del.dataset.armed = '1';
          del.classList.add('armed');
          del.textContent = '!';
          setTimeout(() => {
            if (!del.isConnected) return;
            delete del.dataset.armed;
            del.classList.remove('armed');
            del.textContent = '×';
          }, 3000);
          return;
        }
        deleteGalleryItems([id]);
      });
      wrap.append(el, check, del);
      gal.appendChild(wrap);
    }
    updateGalleryChrome(gridItems.length);
    if (vgal) {
      vgal.innerHTML = '';
      closeSlabPlayer();
      if (!voiceItems.length) {
        vgal.hidden = true;
      } else {
        vgal.hidden = false;
        const head = document.createElement('div');
        head.className = 'vsec-head';
        head.textContent = `Voice notes · ${voiceItems.length}`;
        vgal.appendChild(head);
        for (const v of voiceItems) vgal.appendChild(buildVoiceSlab(v, forCell));
      }
    }
  } catch (e) { console.warn('[gallery] render failed:', e?.message || e); }
}

async function placeName(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (placeCache.has(key)) return placeCache.get(key);
  try {
    const url = `${CONFIG.nominatimUrl}?lat=${lat}&lon=${lng}&format=jsonv2`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('geocode failed');
    const data = await res.json();
    const addr = data.address || {};
    const name =
      addr.suburb ||
      addr.neighbourhood ||
      addr.quarter ||
      addr.city_district ||
      addr.town ||
      addr.city ||
      data.name ||
      'Unnamed area';
    const city = addr.city || addr.town || addr.state || '';
    const label = city ? `${name}, ${city}` : name;
    placeCache.set(key, label);
    return label;
  } catch {
    return 'Current tile';
  }
}

// Mastered = unlocked + stored media (mirrors the green border rule in map.js)
function isMasteredCell(store, cell) {
  const rec = store.tiles[cell];
  if (!isUnlocked(rec)) return false;
  return (store.activities || []).some((a) => a.cell === cell && hasMedia(a));
}

function selectCell(cell, { toastOnSelect = false, src = '?' } = {}) {
  // An open voice recorder dies on tile switch: capture is presence-only,
  // so a recorder opened elsewhere must never survive onto a new tile.
  try {
    if (voiceCaptureOpen && typeof dismissVoiceCapture === 'function') {
      if (dismissVoiceCapture()) toast('Tile changed — unsaved voice note discarded.');
    }
  } catch {}
  // A new tile always leaves gallery select mode (stale checkboxes die here).
  exitGallerySelect();
  gallerySig = null;
  selectedCell = cell;
  noteSel(src, cell);
  const snap = engine.getSnapshot();
  mapView.paint(snap.store);
  const info = mapView.inspectCell(snap.store, cell);
  // Quest mode reads the quest ledger only — regular rec, status, pins,
  // and mastered context stay invisible there.
  const hudRec = questMode ? snap.store.questTiles?.[cell] : info.rec;
  // Quest mode is forward-only: static open state here, nothing — states,
  // card data, progress — reads back from the regular map.
  const hudStatus = questMode ? 'unlocked' : info.status;
  const selStatus =
    !questMode && info.status === 'unlocked' && isMasteredCell(snap.store, cell) ? 'mastered' : hudStatus;
  mapView.setSelected(cell, selStatus);
  const pct = progressPercent(hudRec);
  updateAreaName(cell);
  updateCityTitle();
  updateCountdown(hudRec, hudStatus);
  // Activity dots: regular-context only — never on the quest map.
  // Guarded so a pins failure can never break selection/boot.
  try {
    if (!questMode && isMasteredCell(snap.store, cell)) mapView.showTilePins(snap.store, cell);
    else mapView.hideTilePins();
  } catch (e) { console.warn('[pins] failed:', e?.message || e); }
  // Animate bar 0 → current on every tap (progress already reflects tile)
  const bar = document.getElementById('tileProgressBar');
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth;
    bar.style.transition = 'width 0.5s ease';
    bar.style.width = `${pct}%`;
  }
  if (toastOnSelect) {
    if (hudStatus === 'unlocked') toast('This tile is already part of your story.');
    else if (hudStatus === 'activated')
      toast(`Activated tile ${cell.slice(0, 8)} — dwell progress is ${pct}%.`);
    else toast('Unclaimed tile. Move through it to activate.');
  }
  renderHud();
}

// Toolbar pinning: the bar rides above the collapsed card's top. While
// expanded it stays pinned, so the growing card slides over and covers it.
// Expansion cap: the open card never passes the top stats cluster.
// Measured at runtime (notch + cluster height vary) on every expand/resize.
function layoutCardLimit() {
  const card = $('#bottomCard');
  const stats = document.querySelector('.map-topbar .header-counts');
  const dock = $('#cardDock');
  if (!card || !stats || !dock) return;
  // Workstation: the open quest card always fills 2/3 of the screen —
  // elements or empty, it feels like a place to make quests.
  if (questMode && card.classList.contains('expanded')) {
    const h = Math.round(window.innerHeight * 2 / 3);
    card.style.minHeight = `${h}px`;
    card.style.maxHeight = `${h}px`;
    return;
  }
  card.style.minHeight = '';
  const statsBottom = stats.getBoundingClientRect().bottom;
  const dockBottomGap = window.innerHeight - dock.getBoundingClientRect().bottom;
  const maxH = Math.max(160, Math.round(window.innerHeight - statsBottom - dockBottomGap - 8));
  card.style.maxHeight = `${maxH}px`;
}

// Floating quest entry: anchored over the tapped tile by projecting its
// center. Visible in quest mode only, with a tile selected and the card
// collapsed — the card open means creation UI is already up.
function layoutQuestCreate() {
  const btn = $('#questCreateFloat');
  if (!btn) return;
  const card = $('#bottomCard');
  const show = questMode && !!selectedCell && !(card?.classList.contains('expanded'));
  if (!show) {
    btn.hidden = true;
    return;
  }
  try {
    const c = cellCenter(selectedCell);
    const pt = mapView.map.project([c.lng, c.lat]);
    btn.style.left = `${Math.round(pt.x)}px`;
    btn.style.top = `${Math.round(pt.y)}px`;
    btn.hidden = false;
  } catch {
    btn.hidden = true;
  }
}

function layoutToolbar() {
  const bar = $('#toolBar');
  const card = $('#bottomCard');
  if (!bar || !card) return;
  // Measure the state, not the pixels: mid-toggle the card still carries
  // the workstation inline height, so offsetHeight lies and strands the
  // bar high until the next network-driven render. The expanded quest
  // card is always 2/3 of the screen — use that directly.
  const cardH = (questMode && card.classList.contains('expanded'))
    ? Math.round(window.innerHeight * 2 / 3)
    : card.offsetHeight;
  if (!card.classList.contains('expanded')) {
    bar.style.bottom = `${cardH + 10}px`;
  }
  // Quest search rides the quest card top the same way.
  const search = $('#questSearchBar');
  if (search && !search.hidden) {
    search.style.bottom = `${cardH + 10}px`;
  }
  // Floating recorder rides above the toolbar, never under the card.
  const panel = $('#voicePanel');
  if (panel && !panel.hidden) {
    panel.style.bottom = `${cardH + bar.offsetHeight + 20}px`;
  }
}

function renderHud() {
  const snap = engine.getSnapshot();
  const rec = questMode ? snap.store.questTiles?.[selectedCell] : snap.store.tiles[selectedCell];
  const coverage = snap.coverage;
  const unlockedEl = $('#unlockedCount');
  if (unlockedEl) unlockedEl.textContent = snap.unlockedCount;
  const covEl = $('#coveragePercent');
  if (covEl) covEl.textContent = `${coverage}%`;
  const covBar = $('#coverageBar');
  if (covBar) covBar.style.width = `${coverage}%`;
  const todayEl = $('#todayProgress');
  if (todayEl) todayEl.textContent = `${coverage}%`;
  const streakEl = $('#streakCount');
  if (streakEl) streakEl.textContent = snap.streakDays;
  const activityCountEl = $('#activityCount');
  if (activityCountEl) activityCountEl.textContent = `${snap.activities.length} activities`;
  const youTilesEl = $('#youTiles');
  if (youTilesEl) youTilesEl.textContent = `${snap.unlockedCount} tiles`;
  const outingBadge = $('#outingBadge');
  if (outingBadge) outingBadge.hidden = !snap.outing;
  // Summary card live fields — Areas: 2 boxes (activated blue + unlocked green), Tiles: unlocked only
  const tilesChip = $('#tilesUnlockedCount');
  if (tilesChip) tilesChip.textContent = String(snap.unlockedCount);
  const areasActEl = $('#areasActivatedCount');
  const areasUnlEl = $('#areasUnlockedCount');
  if (areasActEl || areasUnlEl) {
    try {
      // Ensure hex raster is built before stats — otherwise all totals are 0
      // and activated stays 0 even with live dwell (paint is rAF-deferred).
      if (areasDbg.levelReady('area')) areasDbg.buildAreaHexes();
      const { areaStats } = areasDbg.getRollup(snap.store);
      let activatedAreas = 0;
      let unlockedAreas = 0;
      for (const s of areaStats.values()) {
        if (s.status === 'activated') activatedAreas += 1;
        else if (s.status === 'unlocked' || s.status === 'mastered') unlockedAreas += 1;
      }
      if (areasActEl) areasActEl.textContent = String(activatedAreas);
      if (areasUnlEl) areasUnlEl.textContent = String(unlockedAreas);
    } catch {
      if (areasActEl) areasActEl.textContent = '0';
      if (areasUnlEl) areasUnlEl.textContent = '0';
    }
  }
  updateCityTitle();
  updateAreaName(selectedCell);
  let hudStatus = 'unclaimed';
  try {
    hudStatus = questMode ? 'unlocked' : mapView.inspectCell(snap.store, selectedCell).status;
  } catch {}
  updateCountdown(rec, hudStatus);
  renderTitleField(snap.store.tiles[selectedCell]?.name, hudStatus);
  renderQuestList();
  layoutToolbar();
  layoutQuestCreate();
  try { renderTileGallery(); } catch {}
  updateCaptureAvailability(snap);
  mapView.paint(snap.store);
}

// Capture matrix: presence-only, no exceptions. Every capture type arms
// solely on the tile underfoot — remote tiles (any status) stay muted, so
// no remote action can activate, boost, or write media to a tile.
function updateCaptureAvailability(snap) {
  let present = false;
  try {
    if (mapView && selectedCell && !gateOpen) {
      const { lat, lng } = mapView.getUserLocation();
      present = cellAt(lat, lng) === selectedCell;
    }
  } catch {}
  document.querySelectorAll('[data-capture="photo"], [data-capture="session"]').forEach((b) => {
    b.disabled = !present;
    b.classList.toggle('muted', !present);
    b.title = present ? '' : 'Go to this tile to capture';
  });
  document.querySelectorAll('[data-capture="voice"]').forEach((b) => {
    b.disabled = !present;
    b.classList.toggle('muted', !present);
    b.title = present ? '' : 'Go to this tile to leave a voice note';
  });
}

function applyPosition(lat, lng, { fly = false, dwellMs = 0 } = {}) {
  mapView.setUserLocation(lng, lat, { fly });
  const cell = cellAt(lat, lng);
  if (dwellMs > 0 && !locationFilter.frozen) engine.dwell(cell, dwellMs);
  // Live-cell tracking with jitter guard: only a stable new live cell
  // unpins a tapped selection and resumes follow.
  if (lastLiveCell === null) {
    lastLiveCell = cell;
  } else if (cell !== lastLiveCell) {
    if (cell === liveCandidate) liveCandidateHits += 1;
    else { liveCandidate = cell; liveCandidateHits = 1; }
    if (liveCandidateHits >= 3) {
      lastLiveCell = cell;
      liveCandidate = null;
      liveCandidateHits = 0;
      // Sustained physical move drops a pinned card — say so once, so the
      // card following the user is never mistaken for a bug.
      if (selectionPinned) toast('Moved to a new tile — showing your live tile.');
      selectionPinned = false;
    }
  } else {
    liveCandidate = null;
    liveCandidateHits = 0;
  }
  // Browse mode (map panned away): GPS never reselects the card — it holds
  // its tile until snap-back or a new tap. Follow mode tracks live as before.
  if (!selectionPinned && mapView.isFollowing() && cell !== selectedCell) selectCell(cell, { src: 'gps' });
  else renderHud();
}

function startWatch() {
  if (!navigator.geolocation) {
    toast('This browser has no GPS. Use + to walk a real Hyderabad path.');
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      watchRetries = 0; // a real fix resets the retry budget
      const fix = smoothFix(pos.coords);
      if (!fix) return;
      applyPosition(fix.lat, fix.lng, { fly: false });
      engine.setBase(fix.lat, fix.lng);
      // Real travel across regions: packs follow the base (sandbox excluded —
      // the joystick manages its own region).
      if (!engine.isSandbox()) autoRegion(fix.lat, fix.lng);
    },
    (err) => handleGeoError(err),
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 },
  );
}

function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// Geolocation failures, honestly separated. iOS cold-starts routinely time
// out the first call, and PWA contexts often never show a prompt at all —
// neither is a denial, and a dead watch must never strand tracking ON.
let watchRetries = 0;
const WATCH_MAX_RETRIES = 3;
function isStandalonePwa() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || !!window.navigator.standalone;
  } catch {
    return false;
  }
}
function locationGuidance() {
  // iOS PWA quirk: grant once in the Safari tab — the installed app follows.
  if (isStandalonePwa()) {
    return 'Location is blocked with no prompt. Open gruffy.in in Safari, Allow location there, then return here and tap Live Explore again — tap this message to dismiss.';
  }
  // Dismissed prompts never re-appear on the same page load — reload first.
  return 'Location is blocked. Reload the page, tap Live Explore, and answer Allow (Precise on). If it still fails, check Settings → Apps → Safari → Location — tap this message to dismiss.';
}
// One-shot probe: what does the browser believe the permission is?
// Distinguishes a stored denial from the dismissed-prompt trap (which
// reports 'prompt' yet never re-prompts without a reload). Logged for
// Safari triage — quote the [geo] lines back with any failure report.
async function probeGeoPermission(tag) {
  try {
    console.log(`[geo:${tag}] secureContext:`, window.isSecureContext);
  } catch {}
  try {
    if (!navigator.permissions?.query) {
      console.log(`[geo:${tag}] permissions API unavailable`);
      return;
    }
    const st = await navigator.permissions.query({ name: 'geolocation' });
    console.log(`[geo:${tag}] permission state:`, st?.state);
  } catch (e) {
    console.log(`[geo:${tag}] probe failed:`, e?.message || e);
  }
}
function handleGeoError(err) {
  const code = err && typeof err.code === 'number' ? err.code : -1;
  if (code === 1) {
    // Truly denied (or PWA-silenced): this watch is dead — flip the toggle
    // off so a re-tap after granting starts a fresh watch, and say so.
    stopWatch();
    probeGeoPermission('watch-denied');
    if (tracking) setTracking(false);
    toastDiag(locationGuidance());
    return;
  }
  // Transient (timeout / unavailable / unknown): cold starts recover — retry
  // with backoff while tracking is still wanted, then say so plainly.
  if (tracking && watchRetries < WATCH_MAX_RETRIES) {
    watchRetries += 1;
    toast(`Locating… retry ${watchRetries} of ${WATCH_MAX_RETRIES} (cold-start GPS can take a while).`);
    window.setTimeout(() => {
      if (!tracking) return;
      stopWatch();
      startWatch();
    }, 2500 * watchRetries);
  } else if (tracking) {
    toastDiag('Still no GPS fix. Check Location Services and sky view, then toggle Live Explore off and on — tap this message to dismiss.');
  }
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && tracking) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tracking) requestWakeLock();
});

function setTracking(on) {
  tracking = on;
  $('#trackingButton').classList.toggle('live', tracking);
  $('#trackingButton').setAttribute('aria-pressed', String(tracking));
  const tl = $('#trackingLabel');
  if (tl) tl.textContent = 'Live Explore';
  if (tracking) {
    lastDwellAt = performance.now();
    watchRetries = 0;
    stopWatch(); // re-share while live must not leak the old watch
    startWatch();
    requestWakeLock();
    try { mapView.recenter(); } catch {}
    toast('Live fog clearing is on. Hexes follow your real coordinates.');
  } else {
    stopWatch();
    releaseWakeLock();
    // Off: settle the camera on the selected tile's default view.
    try {
      if (selectedCell) {
        const c = cellCenter(selectedCell);
        mapView.recenter({ lng: c.lng, lat: c.lat });
      }
    } catch {}
    toast('Fog clearing paused.');
  }
}

// Quest mode (admin+): the card becomes the quest designer for the
// selected tile. Creation stays presence-free — any map, any city.
let questMode = false;
function setQuestMode(on) {
  questMode = on;
  const card = $('#bottomCard');
  card?.classList.toggle('quest-mode', on);
  // The floating recorder is regular-context capture — it dies on entry.
  if (on && voiceCaptureOpen) {
    try {
      closeVoiceFn?.();
    } catch {}
  }
  const cap = $('#questCaption');
  if (cap) cap.hidden = !on;
  const bar = $('#toolBar');
  if (bar) bar.hidden = on;
  const search = $('#questSearchBar');
  if (search) search.hidden = !on;
  const input = $('#tileTitleInput');
  if (input) input.placeholder = on ? 'Name the Quest..' : 'Name Your Tile..';
  const qb = $('#questButton');
  if (qb) {
    qb.classList.toggle('armed', on);
    qb.setAttribute('aria-pressed', String(on));
  }
  try {
    mapView.setQuestMode(on);
  } catch {}
  if (!on) {
    try {
      if (card?.classList.contains('expanded')) $('#sheetArrow')?.click();
    } catch {}
  }
  renderHud();
  layoutCardLimit();
  layoutToolbar();
}
// Workstation framing: with the quest card holding the bottom 2/3, ease the
// edited tile under the (screen-fixed) dot in the visible top third.
// One-shot — later pans stay exactly where the maker leaves them.
function focusEditedTile() {
  try {
    if (!questMode) return;
    const q = openQuestId ? questById(openQuestId) : null;
    const cell = q?.h3_cell || selectedCell;
    if (!cell || !mapView?.map) return;
    const c = cellCenter(cell);
    mapView.map.easeTo({
      center: [c.lng, c.lat],
      offset: [0, -Math.round(window.innerHeight / 3)],
      duration: 750,
    });
  } catch {}
}
function flyToPoint(lat, lng) {
  try {
    mapView.map.easeTo({
      center: [lng, lat],
      zoom: Math.max(mapView.map.getZoom(), CONFIG.defaultZoom),
      duration: 750,
    });
  } catch {}
  try {
    selectCell(cellAt(lat, lng), { src: 'search' });
  } catch {}
}
// Quest search: place name, lat,lng, or H3 id — in that order.
async function runQuestSearch() {
  const input = $('#questSearchInput');
  const q = (input?.value || '').trim();
  if (!q) return;
  input?.blur();
  const m = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      flyToPoint(lat, lng);
      return;
    }
  }
  const hex = q.replace(/\s+/g, '').toLowerCase();
  if (/^[0-9a-f]+$/.test(hex)) {
    try {
      const c = cellCenter(hex);
      flyToPoint(c.lat, c.lng);
      return;
    } catch {
      /* not a real cell — fall through to name search */
    }
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=1`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) throw new Error('search failed');
    const arr = await res.json();
    if (arr && arr.length) {
      flyToPoint(parseFloat(arr[0].lat), parseFloat(arr[0].lon));
      return;
    }
  } catch (e) {
    console.warn('[quest] search failed:', e?.message || e);
  }
  toast('No place found — try a name, lat,lng, or H3 id.');
}
async function refreshQuests(force = false) {
  try {
    const pts = await fetchRegionQuests(areasDbg.getRegion(), { force });
    // Deployed quests live on the Main Map; everything renders on the quest map.
    mapView.showQuests(questMode ? pts : pts.filter((q) => q.status === 'deployed'));
    // Permanent tile pulse: every live quest cell breathes amber.
    // ('recalled' can't occur until the lifecycle migration lands.)
    try {
      mapView.setQuestCells((pts || []).filter((q) => q.status !== 'recalled').map((q) => q.h3_cell));
    } catch {}
    // Quest names + counts on the card read the cache — repaint now.
    renderHud();
    // Card quest list reads the same cache — repaint it too, otherwise
    // transitions (finish/deploy/undeploy) and creates leave a stale list
    // with a dead disabled button behind them.
    renderQuestList();
  } catch (e) {
    console.warn('[quest] fetch failed:', e?.message || e);
  }
}

// Quest progress states (per-quest — distinct from the tile's quest count).
const QUEST_PROGRESS = {
  deployed: { label: 'Deployed', cls: 'deployed', meaning: 'Live on the Main Map.' },
  draft: { label: 'In Progress', cls: 'draft', meaning: 'Still being made — showing last saved.' },
  finished: { label: 'Finished', cls: 'finished', meaning: 'Complete but not deployed.' },
};
let openQuestId = null;
let lastQuestListSig = null;
// editQuestId: finished/deployed row with objectives editing enabled.
// nameEditId: row with the inline quest-name field open (any status).
let editQuestId = null;
let nameEditId = null;
// Blip roles: one Main + one End per quest (partial unique index backs it).
// Setting a new one unsets the previous holder; tapping the active chip
// clears the role. Sequential awaits keep the index happy.
async function setBlipRole(questId, o, kind) {
  const flag = kind === 'main' ? 'is_main' : 'is_end';
  const on = !o[flag];
  try {
    const known = await fetchObjectives(questId, { force: true });
    for (const x of known) {
      if (x[flag] && x.id !== o.id) await updateObjective(x.id, questId, { [flag]: false });
    }
    await updateObjective(o.id, questId, { [flag]: on });
    await renderObjectives(questId);
  } catch (err) {
    console.warn('[quest] blip role failed:', err?.message || err);
    toastDiag(`Blip role failed: ${err?.message || err}`);
  }
}
async function transitionQuest(id, to, btn) {
  if (btn) btn.disabled = true;
  // Deploy gate: a quest ships only with an End Blip declared (Main or
  // any one Trail). Fresh fetch — the cache must not wave through a stale no.
  if (to === 'deployed') {
    try {
      const known = await fetchObjectives(id, { force: true });
      if (!known.some((o) => o.is_end && o.lat != null && o.lng != null)) {
        toastDiag('Assign an End Blip before deploying.');
        if (btn) btn.disabled = false;
        return;
      }
    } catch (err) {
      console.warn('[quest] deploy gate failed:', err?.message || err);
      toastDiag(`Deploy check failed: ${err?.message || err}`);
      if (btn) btn.disabled = false;
      return;
    }
  }
  try {
    // Mark Finished means "save the state": flush any typed-but-unsaved
    // quest name from the open row before flipping status.
    const nameInput = $('#questList .qname-row input');
    const pending = (nameInput?.value || '').trim();
    const cur = questById(id);
    if (pending && cur && pending !== cur.title) {
      try {
        await updateQuestTitle(id, pending);
      } catch (e) {
        console.warn('[quest] name flush failed:', e?.message || e);
      }
    }
    await updateQuestStatus(id, to);
    openQuestId = id;
    editQuestId = null;
    nameEditId = null;
    await refreshQuests(true);
  } catch (err) {
    console.warn('[quest] transition failed:', err?.message || err);
    toastDiag(`Quest update failed: ${err?.message || err}`);
    if (btn) btn.disabled = false;
  }
}
// ---- Exact-location blips (navigation objectives) ----
// pendingPins survives entry rebuilds: questId -> { lat, lng } dropped but
// not yet saved with the objective.
const pendingPins = new Map();
let dropBlip = null; // { questId, entry, prevFollow } while placing a blip
function dropBlipOverlay() {
  let ov = document.getElementById('dropBlipWrap');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'dropBlipWrap';
  ov.hidden = true;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'dropBlipBtn';
  btn.textContent = 'Drop Blip';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmDropBlip();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.id = 'dropBlipCancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', (e) => {
    e.stopPropagation();
    exitDropBlip();
  });
  ov.append(btn, cancel);
  document.body.appendChild(ov);
  return ov;
}
function startDropBlip(questId, entry) {
  if (dropBlip) exitDropBlip();
  // The dot needs a clear stage: collapse the sheet (DOM survives, sig-guard
  // skips the rebuild, so typed text and the picked tool stay put).
  try {
    const card = $('#bottomCard');
    if (card?.classList.contains('expanded')) $('#sheetArrow')?.click();
  } catch {}
  // Center the tile being edited with the amber dot at default center.
  try {
    const q = questById(questId);
    const cell = q?.h3_cell || selectedCell;
    if (cell) {
      const c = cellCenter(cell);
      mapView.map.easeTo({ center: [c.lng, c.lat], zoom: 15.3, duration: 750 });
    } else {
      mapView.map.easeTo({ zoom: 15.3, duration: 750 });
    }
  } catch {}
  let prevFollow = true;
  try {
    prevFollow = mapView.isFollowing();
    mapView.setFollowing(false); // GPS ticks must not yank the camera mid-pan
    mapView.setPuckAnim('');
    mapView.setPuckDimmed(false);
    document.getElementById('userPuck')?.classList.add('dropping');
  } catch {}
  dropBlip = { questId, entry, prevFollow };
  dropBlipOverlay().hidden = false;
}
function exitDropBlip() {
  try { document.getElementById('userPuck')?.classList.remove('dropping'); } catch {}
  try { if (dropBlip) mapView.setFollowing(dropBlip.prevFollow); } catch {}
  const ov = document.getElementById('dropBlipWrap');
  if (ov) ov.hidden = true;
  dropBlip = null;
}
function confirmDropBlip() {
  if (!dropBlip) return;
  // The puck is screen-fixed at map center: the drop point is the center.
  let pt = null;
  try {
    const c = mapView.map.getCenter();
    pt = { lat: c.lat, lng: c.lng };
  } catch {}
  const { questId, entry } = dropBlip;
  exitDropBlip();
  if (!pt) return;
  try {
    if (entry?.isConnected && entry._setPin) entry._setPin(pt);
    else pendingPins.set(questId, pt);
  } catch {}
  // Re-expand so the maker sees the Pinned chip on the entry.
  try {
    const card = $('#bottomCard');
    if (card && !card.classList.contains('expanded')) $('#sheetArrow')?.click();
  } catch {}
}
function buildQuestRow(q) {
  const meta = QUEST_PROGRESS[q.status] || QUEST_PROGRESS.draft;
  const isOpen = openQuestId === q.id;
  const nameEditing = nameEditId === q.id;
  const row = document.createElement('div');
  row.className = 'qrow';
  // Header: name toggle + name Edit (left of pill) + status pill.
  // Name-editing collapses the pill to a same-color dot.
  const main = document.createElement('div');
  main.className = 'qrow-main' + (nameEditing ? ' name-editing' : '');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'qrow-toggle';
  toggle.setAttribute('aria-label', `Open quest ${q.title}`);
  toggle.hidden = nameEditing;
  const title = document.createElement('span');
  title.className = 'qrow-title';
  title.textContent = q.title || 'Untitled quest';
  toggle.appendChild(title);
  main.appendChild(toggle);
  const nameForm = document.createElement('div');
  nameForm.className = 'qname-row';
  nameForm.hidden = !nameEditing;
  const qinput = document.createElement('input');
  qinput.type = 'text';
  qinput.maxLength = 50;
  qinput.value = q.title || '';
  qinput.setAttribute('aria-label', 'Quest name');
  const qsave = document.createElement('button');
  qsave.type = 'button';
  qsave.className = 'qname-save';
  qsave.textContent = 'Save';
  qsave.addEventListener('click', async (e) => {
    e.stopPropagation();
    qsave.disabled = true;
    try {
      await updateQuestTitle(q.id, qinput.value);
      nameEditId = null;
      await refreshQuests(true);
    } catch (err) {
      console.warn('[quest] rename failed:', err?.message || err);
      toast('Quest rename failed — try again.');
      qsave.disabled = false;
    }
  });
  const qcancel = document.createElement('button');
  qcancel.type = 'button';
  qcancel.className = 'qname-cancel';
  qcancel.textContent = '✕';
  qcancel.setAttribute('aria-label', 'Cancel rename');
  qcancel.addEventListener('click', (e) => {
    e.stopPropagation();
    nameEditId = null;
    lastQuestListSig = null;
    renderQuestList();
  });
  nameForm.append(qinput, qsave, qcancel);
  main.appendChild(nameForm);
  const nameEdit = document.createElement('button');
  nameEdit.type = 'button';
  nameEdit.className = 'qrow-nameedit';
  nameEdit.textContent = 'Edit';
  nameEdit.hidden = !isOpen || nameEditing;
  nameEdit.addEventListener('click', (e) => {
    e.stopPropagation();
    nameEditId = q.id;
    lastQuestListSig = null;
    renderQuestList();
    try { $('#questList .qname-row input')?.focus(); } catch {}
  });
  main.appendChild(nameEdit);
  const pill = document.createElement('span');
  pill.className = `qpill ${meta.cls}` + (nameEditing ? ' dot' : '');
  pill.textContent = meta.label;
  main.appendChild(pill);
  const detail = document.createElement('div');
  detail.className = 'qrow-detail';
  detail.hidden = !isOpen;
  const mean = document.createElement('p');
  mean.className = 'qmean';
  mean.textContent = meta.meaning;
  detail.appendChild(mean);
  const objLabel = document.createElement('div');
  objLabel.className = 'obj-sec-label';
  objLabel.textContent = 'Objectives';
  const objWrap = document.createElement('div');
  objWrap.dataset.objwrap = q.id;
  detail.append(objLabel, objWrap);
  // Per-quest actions live inside the open row itself: drafts finish here,
  // finished deploy or edit, deployed undeploy or edit — plus Delete.
  if (isOpen) {
    const acts = document.createElement('div');
    acts.className = 'qactions';
    const add = (label, primary, fn, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qact' + (primary ? ' primary' : '') + (cls ? ` ${cls}` : '');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn(b).catch(() => {});
      });
      acts.appendChild(b);
    };
    const addEditToggle = () => {
      add(editQuestId === q.id ? 'Done' : 'Edit', false, async () => {
        editQuestId = editQuestId === q.id ? null : q.id;
        lastQuestListSig = null;
        renderQuestList();
        renderObjectives(q.id).catch(() => {});
      });
    };
    if (q.status === 'draft') {
      add('Mark Finished', true, (b) => transitionQuest(q.id, 'finished', b));
    } else if (q.status === 'finished') {
      add('Deploy', true, (b) => transitionQuest(q.id, 'deployed', b));
      addEditToggle();
    } else if (q.status === 'deployed') {
      add('Undeploy', true, (b) => transitionQuest(q.id, 'finished', b));
      addEditToggle();
    }
    add('Delete', false, async (b) => {
      if (!window.confirm(`Delete "${q.title || 'Untitled quest'}" and all its objectives?`)) return;
      b.disabled = true;
      try {
        await deleteQuest(q.id);
        if (openQuestId === q.id) openQuestId = null;
        if (editQuestId === q.id) editQuestId = null;
        if (nameEditId === q.id) nameEditId = null;
        await refreshQuests(true);
      } catch (err) {
        console.warn('[quest] delete failed:', err?.message || err);
        toastDiag(`Quest delete failed: ${err?.message || err}`);
        b.disabled = false;
      }
    }, 'danger');
    if (acts.childElementCount) detail.appendChild(acts);
  }
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = openQuestId !== q.id;
    openQuestId = willOpen ? q.id : null;
    if (willOpen) nameEditId = null; // fresh open shows name + Edit
    lastQuestListSig = null; // force rebuild for the expand/collapse
    try {
      renderQuestList();
    } catch {}
    if (openQuestId === q.id) {
      renderObjectives(q.id).catch(() => {});
      focusEditedTile();
    }
  });
  row.append(main, detail);
  return row;
}
function renderQuestList() {
  const block = $('#questBuildBlock');
  const list = $('#questList');
  if (!block || !list) return;
  if (!questMode) {
    if (!block.hidden) {
      block.hidden = true;
      list.innerHTML = '';
    }
    lastQuestListSig = null;
    return;
  }
  block.hidden = false;
  const qs = questsForCell(selectedCell);
  const sig = `${selectedCell}|${qs.map((q) => `${q.id}:${q.status}:${q.title}`).join(',')}|${openQuestId || ''}|${editQuestId || ''}|${nameEditId || ''}`;
  if (sig === lastQuestListSig) return;
  lastQuestListSig = sig;
  list.innerHTML = '';
  if (!qs.length) {
    const empty = document.createElement('div');
    empty.className = 'qempty';
    empty.textContent = 'No quests on this tile yet — tap + Create to begin.';
    list.appendChild(empty);
    return;
  }
  for (const q of qs) list.appendChild(buildQuestRow(q));
  // The open row's objectives always render with it — transitions and
  // Edit toggles rebuild the row, so repaint here centrally (no ghost states).
  if (openQuestId) renderObjectives(openQuestId).catch(() => {});
  // Content changed the card height — re-seat the search bar on the new top.
  try { layoutToolbar(); } catch {}
  // Pins belong to the open quest: closing every row clears them.
  if (!openQuestId) {
    try { mapView.showObjectivePins([]); } catch {}
  }
}

// ---- Quest objectives (builder): entry card + radio list, per open quest ----
const OBJ_TOOLS = [
  {
    id: 'camera',
    label: 'Camera',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 7l1.5-3h5L16 7"/></svg>',
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>',
  },
  {
    id: 'navigation',
    label: 'Nav',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
  },
];
const OBJ_TOOL_LABEL = { camera: 'Camera', voice: 'Voice', navigation: 'Nav' };

async function renderObjectives(questId) {
  const wrap = document.querySelector(`[data-objwrap="${questId}"]`);
  if (!wrap) return;
  // Drafts always edit; finished/deployed edit only via the row's Edit toggle.
  const q = questById(questId);
  const editable = !q || q.status === 'draft' || editQuestId === questId;
  let list = [];
  try {
    list = await fetchObjectives(questId);
  } catch (e) {
    console.warn('[objectives] load failed:', e?.message || e);
    wrap.innerHTML = '<div class="qempty">Objectives failed to load.</div>';
    return;
  }
  // Stale guard: another quest opened (or closed) mid-fetch.
  if (!wrap.isConnected || openQuestId !== questId) return;
  wrap.innerHTML = '';
  wrap.dataset.editId = '';
  wrap.classList.toggle('obj-locked', !editable);
  const entry = buildObjectiveEntry(questId);
  const current = currentObjectiveId(questId, list);
  wrap.appendChild(entry);
  if (list.length) {
    const ol = document.createElement('div');
    ol.className = 'obj-list';
    for (const o of list) ol.appendChild(buildObjectiveRow(questId, o, o.id === current, editable));
    wrap.appendChild(ol);
  }
  // Amber blips for the open quest's pinned objectives (quest map only).
  try {
    const pins = (list || [])
      .filter((o) => o.lat != null && o.lng != null)
      .map((o) => ({
        lat: o.lat,
        lng: o.lng,
        role: o.is_main && o.is_end ? 'main_end' : o.is_main ? 'main' : o.is_end ? 'end' : 'trail',
      }));
    mapView.showObjectivePins(questMode ? pins : []);
  } catch {}
  // Objectives landed after the row opened — the card grew, re-seat the bar.
  try { layoutToolbar(); } catch {}
}

function buildObjectiveEntry(questId) {
  const entry = document.createElement('div');
  entry.className = 'obj-entry';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 140;
  input.placeholder = 'Describe the objective..';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Objective text');
  const tools = document.createElement('div');
  tools.className = 'obj-tools';
  let picked = null;
  const toolBtns = [];
  // Exact blip stashed by Drop Blip (survives entry rebuilds via pendingPins).
  let pin = pendingPins.get(questId) || null;
  const syncNav = () => {
    navBlock.hidden = picked !== 'navigation';
  };
  for (const t of OBJ_TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'obj-tool';
    b.dataset.tool = t.id;
    b.innerHTML = `${t.icon}<span>${t.label}</span>`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      picked = picked === t.id ? null : t.id;
      for (const x of toolBtns) x.classList.toggle('selected', x.dataset.tool === picked);
      syncNav();
    });
    toolBtns.push(b);
    tools.appendChild(b);
  }
  // Navigation pin block: hint + Mark Exact Location + Pinned chip.
  const navBlock = document.createElement('div');
  navBlock.className = 'obj-navblock';
  navBlock.hidden = true;
  const navHint = document.createElement('p');
  navHint.className = 'obj-navhint';
  navHint.textContent = 'To mark a location just drop a blip..';
  const markBtn = document.createElement('button');
  markBtn.type = 'button';
  markBtn.className = 'obj-markbtn';
  markBtn.textContent = 'Mark Exact Location';
  markBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startDropBlip(questId, entry);
  });
  const pinChip = document.createElement('span');
  pinChip.className = 'obj-pinchip';
  pinChip.hidden = true;
  const renderChip = () => {
    pinChip.hidden = !pin;
    pinChip.textContent = '';
    if (!pin) return;
    const label = document.createElement('span');
    label.textContent = 'Pinned ✓';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'obj-pinclear';
    clear.textContent = '✕';
    clear.setAttribute('aria-label', 'Remove pin');
    clear.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pin = null;
      entry._pin = null;
      pendingPins.delete(questId);
      renderChip();
    });
    pinChip.append(label, clear);
  };
  renderChip();
  // Drop Blip writes back through here (entry may rebuild mid-drop).
  entry._setPin = (p) => {
    pin = p;
    entry._pin = p;
    if (p) pendingPins.set(questId, p);
    else pendingPins.delete(questId);
    renderChip();
  };
  entry._pin = pin;
  navBlock.append(navHint, markBtn, pinChip);
  const foot = document.createElement('div');
  foot.className = 'obj-entry-foot';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'obj-cancel';
  cancel.textContent = 'Cancel';
  cancel.hidden = true;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'obj-save';
  save.textContent = 'Save objective';
  foot.append(cancel, save);
  entry.append(input, tools, navBlock, foot);
  const wrap = { editId: null };
  cancel.addEventListener('click', (e) => {
    e.stopPropagation();
    // Bail out to a clean render (drafts collapse back behind Create).
    renderObjectives(questId).catch(() => {});
  });
  save.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = (input.value || '').trim();
    save.disabled = true;
    try {
      const w = entry.closest('[data-objwrap]');
      const editId = (w?.dataset.editId || '') || null;
      const at = entry._pin || null;
      // First pinned objective becomes the Main blip (quest start).
      let hasMain = false;
      try {
        const known = await fetchObjectives(questId);
        hasMain = known.some((x) => x.is_main && x.id !== editId);
      } catch {}
      if (editId) {
        await updateObjective(editId, questId, {
          text: text || 'Untitled objective',
          tool: picked,
          lat: at ? at.lat : null,
          lng: at ? at.lng : null,
          // Roles attach to blips: unpinning clears Main/End.
          ...(at ? {} : { is_main: false, is_end: false }),
        });
      } else {
        await createObjective(questId, {
          text,
          tool: picked,
          lat: at ? at.lat : null,
          lng: at ? at.lng : null,
          isMain: !!at && !hasMain,
          isEnd: false,
        });
      }
      pendingPins.delete(questId);
      await renderObjectives(questId);
    } catch (err) {
      console.warn('[objectives] save failed:', err?.message || err);
      toast('Objective save failed — try again.');
      save.disabled = false;
    }
  });
  // Edit loader (called from a row's Edit button).
  entry.dataset.loader = '1';
  entry._loadForEdit = (o) => {
    input.value = o.text || '';
    picked = o.tool || null;
    for (const x of toolBtns) x.classList.toggle('selected', x.dataset.tool === picked);
    syncNav();
    const p = o.lat != null && o.lng != null ? { lat: o.lat, lng: o.lng } : pendingPins.get(questId) || null;
    if (entry._setPin) entry._setPin(p);
    else {
      pin = p;
      entry._pin = p;
      renderChip();
    }
    wrap.editId = o.id;
    const w = entry.closest('[data-objwrap]');
    if (w) w.dataset.editId = o.id;
    cancel.hidden = false;
    input.focus();
  };
  return entry;
}

function buildObjectiveRow(questId, o, isCurrent, editable) {
  const row = document.createElement('div');
  row.className = 'obj-row';
  const radio = document.createElement('button');
  radio.type = 'button';
  radio.className = 'obj-radio' + (isCurrent ? ' on' : '');
  radio.setAttribute('aria-label', isCurrent ? 'Current objective' : 'Set current objective');
  radio.setAttribute('aria-pressed', String(!!isCurrent));
  radio.addEventListener('click', (e) => {
    e.stopPropagation();
    setCurrentObjectiveId(questId, o.id);
    renderObjectives(questId).catch(() => {});
  });
  const text = document.createElement('span');
  text.className = 'obj-text';
  text.textContent = o.text || 'Untitled objective';
  row.appendChild(radio);
  row.appendChild(text);
  if (o.tool && OBJ_TOOL_LABEL[o.tool]) {
    const tag = document.createElement('span');
    tag.className = 'obj-tool-tag';
    tag.textContent = OBJ_TOOL_LABEL[o.tool];
    row.appendChild(tag);
  }
  // Amber blip marker: this objective carries an exact location.
  // Role colors: Main amber, Trail green, End red, Main+End half-half.
  if (o.lat != null && o.lng != null) {
    const pinDot = document.createElement('span');
    const roleCls = o.is_main && o.is_end ? 'main_end' : o.is_main ? 'main' : o.is_end ? 'end' : 'trail';
    pinDot.className = `obj-pin ${roleCls}`;
    pinDot.title = o.is_main && o.is_end ? 'Main + End blip' : o.is_main ? 'Main blip' : o.is_end ? 'End blip' : 'Trail blip';
    row.appendChild(pinDot);
  }
  // Blip roles are maker actions: Main/End toggles on pinned objectives
  // in editable rows; read-only rows show a role tag instead.
  const pinned = o.lat != null && o.lng != null;
  if (pinned) {
    if (editable) {
      const roles = document.createElement('span');
      roles.className = 'obj-roles';
      const mkChip = (label, active, cls, kind) => {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = `obj-role ${cls}` + (active ? ' on' : '');
        c.textContent = label;
        c.setAttribute('aria-pressed', String(!!active));
        c.addEventListener('click', (e) => {
          e.stopPropagation();
          setBlipRole(questId, o, kind).catch(() => {});
        });
        roles.appendChild(c);
      };
      mkChip('Main', !!o.is_main, 'main', 'main');
      mkChip('End', !!o.is_end, 'end', 'end');
      row.appendChild(roles);
    } else {
      const tag = document.createElement('span');
      const combo = o.is_main && o.is_end;
      tag.className = 'obj-tool-tag blip-tag ' + (combo ? 'main_end' : o.is_main ? 'main' : o.is_end ? 'end' : 'trail');
      tag.textContent = combo ? 'Main + End' : o.is_main ? 'Main' : o.is_end ? 'End' : 'Trail';
      row.appendChild(tag);
    }
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'obj-edit';
  edit.textContent = 'Edit';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    const ent = row.closest('[data-objwrap]')?.querySelector('.obj-entry');
    if (ent?._loadForEdit) ent._loadForEdit(o);
  });
  row.appendChild(edit);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'obj-del';
  del.textContent = 'Delete';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete objective "${o.text || 'Untitled objective'}"?`)) return;
    del.disabled = true;
    deleteObjective(o.id, questId)
      .then(() => renderObjectives(questId))
      .catch((err) => {
        console.warn('[objectives] delete failed:', err?.message || err);
        toastDiag(`Objective delete failed: ${err?.message || err}`);
        del.disabled = false;
      });
  });
  row.appendChild(del);
  return row;
}

function openDialog(type) {
  captureType = type;
  const copy = {
    photo: ['Capture a moment', 'Photo is tagged to the H3 tile under you and grants a flat unlock boost.'],
    voice: ['Leave a voice note', 'Voice note is tagged to this real tile. Same flat boost as a photo.'],
    session: ['Save this outing', 'Every hex you touched while the outing was open gets the Activity boost.'],
  }[type];
  $('#dialogTitle').textContent = copy[0];
  $('#dialogCopy').textContent = copy[1];
  $('#activityDialog').showModal();
}

function bindUi() {
  const bottomCard = $('#bottomCard');
  const summaryToggle = $('#summaryToggle');
  // Sheet toggles ONLY via the arrow (up = collapsed, down = open).
  // Tile taps and summary taps never expand it — the card stays put.
  const sheetArrow = $('#sheetArrow');
  const setExpanded = (on) => {
    bottomCard?.classList.toggle('expanded', on);
    sheetArrow?.setAttribute('aria-expanded', String(on));
    sheetArrow?.setAttribute('aria-label', on ? 'Collapse details' : 'Expand details');
  };
  sheetArrow?.addEventListener('click', (e) => {
    e.stopPropagation();
    setExpanded(!bottomCard?.classList.contains('expanded'));
    // Heights before measurement: the toolbar reads card height, so the
    // workstation pin must settle first or collapse strands the bar high.
    layoutCardLimit();
    layoutToolbar();
    if (bottomCard?.classList.contains('expanded')) focusEditedTile();
  });
  // Memory tools live inside the collapsed card: their taps/keys must act,
  // never expand/collapse the sheet.
  const memoryBlock = $('#memoryBlock');
  memoryBlock?.addEventListener('click', (e) => e.stopPropagation());
  memoryBlock?.addEventListener('keydown', (e) => e.stopPropagation());

  // PWA install prompt (deferred) — show banner when ready
  let deferredPrompt = null;
  const pwaBanner = $('#pwaBanner');
  const pwaInstallBtn = $('#pwaInstallBtn');
  const pwaDismissBtn = $('#pwaDismissBtn');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone && pwaBanner && !localStorage.getItem('tortle.pwa.dismissed')) {
      pwaBanner.hidden = false;
    }
    console.log('[pwa] install prompt ready');
  });
  pwaInstallBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch {}
    deferredPrompt = null;
    if (pwaBanner) pwaBanner.hidden = true;
  });
  pwaDismissBtn?.addEventListener('click', () => {
    if (pwaBanner) pwaBanner.hidden = true;
    try { localStorage.setItem('tortle.pwa.dismissed', '1'); } catch {}
  });
  // iOS has no beforeinstallprompt — banner never shows; user uses Share → Add to Home Screen

  $('#trackingButton').addEventListener('click', () => setTracking(!tracking));
  $('#questButton')?.addEventListener('click', () => setQuestMode(!questMode));
  $('#questCreateFloat')?.addEventListener('click', async () => {
    const card = $('#bottomCard');
    if (card && !card.classList.contains('expanded')) $('#sheetArrow')?.click();
    if (!selectedCell) return;
    // A fresh draft IS the creation card: open its row for naming.
    try {
      const c = cellCenter(selectedCell);
      const q = await createQuest({ title: 'Untitled quest', lat: c.lat, lng: c.lng });
      openQuestId = q.id;
      await refreshQuests(true);
      focusEditedTile();
    } catch (e) {
      console.warn('[quest] create failed:', e?.message || e);
      toast('Quest create failed — try again.');
    }
  });
  $('#questSearchGo')?.addEventListener('click', () => {
    runQuestSearch().catch(() => {});
  });
  $('#questSearchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runQuestSearch().catch(() => {});
    }
    e.stopPropagation();
  });
  $('#recenterButton').addEventListener('click', () => {
    interruptDotSequence(true);
    mapView.recenter();
    // Explicit "take me home": unpin and show the live tile's card.
    selectionPinned = false;
    try { selectCell(mapView.cellUnderUser(), { src: 'recenter' }); } catch {}
    toast('Centered on your current tile.');
  });
  // Area-name tap logs debug info AND expands (no stopPropagation — swallowing
  // the tap is what made the card feel dead when users tap the title text).
  const tileInfoBtn = $('#tileInfoButton') || $('#areaName');
  tileInfoBtn?.addEventListener('click', () => {
    const snap = engine.getSnapshot();
    const info = mapView.inspectCell(snap.store, selectedCell);
    // Diagnostics tail: home-base prefix + location choice + last pull.
    // Quote this back if the home tile ever looks wrong.
    let diag = '';
    try {
      const pull = window.__tortlePull;
      diag = ` · base ${(snap.store.baseCell || '?').slice(0, 8)} · ${getLocationChoice() || 'no-choice'}` +
        (pull ? ` · cloud ${pull.cloudBase || 'none'}${pull.adoptedBase ? ' (adopted)' : ''}` : '');
    } catch {}
    // Last failing storage key, verbatim: compare against the Storage
    // dashboard object key. Any extra folder level = the whole bug.
    const lastFail = mediaErrors.length ? mediaErrors[mediaErrors.length - 1].path : null;
    toastDiag(`${info.status} · H3 ${info.cell} · ${progressPercent(info.rec)}% dwell${diag}${mediaErrors.length ? ` · mediaFails ${mediaErrors.length}${lastFail ? ` want ${lastFail}` : ''}` : ''} · tap toast to dismiss`);
  });
  // Tap-to-dismiss for the sticky diagnostic toast.
  $('#toast')?.addEventListener('click', () => {
    $('#toast')?.classList.remove('visible');
  });
  $('#leaderboardButton')?.addEventListener('click', () => {
    toast('Pilot leaderboard stays private to invited testers.');
  });
  // Unlocking section collapse
  const unlockingContent = $('#unlockingContent');
  const collapsedBar = $('#collapsedBar');
  const understoodBtn = $('#understoodBtn');
  const UNDERSTOOD_KEY = 'tortle.v0.unlockingDismissed';
  const setUnlockingCollapsed = (collapsed) => {
    if (!unlockingContent || !collapsedBar) return;
    unlockingContent.hidden = collapsed;
    collapsedBar.hidden = !collapsed;
    try { localStorage.setItem(UNDERSTOOD_KEY, collapsed ? '1' : ''); } catch {}
  };
  try {
    if (localStorage.getItem(UNDERSTOOD_KEY) === '1') setUnlockingCollapsed(true);
  } catch {}
  understoodBtn?.addEventListener('click', () => setUnlockingCollapsed(true));
  collapsedBar?.addEventListener('click', () => setUnlockingCollapsed(false));
  $('#profileButton').addEventListener('click', async () => {
    const email = currentUser?.email || 'Signed in';
    if (window.confirm(`${email}\n\nPersonal territory is never shared by default.\n\nOK = stay signed in\nCancel = sign out`)) {
      toast('Personal territory is never shared by default.');
      return;
    }
    try {
      await signOut();
    } finally {
      window.location.replace('./auth.html');
    }
  });

  // Avatar from Google profile (full name + photo), email-initial fallback.
  const meta = currentUser?.user_metadata || {};
  const displayName = meta.full_name || meta.name || currentUser?.email || 'A';
  const profileBtn = $('#profileButton');
  if (profileBtn) {
    if (meta.avatar_url || meta.picture) {
      const url = meta.avatar_url || meta.picture;
      profileBtn.textContent = '';
      profileBtn.style.backgroundImage = `url("${url}")`;
      profileBtn.style.backgroundSize = 'cover';
      profileBtn.style.backgroundPosition = 'center';
      profileBtn.setAttribute('aria-label', displayName);
    } else {
      profileBtn.textContent = displayName.trim().charAt(0).toUpperCase() || 'A';
    }
  }

  // Inline Voice capture (card itself) + fullscreen Camera + tile gallery
  const voiceArea = $('#voicePanel');
  let camStream = null, camMode = 'photo', camFacing = 'environment', camRecorder = null, camChunks = [], camPhotoBlob = null, camVideoBlob = null;
  let voiceStream = null, voiceRecorder = null, voiceChunks = [], voiceBlob = null, voiceTimer = null, voiceSec = 0;

  $('#viewerClose')?.addEventListener('click', () => { try { $('#mediaViewer').close(); } catch {} clearTimeout(vChromeTimer); const w = $('#viewerVideoWrap'); if (w) w.hidden = true; const v = $('#viewerVideo'); v.pause?.(); v.removeAttribute('src'); v.load?.(); const au = $('#viewerAudio'); au.pause?.(); au.removeAttribute('src'); });
  $('#viewerPrev')?.addEventListener('click', (e) => { e.stopPropagation(); showViewerIndex(viewerIndex - 1); });
  $('#viewerNext')?.addEventListener('click', (e) => { e.stopPropagation(); showViewerIndex(viewerIndex + 1); });
  // Gallery select + multi-delete.
  $('#gallerySelect')?.addEventListener('click', () => {
    gallerySelectMode = !gallerySelectMode;
    if (!gallerySelectMode) gallerySelected.clear();
    disarmDeleteConfirm();
    gallerySig = null; // force rebuild: checkboxes in, × buttons out (and back)
    renderTileGallery();
  });
  $('#galleryDeleteCancel')?.addEventListener('click', () => {
    exitGallerySelect();
    gallerySig = null;
    renderTileGallery();
  });
  $('#galleryDeleteConfirm')?.addEventListener('click', () => {
    const dc = $('#galleryDeleteConfirm');
    if (!dc || gallerySelected.size === 0) return;
    if (!dc.dataset.armed) {
      dc.dataset.armed = '1';
      dc.classList.add('armed');
      dc.textContent = `Tap again to delete ${gallerySelected.size}`;
      clearTimeout(deleteArmTimer);
      deleteArmTimer = setTimeout(disarmDeleteConfirm, 3000);
      return;
    }
    deleteGalleryItems([...gallerySelected]);
  });
  // Tap media toggles arrows (they auto-hide 1s after open)
  $('#viewerImg')?.addEventListener('click', () => {
    const prev = $('#viewerPrev');
    if (prev && !prev.hidden) hideNavNow(); else pokeNav();
  });
  // Custom video player wiring (replaces native controls).
  {
    const vid = $('#viewerVideo');
    const seek = $('#vSeek'), cur = $('#vCur'), dur = $('#vDur'), vol = $('#vVolume');
    let seeking = false;
    vid?.addEventListener('loadedmetadata', () => {
      if (dur && vid.duration) dur.textContent = fmtClock(vid.duration);
      if (cur) cur.textContent = fmtClock(vid.currentTime || 0);
    });
    vid?.addEventListener('timeupdate', () => {
      if (!vid.duration || seeking) return;
      if (seek) seek.value = String(Math.round((vid.currentTime / vid.duration) * 1000));
      if (cur) cur.textContent = fmtClock(vid.currentTime);
    });
    vid?.addEventListener('play', () => { setVPlayIcon(true); showVideoChrome(); });
    vid?.addEventListener('pause', () => { setVPlayIcon(false); clearTimeout(vChromeTimer); videoWrapEl()?.classList.add('visible'); });
    vid?.addEventListener('ended', () => { setVPlayIcon(false); clearTimeout(vChromeTimer); videoWrapEl()?.classList.add('visible'); });
    // Tap empty video area toggles the chrome.
    vid?.addEventListener('click', () => {
      if (videoChromeVisible()) { clearTimeout(vChromeTimer); videoWrapEl()?.classList.remove('visible'); }
      else showVideoChrome();
    });
    $('#vPlay')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!vid) return;
      if (vid.paused) vid.play().catch(() => {});
      else vid.pause();
    });
    $('#vBack10')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (vid) vid.currentTime = Math.max(0, vid.currentTime - 10);
      showVideoChrome();
    });
    $('#vFwd10')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (vid?.duration) vid.currentTime = Math.min(vid.duration, vid.currentTime + 10);
      showVideoChrome();
    });
    seek?.addEventListener('input', () => {
      if (vid?.duration) {
        vid.currentTime = (Number(seek.value) / 1000) * vid.duration;
        if (cur) cur.textContent = fmtClock(vid.currentTime);
      }
      showVideoChrome();
    });
    seek?.addEventListener('pointerdown', () => { seeking = true; });
    seek?.addEventListener('pointerup', () => { seeking = false; });
    seek?.addEventListener('change', () => { seeking = false; });
    vol?.addEventListener('input', () => {
      if (vid) vid.volume = Number(vol.value);
      showVideoChrome();
    });
  }
  // Gallery voice player: wave window + seek + Play/Pause/Stop, remain counts down
  {
    const aud = $('#viewerAudio'), track = $('#viewerAudioTrack'), fill = $('#viewerAudioFill'), remain = $('#viewerAudioRemain');
    $('#viewerAudioPlay')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!aud?.src) return;
      aud.play().catch(() => {});
      startPlayhead(aud, vBars);
    });
    $('#viewerAudioPause')?.addEventListener('click', (e) => { e.stopPropagation(); aud?.pause(); });
    $('#viewerAudioStop')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!aud) return;
      aud.pause();
      aud.currentTime = 0;
      stopPlayhead();
      vBars.forEach((b) => b.classList.remove('played'));
      if (fill) fill.style.width = '0%';
      if (remain && aud.duration) remain.textContent = fmtClock(aud.duration);
    });
    aud?.addEventListener('ended', () => {
      stopPlayhead();
      vBars.forEach((b) => b.classList.add('played'));
      if (fill) fill.style.width = '100%';
      if (remain) remain.textContent = '0:00';
    });
    aud?.addEventListener('timeupdate', () => {
      if (!aud.duration) return;
      if (fill) fill.style.width = `${(aud.currentTime / aud.duration) * 100}%`;
      if (remain) remain.textContent = fmtClock(aud.duration - aud.currentTime);
    });
    track?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!aud?.duration) return;
      const r = track.getBoundingClientRect();
      aud.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * aud.duration;
    });
  }
  {
    // Swipe between gallery items in the viewer
    let touchX = null;
    const dlg = $('#mediaViewer');
    dlg?.addEventListener('touchstart', (e) => { touchX = e.touches[0]?.clientX ?? null; }, { passive: true });
    dlg?.addEventListener('touchend', (e) => {
      if (touchX == null) return;
      const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX;
      touchX = null;
      if (Math.abs(dx) < 40) return;
      showViewerIndex(viewerIndex + (dx < 0 ? 1 : -1));
    }, { passive: true });
  }

  function stopCamStream() { try { camRecorder?.state === 'recording' && camRecorder.stop(); } catch {} try { camStream?.getTracks().forEach((t) => t.stop()); } catch {} camStream = null; const v = $('#camPreview'); if (v) v.srcObject = null; }
  async function openCamera(mode = 'photo') {
    camMode = mode; camPhotoBlob = camVideoBlob = null;
    closeVoiceArea();
    const dlg = $('#cameraSheet');
    document.querySelectorAll('.cam-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
    const review = $('#camReview'); review.hidden = true;
    const preview = $('#camPreview'); preview.hidden = false;
    $('#camSave').hidden = true; $('#camRetake').hidden = true;
    $('#camShutter').classList.remove('recording');
    try { dlg.showModal(); } catch {}
    await startCam();
  }
  async function startCam() {
    const preview = $('#camPreview');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no cam');
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: camFacing }, audio: camMode === 'video' });
      preview.srcObject = camStream;
    } catch {
      $('#camFile').click();
      closeCamera();
    }
  }
  function closeCamera() { stopCamStream(); try { $('#cameraSheet').close(); } catch {} }
  async function saveCamBlob() {
    const blob = camPhotoBlob || camVideoBlob; if (!blob) return;
    const pos = mapView.getUserLocation();
    if (!pos) { closeCamera(); return; }
    const { lat, lng } = pos;
    const cell = cellAt(lat, lng);
    const isVideo = blob.type.startsWith('video/');
    const activity = engine.logActivity({ title: isVideo ? 'Video memory' : 'Photo memory', category: selectedCategory, captureType: isVideo ? 'video' : 'photo', lat, lng, cell });
    const localUrl = URL.createObjectURL(blob);
    activity.localUrl = localUrl;
    const uid = (await import('./auth.js').then((m) => m.supabase.auth.getUser())).data.user?.id;
    const ext = blob.type.includes('webp') ? 'webp' : blob.type.includes('mp4') ? 'mp4' : isVideo ? 'webm' : 'jpg';
    const path = `${uid}/${activity.id}.${ext}`;
    try {
      const url = await uploadMedia(path, blob, blob.type);
      activity.media_url = url;
      activity.media_path = path;
      try { engine.persist(); } catch {}
    } catch (e) {
      console.warn('[media] upload failed, queued for retry', e?.message || e);
      mediaOutbox.push({ id: activity.id, path, blob });
    }
    closeCamera(); renderTileGallery(); renderHud();
  }
  document.querySelectorAll('.cam-tab').forEach((t) => t.addEventListener('click', async () => {
    camMode = t.dataset.tab;
    document.querySelectorAll('.cam-tab').forEach((x) => x.classList.toggle('active', x === t));
    camPhotoBlob = camVideoBlob = null;
    $('#camReview').hidden = true; $('#camPreview').hidden = false;
    $('#camSave').hidden = true; $('#camRetake').hidden = true;
    stopCamStream(); await startCam();
  }));
  $('#camClose')?.addEventListener('click', closeCamera);
  $('#camFlip')?.addEventListener('click', async () => { camFacing = camFacing === 'environment' ? 'user' : 'environment'; stopCamStream(); await startCam(); });
  $('#camRetake')?.addEventListener('click', () => { camPhotoBlob = camVideoBlob = null; $('#camReview').hidden = true; $('#camPreview').hidden = false; $('#camSave').hidden = true; $('#camRetake').hidden = true; $('#camShutter').classList.remove('recording'); });
  $('#camSave')?.addEventListener('click', saveCamBlob);
  $('#camFile')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.type.startsWith('video/')) camVideoBlob = f; else camPhotoBlob = await compressPhoto(f);
    const rev = $('#camReview'); rev.src = URL.createObjectURL(camPhotoBlob || camVideoBlob); rev.hidden = false;
    $('#camPreview').hidden = true; $('#camSave').hidden = false; $('#camRetake').hidden = false;
  });
  $('#camShutter')?.addEventListener('click', async () => {
    const preview = $('#camPreview');
    if (camMode === 'photo') {
      const canvas = document.createElement('canvas');
      canvas.width = preview.videoWidth; canvas.height = preview.videoHeight;
      canvas.getContext('2d').drawImage(preview, 0, 0);
      camPhotoBlob = await new Promise((r) => canvas.toBlob(r, pickPhotoMime(), 0.78));
      camVideoBlob = null;
      const rev = $('#camReview'); rev.src = URL.createObjectURL(camPhotoBlob); rev.hidden = false;
      preview.hidden = true; $('#camSave').hidden = false; $('#camRetake').hidden = false;
    } else {
      if (camRecorder && camRecorder.state === 'recording') { camRecorder.stop(); return; }
      camChunks = [];
      const mime = pickVideoMime();
      camRecorder = new MediaRecorder(camStream, mime ? { mimeType: mime } : undefined);
      camRecorder.ondataavailable = (ev) => { if (ev.data.size) camChunks.push(ev.data); };
      camRecorder.onstop = () => {
        camVideoBlob = new Blob(camChunks, { type: camRecorder.mimeType || 'video/webm' });
        const rev = $('#camReview'); rev.src = URL.createObjectURL(camVideoBlob); rev.hidden = false;
        preview.hidden = true; $('#camSave').hidden = false; $('#camRetake').hidden = false;
        $('#camShutter').classList.remove('recording');
      };
      camRecorder.start();
      $('#camShutter').classList.add('recording');
      setTimeout(() => { if (camRecorder?.state === 'recording') camRecorder.stop(); }, 30000);
    }
  });

  function showVoiceArea() {
    // Voice UI floats above the toolbar: the card stays exactly as it is.
    voiceCaptureOpen = true;
    const gal = $('#tileGallery'); if (gal) gal.hidden = true;
    const vgal = $('#voiceGallery'); if (vgal) vgal.hidden = true;
    if (voiceArea) voiceArea.hidden = false;
    layoutToolbar();
  }
  function closeVoiceArea() {
    try { stopWave(); } catch {}
    try { stopPlayhead(); } catch {}
    try { voiceRecorder?.state !== 'inactive' && voiceRecorder.stop(); } catch {}
    try { voiceStream?.getTracks().forEach((t) => t.stop()); } catch {}
    voiceStream = null; voiceBlob = null;
    clearInterval(voiceTimer); voiceSec = 0;
    const t = $('#voiceTimer'); if (t) t.textContent = '0:00';
    const a = $('#voiceAudio'); if (a) { try { a.pause(); } catch {} a.removeAttribute('src'); }
    $('#voiceSave').hidden = true; $('#voicePlay').hidden = true; $('#voiceStop').hidden = true;
    if (voiceArea) voiceArea.hidden = true;
    voiceCaptureOpen = false;
    try { renderTileGallery(); } catch {}
    layoutToolbar();
  }
  closeVoiceFn = closeVoiceArea;

  document.querySelectorAll('[data-capture]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.capture;
      if (type === 'photo') { openCamera('photo'); return; }
      if (type === 'voice') { showVoiceArea(); return; }
      if (type === 'session') {
        const snap = engine.getSnapshot();
        if (!snap.outing) {
          engine.startOuting();
          const here = mapView.getUserLocation();
          engine.dwell(cellAt(here.lat, here.lng), 0);
          // Label lives beside the button in .choice-item (not inside it).
          const bl = button.closest('.choice-item')?.querySelector('b');
          if (bl) bl.textContent = 'End outing';
          toast('Outing started. Tiles you enter now will all receive the Activity boost.');
          renderHud();
          return;
        }
        openDialog('session');
        return;
      }
      openDialog(type);
    });
  });

  $('#voiceClose')?.addEventListener('click', closeVoiceArea);
  // selectCell calls this on every tile switch (presence-only capture).
  dismissVoiceCapture = () => {
    const had = !!(voiceBlob || (voiceRecorder && voiceRecorder.state !== 'inactive'));
    closeVoiceArea();
    return had;
  };

  // Voice recorder: live mic wave while recording; decoded static wave +
  // clock playhead for preview playback (no live graph — fails silently).
  let waveCtx = null, waveAnalyser = null, waveRaf = 0, waveBars = [];
  function buildWaveBars() {
    const wave = $('#voiceWave');
    if (!wave) return;
    wave.innerHTML = '';
    waveBars = [];
    // Dynamic count: fill the recording window (3px bar + 2px gap each)
    const w = wave.clientWidth || wave.parentElement?.clientWidth || 200;
    const n = Math.max(12, Math.floor(w / 5));
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      wave.appendChild(s);
      waveBars.push(s);
    }
  }
  function stopWave() {
    cancelAnimationFrame(waveRaf);
    waveRaf = 0;
    try { waveCtx?.close(); } catch {}
    waveCtx = null; waveAnalyser = null;
  }
  function startWave(stream) {
    try {
      stopWave();
      buildWaveBars();
      waveCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = waveCtx.createMediaStreamSource(stream);
      waveAnalyser = waveCtx.createAnalyser();
      waveAnalyser.fftSize = 256;
      src.connect(waveAnalyser);
      const data = new Uint8Array(waveAnalyser.frequencyBinCount);
      const tick = () => {
        if (!waveAnalyser) return;
        waveAnalyser.getByteFrequencyData(data);
        const n = waveBars.length;
        for (let i = 0; i < n; i++) {
          const v = data[Math.floor((i / n) * data.length * 0.7)] / 255;
          waveBars[i].style.height = `${Math.max(3, Math.round(v * 26))}px`;
        }
        waveRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { console.warn('[voice] wave failed', e?.message || e); }
  }
  $('#voiceRec')?.addEventListener('click', async () => {
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunks = [];
      const mime = pickAudioMime();
      voiceRecorder = new MediaRecorder(voiceStream, mime ? { mimeType: mime } : undefined);
      voiceRecorder.ondataavailable = (e) => { if (e.data.size) voiceChunks.push(e.data); };
      voiceRecorder.onstop = () => {
        voiceBlob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
        const a = $('#voiceAudio'); a.src = URL.createObjectURL(voiceBlob); a.hidden = false;
        $('#voiceSave').hidden = false; $('#voicePlay').hidden = false;
        clearInterval(voiceTimer);
        stopWave();
        // Static truthful wave from decoded peaks; playhead animates on Play
        decodePeaks(voiceBlob, waveBars.length).then((peaks) => {
          paintPeaks(waveBars, peaks, 24);
        });
      };
      voiceRecorder.start();
      startWave(voiceStream);
      $('#voiceRec').hidden = true; $('#voiceStop').hidden = false;
      voiceSec = 0; const timer = $('#voiceTimer');
      voiceTimer = setInterval(() => { voiceSec++; if (timer) timer.textContent = `${Math.floor(voiceSec/60)}:${String(voiceSec%60).padStart(2,'0')}`; if (voiceSec >= 120) voiceRecorder.stop(); }, 1000);
    } catch (e) { console.warn('[voice] mic denied', e?.message || e); }
  });
  $('#voiceStop')?.addEventListener('click', () => { try { voiceRecorder.stop(); } catch {} $('#voiceStop').hidden = true; $('#voiceRec').hidden = false; voiceStream?.getTracks().forEach((t) => t.stop()); clearInterval(voiceTimer); stopWave(); });
  $('#voicePlay')?.addEventListener('click', () => {
    const a = $('#voiceAudio');
    if (!a) return;
    if (a.paused) { a.play().catch(() => {}); startPlayhead(a, waveBars); }
    else { a.pause(); }
  });
  $('#voiceAudio')?.addEventListener('ended', () => {
    stopPlayhead();
    waveBars.forEach((b) => b.classList.add('played'));
  });
  $('#voiceSave')?.addEventListener('click', async () => {
    if (!voiceBlob) return;
    // Presence re-validated at save: a recorder that outlived its tile
    // (switch closed it already — this is the backstop) saves nothing.
    try {
      const here = mapView.getUserLocation();
      if (!here || cellAt(here.lat, here.lng) !== selectedCell) {
        toast('Go to this tile to save a voice note.');
        return;
      }
    } catch {
      toast('Go to this tile to save a voice note.');
      return;
    }
    // Voice belongs to the tile underfoot (== selected while recording).
    const cell = selectedCell;
    const c = cellCenter(cell);
    const { lat, lng } = { lat: c.lat, lng: c.lng };
    const activity = engine.logActivity({ title: 'Voice memory', category: selectedCategory, captureType: 'voice', lat, lng, cell });
    const uid = (await import('./auth.js').then((m) => m.supabase.auth.getUser())).data.user?.id;
    const ext = voiceBlob.type.includes('mp4') ? 'm4a' : 'webm';
    const path = `${uid}/${activity.id}.${ext}`;
    try {
      const url = await uploadMedia(path, voiceBlob, voiceBlob.type);
      const idx = engine.getSnapshot().store.activities.findIndex((a) => a.id === activity.id);
      if (idx !== -1) {
        engine.getSnapshot().store.activities[idx].media_url = url;
        engine.getSnapshot().store.activities[idx].media_path = path;
        try { engine.persist(); } catch {}
      }
    } catch (e) {
      console.warn('[media] voice upload failed, queued for retry', e?.message || e);
      mediaOutbox.push({ id: activity.id, path, blob: voiceBlob });
    }
    closeVoiceArea(); renderHud();
  });

  document.querySelectorAll('[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-category]').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
      selectedCategory = button.dataset.category;
    });
  });

  $('#activityForm').addEventListener('submit', (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const title = $('#activityTitle').value.trim() || 'Untitled outing';
    const pos = mapView.getUserLocation();
    if (!pos) { $('#activityDialog').close(); return; }
    const { lat, lng } = pos;
    const cell = cellAt(lat, lng);
    if (captureType === 'session') {
      engine.endOuting();
      const outingBtn = document.querySelector('[data-capture="session"]');
      const ol = outingBtn.closest('.choice-item')?.querySelector('b');
      if (ol) ol.textContent = 'Outing';
    }
    engine.logActivity({
      title,
      category: selectedCategory,
      captureType,
      lat,
      lng,
      cell,
    });
    $('#activityDialog').close();
    $('#activityTitle').value = '';
    renderHud();
    toast('Activity saved — every touched tile received a boost.');
  });

  // Tile naming: Save writes the record (+ cloud outbox via flush); an
  // empty save opens the Keep/Change dialog instead of saving a blank.
  const saveTileTitle = (name) => {
    if (!selectedCell) return;
    engine.setTileName(selectedCell, name);
    lastTitleCell = selectedCell;
    showTitleView(name);
    $('#tileTitleInput')?.blur();
  };
  $('#tileTitleSave')?.addEventListener('click', () => {
    const input = $('#tileTitleInput');
    if (!input || !selectedCell) return;
    // Quest mode has no summary field anymore (creation lives in the row).
    if (questMode) return;
    // View mode: the button reads Edit Title — reopen the field instead.
    if (input.hidden) {
      showTitleEdit($('#tileTitleDisplay')?.textContent || '');
      input.focus();
      try { input.select(); } catch {}
      return;
    }
    const val = (input.value || '').trim();
    if (val) { saveTileTitle(val); return; }
    const city = areasDbg.regionLabel();
    const copy = $('#titleDialogCopy');
    if (copy) copy.textContent = `You didn't give this tile a title. Keep "${city}" as the title, or change it to something more personal?`;
    try { $('#titleDialog').showModal(); } catch {}
  });
  $('#tileTitleInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#tileTitleSave')?.click(); }
    e.stopPropagation();
  });
  $('#titleKeepBtn')?.addEventListener('click', () => {
    try { $('#titleDialog').close(); } catch {}
    saveTileTitle(areasDbg.regionLabel());
  });
  $('#titleChangeBtn')?.addEventListener('click', () => {
    try { $('#titleDialog').close(); } catch {}
    showTitleEdit('');
    const input = $('#tileTitleInput');
    if (input) input.focus();
  });
}

// Dot attention loop (browse mode only): 15s dimmed-wait → 100% visible →
// 1s hold → 2s bounce → 2s pulse → 3s solid → fade to 30% → loop.
// Any map gesture or dot tap destroys the run (new wait starts on gestures);
// follow mode never runs it.
const DOT_WAIT_MS = 15 * 1000;
let dotSeq = 0;
let dotTimer = 0;
// Interrupt from anywhere in the sequence: timers die, anims clear, and the
// dot jumps to its fade — 30% when browsed away, full view when back on the
// live tile (recenter/dot-tap already restored follow underneath).
function interruptDotSequence(toLive = false) {
  dotSeq++;
  clearTimeout(dotTimer);
  try { mapView.setPuckAnim(''); } catch {}
  try { mapView.setPuckDimmed(!toLive); } catch {}
}
function scheduleDotAttention() {
  clearTimeout(dotTimer);
  const g = ++dotSeq;
  try { mapView.setPuckAnim(''); } catch {}
  dotTimer = window.setTimeout(() => runDotAttention(g), DOT_WAIT_MS);
}
function runDotAttention(g) {
  if (g !== dotSeq) return;
  try {
    if (!mapView || mapView.isFollowing()) return;
    mapView.setPuckDimmed(false);
  } catch { return; }
  dotTimer = window.setTimeout(() => {
    if (g !== dotSeq) return;
    try { mapView.setPuckAnim('bouncing'); } catch {}
    dotTimer = window.setTimeout(() => {
      if (g !== dotSeq) return;
      try { mapView.setPuckAnim('pulsing'); } catch {}
      dotTimer = window.setTimeout(() => {
        if (g !== dotSeq) return;
        try { mapView.setPuckAnim(''); } catch {}
        dotTimer = window.setTimeout(() => {
          if (g !== dotSeq) return;
          try { mapView.setPuckDimmed(true); } catch {}
          scheduleDotAttention();
        }, 3000);
      }, 2000);
    }, 2000);
  }, 1000);
}

function tick() {
  engine.expireOutingIfNeeded();
  if (tracking && !locationFilter.frozen) {
    const now = performance.now();
    const dt = now - lastDwellAt;
    lastDwellAt = now;
    const pos = mapView.getUserLocation();
    if (!pos) return;
    const cell = cellAt(pos.lat, pos.lng);
    // Quest mode accrues to the quest ledger only — regular tiles, streak,
    // and base stay untouched.
    if (questMode) engine.dwellQuest(cell, dt);
    else engine.dwell(cell, dt);
    renderHud();
  } else {
    lastDwellAt = performance.now();
  }
}

// Location gate: no implicit Hyderabad. Force prompt unless explicit ?region=
// or a prior explicit choice exists. The choice is PER-USER (suffixed with
// the auth uid) — a device-level key let one account's Share suppress the
// gate for the next account, planting it on the Ramgopalpet default.
// The legacy device-level value is ignored and deleted on boot.
const LOCATION_CHOICE_PREFIX = 'tortle.v0.locationChoice';
function choiceKey() {
  const uid = currentUser?.id || null;
  return uid ? `${LOCATION_CHOICE_PREFIX}.${uid}` : LOCATION_CHOICE_PREFIX;
}
function getLocationChoice() {
  try { return localStorage.getItem(choiceKey()); } catch { return null; }
}
function setLocationChoice(v) {
  try { localStorage.setItem(choiceKey(), v); } catch {}
}
try { localStorage.removeItem(LOCATION_CHOICE_PREFIX); } catch {}
// True while the gate dialog is open: the card stays neutral (no default
// area name) and presence is forced false so no capture can arm.
let gateOpen = false;
function hasRealBase() {
  return !!engine.getSnapshot().store.baseCell;
}
function needsGate() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('region')) return false;
  const choice = getLocationChoice();
  if (choice?.startsWith('city:')) return false;
  // 'granted' only counts with a real located base — a stale granted
  // with no base means "never actually located", so gate.
  if (choice === 'granted' && hasRealBase()) return false;
  return true;
}
function guessCountry() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz.includes('Kolkata') || tz.includes('Asia/')) return 'IN';
    if (tz.includes('New_York') || tz.includes('America/')) return 'US';
  } catch {}
  return null;
}
function renderCityCards(filter) {
  const wrap = $('#gateCards');
  if (!wrap) return;
  wrap.innerHTML = '';
  const regions = filter === 'IN' ? ['hyd'] : filter === 'US' ? ['nyc'] : ['hyd', 'nyc'];
  for (const r of regions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'city-card';
    btn.dataset.region = r;
    const label = areasDbg.regionLabel(r);
    const count = r === 'nyc' ? '262 NTAs' : '145 wards';
    btn.innerHTML = `<span><b>${label}</b><small>${count} · ${r === 'nyc' ? 'USA' : 'India'}</small></span><span>→</span>`;
    btn.addEventListener('click', async () => {
      setLocationChoice(`city:${r}`);
      setRegion(r, { persist: true });
      activeRegion = r;
      hideGate();
      await postGateSetup(r);
    });
    wrap.appendChild(btn);
  }
}
function showGateState(which) {
  $('#gatePrompt').hidden = which !== 'prompt';
  $('#gatePicker').hidden = which !== 'picker';
  $('#gateLoading').hidden = which !== 'loading';
}
function hideGate() {
  gateOpen = false;
  const dlg = $('#locationGate');
  try { dlg.close(); } catch {}
  dlg.hidden = true;
}
async function showLocationGate() {
  const dlg = $('#locationGate');
  if (!dlg) return;
  dlg.hidden = false;
  showGateState('prompt');
  try { dlg.showModal(); } catch { dlg.setAttribute('open',''); }
  // Bind once
  if (!dlg.dataset.bound) {
    dlg.dataset.bound = '1';
    $('#gateShareBtn')?.addEventListener('click', async () => {
      showGateState('loading');
      const gateErr = $('#gateError');
      if (gateErr) gateErr.hidden = true;
      if (!navigator.geolocation) {
        renderCityCards(guessCountry());
        showGateState('picker');
        return;
      }
      const grantFromFix = async (lat, lng) => {
        const region = regionForPoint(lat, lng);
        setLocationChoice('granted');
        setRegion(region, { persist: true });
        activeRegion = region;
        engine.setBase(lat, lng);
        locationFilter.lastGood = { lat, lng };
        hideGate();
        await postGateSetup(region, { lat, lng, fly: true });
        setTracking(true);
      };
      const fallToPicker = () => {
        renderCityCards(guessCountry());
        showGateState('picker');
      };
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          await grantFromFix(pos.coords.latitude, pos.coords.longitude);
        },
        (err) => {
          const code = err && typeof err.code === 'number' ? err.code : -1;
          if (code === 1) {
            // Denied (or PWA-silenced): stay on the prompt with guidance —
            // never silently dump to the picker.
            showGateState('prompt');
            probeGeoPermission('gate-denied');
            if (gateErr) {
              gateErr.textContent = locationGuidance();
              gateErr.hidden = false;
            }
            return;
          }
          // Transient: one relaxed retry (coarse fix, generous timeout),
          // then the picker with an honest note.
          navigator.geolocation.getCurrentPosition(
            async (pos) => {
              await grantFromFix(pos.coords.latitude, pos.coords.longitude);
            },
            () => {
              // Still nothing: the picker is the honest fallback.
              fallToPicker();
            },
            { enableHighAccuracy: false, timeout: 30000, maximumAge: 60000 },
          );
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
      );
    });
    $('#gatePickBtn')?.addEventListener('click', () => {
      renderCityCards(guessCountry());
      showGateState('picker');
    });
    $('#gateBackBtn')?.addEventListener('click', () => showGateState('prompt'));
  }
}
let activeRegion = 'hyd';
let gatePending = null;
{
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('region');
  if (explicit) {
    activeRegion = explicit;
    setRegion(activeRegion, { persist: true });
    setLocationChoice(`city:${explicit}`);
  } else if (getLocationChoice()?.startsWith('city:')) {
    activeRegion = getLocationChoice().split(':')[1];
    setRegion(activeRegion, { persist: false });
  } else if (getLocationChoice() === 'granted' && savedRegion()) {
    activeRegion = savedRegion();
    setRegion(activeRegion, { persist: false });
  } else if (savedRegion() && !needsGate()) {
    activeRegion = savedRegion();
    setRegion(activeRegion, { persist: false });
  } else if (!needsGate()) {
    const baseCell = engine.getSnapshot().store.baseCell;
    if (baseCell) {
      const base = cellCenter(baseCell);
      activeRegion = regionForPoint(base.lat, base.lng);
    }
    setRegion(activeRegion, { persist: false });
  } else {
    // Gate will decide; keep hyd as placeholder for map init (not shown as user loc)
    setRegion('hyd', { persist: false });
    gateOpen = true;
    gatePending = showLocationGate();
  }
  console.log(`[region] active=${activeRegion} gatePending=${!!gatePending} saved=${savedRegion()} choice=${getLocationChoice()}`);
  // Boot log (last 5): conclusive reading if the base ever looks wrong.
  // Quoted back via the area-name tap toast — no console needed.
  try {
    const log = JSON.parse(localStorage.getItem('tortle.v0.bootlog') || '[]');
    log.push({
      t: new Date().toISOString().slice(5, 19),
      uid: (currentUser?.id || '?').slice(0, 8),
      choice: getLocationChoice(),
      gate: !!gatePending,
      base: (engine.getSnapshot().store.baseCell || '?').slice(0, 8),
    });
    localStorage.setItem('tortle.v0.bootlog', JSON.stringify(log.slice(-5)));
  } catch {}
}
async function postGateSetup(region, opts = {}) {
  await areasDbg.loadCore();
  if (opts.lat != null) {
    mapView.setUserLocation(opts.lng, opts.lat, { fly: !!opts.fly });
    if (opts.fly) mapView.map.setCenter([opts.lng, opts.lat]);
  } else {
    const [lng, lat] = regionCenter();
    mapView.setUserLocation(lng, lat);
    mapView.map.setCenter([lng, lat]);
    mapView.map.setZoom(region === 'nyc' ? 10 : 12);
    engine.setBase(lat, lng);
  }
  mapView.paint(engine.getSnapshot().store);
  selectCell(mapView.cellUnderUser(), { src: 'boot' });
  const credit = $('#dataCredit');
  if (credit) credit.textContent = areasDbg.regionCredit();
  // Push the fresh grant/city base to the cloud NOW (don't wait 30s — a
  // quick close used to leave a stale cloud row behind).
  flush(engine).catch(() => {});
  interruptDotSequence(true);
}
/** Swap the active region's packs and repaint. Districts lazy-load on zoom. */
let regionSwitching = false;
async function switchRegion(next) {
  if (regionSwitching || areasDbg.getRegion() === next) return;
  regionSwitching = true;
  try {
    areasDbg.setRegion(next);
    await areasDbg.loadCore();
    activeRegion = next;
    updateCityTitle();
    mapView.paint(engine.getSnapshot().store);
    // Quest availability follows the region.
    refreshQuests().catch(() => {});
    // New region, new live context: drop any pinned selection.
    selectionPinned = false;
    lastLiveCell = null;
    liveCandidate = null;
    liveCandidateHits = 0;
    selectCell(mapView.cellUnderUser(), { src: 'region' });
    const credit = $('#dataCredit');
    if (credit) credit.textContent = areasDbg.regionCredit();
    // New map context: restart the attention clock if still browsed.
    interruptDotSequence(false);
    try { if (!mapView.isFollowing()) scheduleDotAttention(); } catch {}
    console.log(`[region] switched to ${next}`);
  } finally {
    regionSwitching = false;
  }
}

/** GPS-driven region follow (real travel). Sandbox manages its own region. */
function autoRegion(lat, lng) {
  const next = regionForPoint(lat, lng);
  if (next !== areasDbg.getRegion()) {
    switchRegion(next);
    toast(next === 'nyc' ? 'Welcome to New York — loading local tiles.' : 'Welcome home — loading Hyderabad tiles.');
  }
}

await mapView.ready();
if (gatePending) {
  // Gate is blocking — don't seed a Hyderabad default. Picker/share will
  // call postGateSetup which sets the real center and selects the cell.
  engine.subscribe(() => mapView.paint(engine.getSnapshot().store));
} else {
  if (activeRegion === 'nyc') {
    const [lng, lat] = regionCenter();
    mapView.setUserLocation(lng, lat);
    mapView.map.setCenter([lng, lat]);
    mapView.map.setZoom(10);
  } else {
    // No gate: restore the last located base, or show the region center
    // on camera only — the user pointer stays unset until a real fix.
    const baseCell = engine.getSnapshot().store.baseCell;
    const restored = (getLocationChoice() === 'granted' || getLocationChoice()?.startsWith('city:')) && !!baseCell;
    if (restored) {
      const base = cellCenter(baseCell);
      mapView.setUserLocation(base.lng, base.lat);
      mapView.map.setCenter([base.lng, base.lat]);
    } else {
      const [lng, lat] = regionCenter();
      mapView.map.setCenter([lng, lat]);
    }
  }
  engine.subscribe(() => mapView.paint(engine.getSnapshot().store));
}
// Cloud bootstrap (silent-local on failure): seed local history, push it up,
// pull canonical state — then repaint from merged totals.
await bootstrap(engine);
{
  // Diagnostic snapshot: pack loadout + lookup sanity at map center.
  const c = mapView.map.getCenter();
  const nAreas = areasDbg.getPack('areas')?.length || 0;
  const nDistricts = areasDbg.getPack('districts')?.length || 0;
  const area = areasDbg.areaAt(c.lng, c.lat);
  const dist = areasDbg.districtAt(c.lng, c.lat);
  console.log(
    `[region] packs areas=${nAreas} districts=${nDistricts} ` +
      `zoom=${mapView.map.getZoom().toFixed(2)} center=${c.lng.toFixed(3)},${c.lat.toFixed(3)} ` +
      `area=${area?.id || 'none'} district=${dist?.id || 'none'}`,
  );
}
if (!gatePending) {
  const bootCell = mapView.cellUnderUser();
  if (bootCell) selectCell(bootCell, { src: 'boot' });
}
bindUi();
// If gated, re-run select after picker/share picks a city — postGateSetup handles it.
// Add a helper on window to re-trigger gate (for manual city switch later)
window.__tortleGate = { show: showLocationGate, choice: getLocationChoice };
// Superadmin escape hatch: the TILT pill re-opens the location gate (re-share
// GPS or switch city). The pill doesn't exist for non-superadmins, so there
// is zero prod surface. Fixes a stuck city choice with no other UI to redo it.
$('#tiltLevel')?.addEventListener('click', async () => {
  if (!superadminUser) return;
  gateOpen = true;
  renderHud(); // neutral card behind the gate
  try { await showLocationGate(); } catch {}
});
setupJoystick({
  mapView,
  engine,
  selectCell,
  toast,
  getRegion: areasDbg.getRegion,
  switchRegion,
  enabled: adminUser,
});
// Quest maker dock: admin+ only (everyone else never sees the button).
if (adminUser) {
  const qd = $('#questDock');
  if (qd) qd.hidden = false;
}
{
  const credit = $('#dataCredit');
  if (credit) credit.textContent = regionCredit();
}
renderHud();
mapView.paint(engine.getSnapshot().store);
// Quest availability for the active region (framework cut).
refreshQuests().catch(() => {});
setInterval(tick, 1000);
// Push the delta outbox on a cadence + whenever the app hides. Pulls stay
// launch-only per V0 scope. Failed media uploads retry on the same cadence.
setInterval(() => {
  flush(engine);
  flushMediaOutbox(engine).then(() => renderHud()).catch(() => {});
}, CONFIG.syncIntervalMs);
window.addEventListener('pagehide', () => {
  flush(engine);
});
window.addEventListener('resize', () => {
  try { layoutToolbar(); } catch {}
  try { layoutCardLimit(); } catch {}
});
try {
  window.__tortleBoot = {
    ok: true,
    at: new Date().toISOString(),
    user: currentUser?.email || null,
    hasName: !!(currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name),
    region: activeRegion,
  };
} catch {}
toast('Hex fog is H3 resolution 9 — each tile is a real ~174m cell.');
