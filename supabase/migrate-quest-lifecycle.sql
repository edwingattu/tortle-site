-- Tortle quest lifecycle: timed deployments with recall.
-- Deploy sets deploy_until; expiry flips the quest to 'recalled' (map-cleared,
-- location-locked, re-deployable or deletable).
-- Run once in the Supabase SQL editor (after migrate-quest-progress.sql).
update public.quests set status = 'draft' where status = 'active';

alter table public.quests add column if not exists deploy_until timestamptz;

alter table public.quests drop constraint if exists quests_status_check;
alter table public.quests add constraint quests_status_check
  check (status in ('draft', 'finished', 'deployed', 'recalled'));
