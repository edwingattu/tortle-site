-- Tortle quest objectives: ordered todo steps per quest, each with one tool.
-- Run once in the Supabase SQL editor (after quests.sql).
-- Reads are open to all authenticated (players need them to play); writes
-- are restricted to the parent quest's creator + superadmin.
create table if not exists public.quest_objectives (
  id uuid primary key default gen_random_uuid(),
  quest_id uuid not null references public.quests (id) on delete cascade,
  position integer not null default 0,
  text text not null default '',
  tool text check (tool in ('camera', 'voice', 'navigation')),
  created_at timestamptz not null default now()
);

create index if not exists quest_objectives_quest_idx
  on public.quest_objectives (quest_id, position);

alter table public.quest_objectives enable row level security;

drop policy if exists "authenticated read" on public.quest_objectives;
create policy "authenticated read" on public.quest_objectives
  for select using (auth.role() = 'authenticated');

drop policy if exists "creator write" on public.quest_objectives;
create policy "creator write" on public.quest_objectives
  for insert with check (
    exists (
      select 1 from public.quests
      where quests.id = quest_objectives.quest_id
        and (quests.creator_id = auth.uid() or public.my_role() = 'superadmin')
    )
  );

drop policy if exists "creator change" on public.quest_objectives;
create policy "creator change" on public.quest_objectives
  for update
  using (
    exists (
      select 1 from public.quests
      where quests.id = quest_objectives.quest_id
        and (quests.creator_id = auth.uid() or public.my_role() = 'superadmin')
    )
  )
  with check (
    exists (
      select 1 from public.quests
      where quests.id = quest_objectives.quest_id
        and (quests.creator_id = auth.uid() or public.my_role() = 'superadmin')
    )
  );

drop policy if exists "creator revoke" on public.quest_objectives;
create policy "creator revoke" on public.quest_objectives
  for delete using (
    exists (
      select 1 from public.quests
      where quests.id = quest_objectives.quest_id
        and (quests.creator_id = auth.uid() or public.my_role() = 'superadmin')
    )
  );

grant select, insert, update, delete on public.quest_objectives to authenticated;
