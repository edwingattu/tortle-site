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
