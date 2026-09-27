-- Tortle tile names (personal titles per H3 cell). Run once in the Supabase SQL editor.
-- Names are last-write-wins by name_updated_at; existing RLS ("owner all")
-- and grants on tile_progress already cover the new columns — no new policy needed.
alter table public.tile_progress add column if not exists name text;
alter table public.tile_progress add column if not exists name_updated_at timestamptz;
