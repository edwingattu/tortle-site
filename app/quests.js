import { supabase } from './auth.js';
import { cellAt } from './engine.js';
import { regionForPoint } from './areas.js';

// Quest framework (client): creation is presence-free — an admin can mark a
// point on any map, for any city. Availability is per-region: the caller
// shows only the active region's quests (server scoping is a follow-up).
const cache = new Map(); // region -> quest rows

export async function createQuest({ title, lat, lng }) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('no user');
  const region = regionForPoint(lat, lng);
  const row = {
    creator_id: user.id,
    region,
    h3_cell: cellAt(lat, lng),
    lat,
    lng,
    title: (title || '').trim() || 'Untitled quest',
    // New quests start In Progress (draft); Deploy makes them Main-Map live.
    status: 'draft',
  };
  const { data, error } = await supabase.from('quests').insert(row).select().single();
  if (error) throw error;
  const list = cache.get(region) || [];
  list.push(data);
  cache.set(region, list);
  return data;
}

export async function fetchRegionQuests(region, { force = false } = {}) {
  if (!force && cache.has(region)) return cache.get(region);
  const { data, error } = await supabase
    .from('quests')
    .select('*')
    .eq('region', region)
    .in('status', ['draft', 'finished', 'deployed'])
    .order('created_at');
  if (error) throw error;
  cache.set(region, data || []);
  return cache.get(region);
}

// Progress transition (Finish / Deploy / Reopen / Undeploy). Patches the
// local cache row in place so counts and lists update instantly.
export async function updateQuestStatus(id, status) {
  const { data, error } = await supabase.from('quests').update({ status }).eq('id', id).select().single();
  if (error) throw error;
  for (const list of cache.values()) {
    const i = list.findIndex((q) => q.id === id);
    if (i !== -1) list[i] = data;
  }
  return data;
}

// Quest delete (objectives cascade in the DB). Purges quest + objective caches.
export async function deleteQuest(id) {
  const { error } = await supabase.from('quests').delete().eq('id', id);
  if (error) throw error;
  for (const [region, list] of cache.entries()) {
    cache.set(region, list.filter((q) => q.id !== id));
  }
  objectiveCache.delete(id);
}

// Synchronous reads over the fetched cache (may lag the network —
// refreshQuests repaints once each fetch lands).
export function questsForCell(cell) {
  if (!cell) return [];
  const out = [];
  for (const list of cache.values()) {
    for (const q of list) {
      if (q.h3_cell === cell) out.push(q);
    }
  }
  out.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return out;
}

export function latestQuestForCell(cell) {
  const list = questsForCell(cell);
  return list.length ? list[list.length - 1] : null;
}

// ---- Objectives: ordered todo steps, one capture tool each ----
const objectiveCache = new Map(); // questId -> rows (position order)

export async function fetchObjectives(questId, { force = false } = {}) {
  if (!questId) return [];
  if (!force && objectiveCache.has(questId)) return objectiveCache.get(questId);
  const { data, error } = await supabase
    .from('quest_objectives')
    .select('*')
    .eq('quest_id', questId)
    .order('position')
    .order('created_at');
  if (error) throw error;
  objectiveCache.set(questId, data || []);
  return objectiveCache.get(questId);
}

export function objectivesForQuest(questId) {
  return objectiveCache.get(questId) || [];
}

export async function createObjective(questId, { text, tool, lat, lng, isMain = false, isEnd = false }) {
  const existing = await fetchObjectives(questId);
  const row = {
    quest_id: questId,
    position: existing.length ? Math.max(...existing.map((o) => o.position || 0)) + 1 : 0,
    text: (text || '').trim() || 'Untitled objective',
    tool: tool || null,
    // Exact blip location (navigation objectives); null when unpinned.
    lat: lat ?? null,
    lng: lng ?? null,
    // Blip roles: one Main (quest start) + one End per quest (see migration).
    is_main: !!isMain,
    is_end: !!isEnd,
  };
  const { data, error } = await supabase.from('quest_objectives').insert(row).select().single();
  if (error) throw error;
  objectiveCache.set(questId, [...existing, data]);
  return data;
}

export async function updateObjective(id, questId, patch) {
  const { data, error } = await supabase
    .from('quest_objectives')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  const list = objectiveCache.get(questId) || [];
  objectiveCache.set(
    questId,
    list.map((o) => (o.id === id ? data : o)),
  );
  return data;
}

// Objective delete (maker-side). Patches the quest's cached list in place.
export async function deleteObjective(id, questId) {
  const { error } = await supabase.from('quest_objectives').delete().eq('id', id);
  if (error) throw error;
  objectiveCache.set(
    questId,
    (objectiveCache.get(questId) || []).filter((o) => o.id !== id),
  );
}

// Current-objective pointer: per-device local state for now (player-side
// server sync comes with the playing build). First objective is the default.
const CURRENT_KEY = 'tortle.v0.quest-current';
function readCurrentMap() {
  try {
    return JSON.parse(localStorage.getItem(CURRENT_KEY) || '{}');
  } catch {
    return {};
  }
}
export function currentObjectiveId(questId, list = []) {
  const saved = readCurrentMap()[questId];
  if (saved && list.some((o) => o.id === saved)) return saved;
  return list.length ? list[0].id : null;
}
export function setCurrentObjectiveId(questId, objectiveId) {
  try {
    const map = readCurrentMap();
    map[questId] = objectiveId;
    localStorage.setItem(CURRENT_KEY, JSON.stringify(map));
  } catch {}
}

export function questById(id) {
  if (!id) return null;
  for (const list of cache.values()) {
    const hit = list.find((q) => q.id === id);
    if (hit) return hit;
  }
  return null;
}

// Rename (creator/superadmin per RLS). Patches the cache row in place.
export async function updateQuestTitle(id, title) {
  const { data, error } = await supabase
    .from('quests')
    .update({ title: (title || '').trim() || 'Untitled quest' })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  for (const list of cache.values()) {
    const i = list.findIndex((q) => q.id === id);
    if (i !== -1) list[i] = data;
  }
  return data;
}
