-- Tortle quest progress states: draft (In Progress) / finished / deployed.
-- Deployed = live on the Main Map; the rest render on the quest map only.
-- Run once in the Supabase SQL editor.
-- Pre-progress rows were saved as 'active' with no content — they restart as drafts.
update public.quests set status = 'draft' where status = 'active';

alter table public.quests drop constraint if exists quests_status_check;
alter table public.quests add constraint quests_status_check
  check (status in ('draft', 'finished', 'deployed'));

alter table public.quests alter column status set default 'draft';
