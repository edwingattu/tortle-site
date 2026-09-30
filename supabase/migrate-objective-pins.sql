-- Tortle objective pins: exact blip locations for navigation objectives.
-- Run once in the Supabase SQL editor.
alter table public.quest_objectives add column if not exists lat double precision;
alter table public.quest_objectives add column if not exists lng double precision;
