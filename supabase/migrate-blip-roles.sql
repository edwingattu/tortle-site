-- Tortle blip roles: one Main blip (quest start) + one End blip per quest.
-- Trail blips are every other pinned objective (implicit, no flag).
-- Run once in the Supabase SQL editor (after migrate-objective-pins.sql).
alter table public.quest_objectives add column if not exists is_main boolean not null default false;
alter table public.quest_objectives add column if not exists is_end boolean not null default false;

-- One Main blip per quest.
create unique index if not exists quest_objectives_one_main
  on public.quest_objectives (quest_id) where is_main;

-- One End blip per quest.
create unique index if not exists quest_objectives_one_end
  on public.quest_objectives (quest_id) where is_end;
