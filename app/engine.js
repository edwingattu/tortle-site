import * as h3 from 'https://esm.sh/h3-js@4.5.0';
import { CONFIG } from './config.js';

const STORAGE_PREFIX = 'tortle.v0.hex-progress';
// One-time prefix migration Tourtle→Tortle: renames every tourtle.* key to
// tortle.* (copy-if-absent, then delete the old). Runs before any read, so
// no tiles, region, choices, or logs are lost in the rename.
export function migrateStoragePrefix() {
  try {
    const ren = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tourtle.')) ren.push(k);
    }
    for (const k of ren) {
      const nk = 'tortle.' + k.slice('tourtle.'.length);
      try {
        if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k));
      } catch {}
      try { localStorage.removeItem(k); } catch {}
    }
  } catch {}
}
// Per-user stores: localStorage is per-browser, not per-user. A shared key let
// a second login inherit the first user's tiles + media. Namespace by uid;
// one-time legacy move (not copy) for pre-upgrade devices.
function storageKeyFor(userId) {
  return userId ? `${STORAGE_PREFIX}.${userId}` : STORAGE_PREFIX;
}

export function cellAt(lat, lng, res = CONFIG.h3Resolution) {
  return h3.latLngToCell(lat, lng, res);
}

export function cellCenter(cell) {
  const [lat, lng] = h3.cellToLatLng(cell);
  return { lat, lng };
}

export function cellBoundary(cell) {
  const ring = h3.cellToBoundary(cell, true);
  if (!ring.length) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring;
}

export function neighbors(cell) {
  return h3.gridDisk(cell, 1).filter((id) => id !== cell);
}

export function diskCells(cell, k) {
  return h3.gridDisk(cell, k);
}

export function cellsForPolygon(latLngLoop, res = CONFIG.h3Resolution) {
  try {
    return h3.polygonToCells([latLngLoop], res);
  } catch {
    return [];
  }
}

export function parentCell(cell, res) {
  return h3.cellToParent(cell, res);
}

export function childrenOf(cell, res) {
  return h3.cellToChildren(cell, res);
}

export function cellResolution(cell) {
  return h3.getResolution(cell);
}

export function gridDistance(a, b) {
  try {
    return h3.gridDistance(a, b);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function coverageUniverse(originCell) {
  return h3.gridDisk(originCell, CONFIG.coverageRingK);
}

export function cellsInBounds(bounds, res = CONFIG.h3Resolution) {
  const pad = 0.002;
  const n = Math.min(bounds.getNorth() + pad, 85);
  const s = Math.max(bounds.getSouth() - pad, -85);
  const e = bounds.getEast() + pad;
  const w = bounds.getWest() - pad;
  try {
    return h3.polygonToCells(
      [
        [n, w],
        [n, e],
        [s, e],
        [s, w],
      ],
      res,
    );
  } catch {
    return [];
  }
}

export function destinationPoint(lat, lng, bearingDeg, meters) {
  const r = 6371000;
  const br = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const δ = meters / r;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(br));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(br) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 };
}

export function bearingBetween(aLat, aLng, bLat, bLng) {
  const φ1 = (aLat * Math.PI) / 180;
  const φ2 = (bLat * Math.PI) / 180;
  const Δλ = ((bLng - aLng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function emptyStore() {
  return {
    version: 1,
    tiles: {},
    activities: [],
    streakDays: 0,
    lastActiveDate: null,
    // Mutation revision: bumped on every tile change. The rollup memo in
    // areas.js recomputes only when this moves (pan/zoom paints reuse).
    rev: 0,
    outing: null,
    // Home tile: null until a real location lands (GPS grant or explicit
    // city choice). There is no silent fallback — never a default street.
    baseCell: null,
    // Cloud outbox: per-cell deltas not yet pushed (cleared only after the
    // server confirms). Survives reloads and crashes inside localStorage.
    pending: {},
    // Sandbox ledger (joystick diagnostics): per-cell gains accrued while
    // sandboxMode was on. Persisted so a reload can't launder them into a
    // push — bootstrap rolls them back before any seed or upload.
    sandbox: {},
    // ISO timestamp of the newest activity already pushed to the cloud.
    activityCursor: null,
    // Delete tombstones: ids that must never be re-pushed or re-pulled.
    // pendingDeletes is the unsent outbox (cleared on flush success);
    // deletedIds persists so launch-pulls can't resurrect deleted rows.
    pendingDeletes: [],
    deletedIds: [],
  };
}

// Tombstone caps: bounded so the lists can't grow without limit.
const MAX_DELETED_IDS = 1000;

function ensureTile(store, cell) {
  if (!store.tiles[cell]) {
    store.tiles[cell] = { dwellMs: 0, boostMs: 0, firstSeenAt: Date.now(), unlockedAt: null };
  }
  return store.tiles[cell];
}

export function tileProgress(rec) {
  if (!rec) return 0;
  return rec.dwellMs + rec.boostMs;
}

export function isUnlocked(rec) {
  if (!rec) return false;
  if (rec.unlockedAt) return true;
  return tileProgress(rec) >= CONFIG.dwellThresholdMs;
}

export function tileStatus(cell, store, neighborOfUnlocked) {
  const rec = store.tiles[cell];
  if (isUnlocked(rec)) return 'unlocked';
  if (rec || neighborOfUnlocked.has(cell)) return 'activated';
  return 'unclaimed';
}

export function unlockedNeighborSet(store) {
  const set = new Set();
  for (const [cell, rec] of Object.entries(store.tiles)) {
    if (!isUnlocked(rec)) continue;
    for (const n of h3.gridDisk(cell, 1)) set.add(n);
  }
  return set;
}

function maybeUnlock(rec) {
  if (!rec.unlockedAt && tileProgress(rec) >= CONFIG.dwellThresholdMs) {
    rec.unlockedAt = Date.now();
    return true;
  }
  return false;
}

function bumpStreak(store) {
  const today = todayKey();
  if (store.lastActiveDate === today) return;
  const yesterday = todayKey(new Date(Date.now() - 86400000));
  store.streakDays = store.lastActiveDate === yesterday ? store.streakDays + 1 : 1;
  store.lastActiveDate = today;
}

export function createEngine(userId = null) {
  migrateStoragePrefix();
  const STORAGE_KEY = storageKeyFor(userId);
  let store = emptyStore();
  try {
    let raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '');
    if ((!raw || !raw.tiles) && userId) {
      // Adopt the pre-upgrade shared cache once, then delete it so the next
      // login on this browser can't inherit it.
      const legacy = JSON.parse(localStorage.getItem(STORAGE_PREFIX) || '');
      if (legacy?.version === 1 && legacy.tiles) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
          localStorage.removeItem(STORAGE_PREFIX);
        } catch {}
        raw = legacy;
      }
    }
    if (raw?.version === 1 && raw.tiles) store = { ...emptyStore(), ...raw };
    // One-time purge: pre-kill stores were born on a silent fallback tile.
    // That fallback is gone — nulling it forces the location gate instead
    // of rolling the user back onto a street they never stood on.
    try {
      if (store.baseCell === cellAt(17.4375, 78.4867)) store.baseCell = null;
    } catch {}
  } catch {
    /* first run */
  }

  const listeners = new Set();
  // Joystick diagnostics flag: touches accrue locally but are ledgered for
  // rollback and excluded from outbox, outing, streak, and activity uploads.
  let sandboxMode = false;
  const emit = (extra = {}) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      /* quota */
    }
    const snapshot = getSnapshot();
    listeners.forEach((fn) => fn(snapshot, extra));
  };

  function getSnapshot() {
    const unlocked = Object.entries(store.tiles)
      .filter(([, rec]) => isUnlocked(rec))
      .map(([cell]) => cell);
    const universe = store.baseCell ? coverageUniverse(store.baseCell) : [];
    const coverage = universe.length
      ? Math.round((unlocked.filter((c) => universe.includes(c)).length / universe.length) * 100)
      : 0;
    return {
      store,
      unlockedCount: unlocked.length,
      coverage,
      streakDays: store.streakDays,
      activities: store.activities,
      outing: store.outing,
      baseCell: store.baseCell,
    };
  }

  function touchCell(cell, { dwellMs = 0, boostMs = 0 } = {}) {
    const rec = ensureTile(store, cell);
    const prevExisted = rec.dwellMs > 0 || rec.boostMs > 0 || !!rec.unlockedAt;
    const prevUnlockedAt = rec.unlockedAt;
    rec.dwellMs += dwellMs;
    // Boosts never bank: only the seconds still needed toward unlock are
    // farmed from the boost, the rest is discarded. Post-unlock boosts are
    // inconsequential (room is zero or negative).
    const boostBefore = rec.boostMs;
    if (boostMs > 0) {
      const room = CONFIG.dwellThresholdMs - rec.dwellMs - rec.boostMs;
      rec.boostMs += Math.max(0, Math.min(boostMs, room));
    }
    const appliedBoost = rec.boostMs - boostBefore;
    if (sandboxMode) {
      // Sandbox (joystick diagnostics): visible locally, never cloud-bound.
      // Gains ledger for rollback; outbox, outing, and streak stay untouched.
      if (dwellMs > 0 || appliedBoost > 0) {
        const s =
          store.sandbox[cell] ||
          (store.sandbox[cell] = { dwell: 0, boost: 0, prevUnlockedAt, prevExisted });
        s.dwell += dwellMs;
        s.boost += appliedBoost;
      }
    } else if (dwellMs > 0 || appliedBoost > 0) {
      // Record exactly what landed as an unsent delta for the cloud outbox.
      const p = store.pending[cell] || (store.pending[cell] = { dwell: 0, boost: 0 });
      p.dwell += dwellMs;
      p.boost += appliedBoost;
    }
    const unlockedNow = maybeUnlock(rec);
    if (dwellMs > 0 || appliedBoost > 0 || unlockedNow) {
      store.rev = (store.rev || 0) + 1;
    }
    if (!sandboxMode) {
      if (store.outing) {
        if (!store.outing.touched.includes(cell)) store.outing.touched.push(cell);
        store.outing.lastTouchAt = Date.now();
      }
      bumpStreak(store);
    }
    return { rec, unlockedNow, cell };
  }

  return {
    getSnapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setBase(lat, lng) {
      store.baseCell = cellAt(lat, lng);
      emit();
    },
    dwell(cell, ms) {
      const result = touchCell(cell, { dwellMs: ms });
      emit({ type: 'dwell', ...result });
      return result;
    },
    boostCells(cells, ms = CONFIG.activityBoostMs) {
      const unlocked = [];
      cells.forEach((cell) => {
        const result = touchCell(cell, { boostMs: ms });
        if (result.unlockedNow) unlocked.push(cell);
      });
      emit({ type: 'boost', cells, unlocked });
      return unlocked;
    },
    // ---- Sandbox (joystick diagnostics): temporary by construction ----
    isSandbox() {
      return sandboxMode;
    },
    setSandbox(on) {
      sandboxMode = !!on;
      // Leaving sandbox wipes its gains back out of local totals.
      if (!sandboxMode) return this.rollbackSandbox();
      return false;
    },
    rollbackSandbox() {
      const ledger = store.sandbox || {};
      const cells = Object.keys(ledger);
      if (!cells.length) return false;
      for (const cell of cells) {
        const s = ledger[cell];
        const rec = store.tiles[cell];
        if (rec) {
          rec.dwellMs = Math.max(0, rec.dwellMs - (s.dwell || 0));
          rec.boostMs = Math.max(0, rec.boostMs - (s.boost || 0));
          if (rec.unlockedAt && !s.prevUnlockedAt && tileProgress(rec) < CONFIG.dwellThresholdMs) {
            rec.unlockedAt = null;
          }
          if (!s.prevExisted && rec.dwellMs <= 0 && rec.boostMs <= 0 && !rec.unlockedAt) {
            delete store.tiles[cell];
          }
        }
      }
      store.sandbox = {};
      store.rev = (store.rev || 0) + 1;
      emit();
      return true;
    },
    // ---- Cloud sync helpers (delta-additive merge) ----
    // Pending deltas, keyed by cell. The caller pushes them, then marks
    // pushed (or requeues on failure — never silently dropped).
    getPending() {
      return store.pending;
    },
    markPushed(cells, amounts = {}) {
      // Subtract exactly what was confirmed, so dwell/boost that landed
      // mid-upload stays pending instead of being silently dropped.
      for (const cell of cells) {
        const p = store.pending[cell];
        if (!p) continue;
        p.dwell = Math.max(0, p.dwell - (amounts[cell]?.dwell || 0));
        p.boost = Math.max(0, p.boost - (amounts[cell]?.boost || 0));
        // Sub-ms dust (fractional leftovers of rounded sends) is dropped —
        // otherwise zero-delta cells would ride every future flush.
        if (p.dwell < 1 && p.boost < 1) delete store.pending[cell];
      }
      emit();
    },
    requeue(deltas) {
      for (const [cell, d] of Object.entries(deltas)) {
        const p = store.pending[cell] || (store.pending[cell] = { dwell: 0, boost: 0 });
        p.dwell += d.dwell || 0;
        p.boost += d.boost || 0;
      }
      emit();
    },
    // Adopt server tile totals: fresh server numbers + our still-unsent
    // pending deltas (already reflected locally, so re-added, never lost).
    // Timestamps keep the earliest non-null; unlocks recompute from totals.
    applyServerTiles(rows) {
      const next = {};
      for (const r of rows) {
        const p = store.pending[r.h3_cell] || { dwell: 0, boost: 0 };
        const local = store.tiles[r.h3_cell];
        const firstStamps = [local?.firstSeenAt, r.first_seen_at ? Date.parse(r.first_seen_at) : null].filter(
          (v) => v != null,
        );
        const unlockStamps = [local?.unlockedAt, r.unlocked_at ? Date.parse(r.unlocked_at) : null].filter(
          (v) => v != null,
        );
        next[r.h3_cell] = {
          dwellMs: (r.dwell_ms || 0) + p.dwell,
          boostMs: (r.boost_ms || 0) + p.boost,
          firstSeenAt: firstStamps.length ? Math.min(...firstStamps) : Date.now(),
          unlockedAt: unlockStamps.length ? Math.min(...unlockStamps) : null,
        };
        if (!next[r.h3_cell].unlockedAt && maybeUnlock(next[r.h3_cell])) {
          /* crossed via another device's deltas — stamped now */
        }
      }
      // Local-only cells (first-sync migration, or push not yet confirmed):
      // keep totals; the pending outbox carries them up on next flush.
      for (const [cell, rec] of Object.entries(store.tiles)) {
        if (!next[cell]) next[cell] = rec;
      }
      store.tiles = next;
      store.rev = (store.rev || 0) + 1;
      emit();
    },
    // Delete activities by id: removed locally, tombstoned so sync drops
    // the server rows + storage objects and pulls never resurrect them.
    // Returns the removed rows (for storage-path cleanup by the caller).
    // Sandbox rows stay local-only: never queued for cloud deletion.
    deleteActivities(ids) {
      const idSet = new Set(ids);
      const removed = store.activities.filter((a) => idSet.has(a.id));
      if (!removed.length) return [];
      store.activities = store.activities.filter((a) => !idSet.has(a.id));
      const tomb = new Set(store.deletedIds);
      for (const a of removed) {
        tomb.add(a.id);
        if (!a.sandbox) {
          if (!store.pendingDeletes.some((d) => d.id === a.id)) {
            store.pendingDeletes.push({ id: a.id, path: a.media_path || null });
          }
        }
      }
      store.deletedIds = [...tomb].slice(-MAX_DELETED_IDS);
      store.rev = (store.rev || 0) + 1;
      emit({ type: 'activities-delete', ids });
      return removed;
    },
    // Persist out-of-band mutations (media retry patching) without
    // changing state.
    persist() {
      emit();
    },
    // Called after flush() confirms server + storage deletion.
    clearPendingDeletes() {
      if (!store.pendingDeletes?.length) return;
      store.pendingDeletes = [];
      emit();
    },
    // Merge pulled activities by id (append-only upstream: no conflicts).
    // Tombstoned ids are skipped — deletes win over re-pull.
    mergeActivities(rows) {
      const seen = new Set(store.activities.map((a) => a.id));
      const dead = new Set(store.deletedIds);
      let added = false;
      for (const r of rows) {
        if (seen.has(r.id) || dead.has(r.id)) continue;
        seen.add(r.id);
        store.activities.push({
          id: r.id,
          title: r.title,
          category: r.category,
          captureType: r.capture_type,
          lat: r.lat,
          lng: r.lng,
          cell: r.h3_cell,
          createdAt: Date.parse(r.created_at),
          tiles: r.tiles || [],
          media_url: r.media_url || null,
          media_type: r.media_type || null,
          media_path: r.media_path || null,
        });
        added = true;
      }
      if (added) {
        store.activities.sort((a, b) => a.createdAt - b.createdAt);
        emit();
      }
    },
    setActivityCursor(iso) {
      store.activityCursor = iso;
      emit();
    },
    // Adopt the cloud profile row (last-write-wins), never regressing streak.
    // Base is fill-only and only fills a never-located device (null base):
    // a real local base is NEVER overwritten by the cloud row.
    adoptProfile(prow) {
      if (!prow) return false;
      if ((prow.streak_days || 0) > store.streakDays) store.streakDays = prow.streak_days;
      if (prow.last_active_date && (store.lastActiveDate || '') < prow.last_active_date) {
        store.lastActiveDate = prow.last_active_date;
      }
      const adoptedBase = !store.baseCell && !!prow.base_cell;
      if (adoptedBase) store.baseCell = prow.base_cell;
      // A live outing on another device resumes here (mid-outing sync).
      if (prow.current_outing) {
        store.outing = {
          startedAt: prow.current_outing.startedAt,
          lastTouchAt: prow.current_outing.lastTouchAt,
          touched: [...(prow.current_outing.touched || [])],
        };
      }
      emit();
      return !!adoptedBase;
    },
    logActivity({ title, category, captureType, lat, lng, cell }) {
      const activity = {
        id: crypto.randomUUID(),
        title,
        category,
        captureType,
        lat,
        lng,
        cell,
        createdAt: Date.now(),
        tiles: store.outing ? [...store.outing.touched] : [cell],
        // Sandbox activities stay local: flush() filters on this flag.
        sandbox: sandboxMode,
      };
      store.activities.push(activity);
      const boostTargets = activity.tiles.length ? activity.tiles : [cell];
      this.boostCells(boostTargets);
      return activity;
    },
    startOuting() {
      store.outing = { startedAt: Date.now(), lastTouchAt: Date.now(), touched: [] };
      emit({ type: 'outing-start' });
    },
    endOuting() {
      const outing = store.outing;
      store.outing = null;
      emit({ type: 'outing-end' });
      return outing;
    },
    expireOutingIfNeeded() {
      if (!store.outing) return false;
      if (Date.now() - store.outing.lastTouchAt > CONFIG.outingInactivityMs) {
        store.outing = null;
        emit({ type: 'outing-expire' });
        return true;
      }
      return false;
    },
  };
}

export function remainingLabel(rec) {
  const left = Math.max(0, CONFIG.dwellThresholdMs - tileProgress(rec));
  if (left <= 0 || isUnlocked(rec)) return 'Unlocked';
  const minutes = Math.max(1, Math.ceil(left / 60000));
  return `${minutes} more minute${minutes === 1 ? '' : 's'}`;
}

export function remainingMs(rec) {
  if (!rec) return CONFIG.dwellThresholdMs;
  if (isUnlocked(rec)) return 0;
  return Math.max(0, CONFIG.dwellThresholdMs - tileProgress(rec));
}

export function progressPercent(rec) {
  return Math.min(100, Math.round((tileProgress(rec) / CONFIG.dwellThresholdMs) * 100));
}
