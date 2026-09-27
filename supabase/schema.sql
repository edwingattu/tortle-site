-- Tortle V0 cloud sync schema. Run once in the Supabase SQL editor.
-- Tables are owner-only via RLS (user_id = auth.uid()); the anon key is
-- safe in the client because no row is visible to anyone but its owner.

-- ---- tortle_profiles: single row per user (base, streak, live outing) ----
-- Named to avoid colliding with the default Supabase starter `profiles`
-- table, which has a different shape. Existing tables are left untouched.
create table if not exists public.tortle_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  base_cell text,
  streak_days integer not null default 0,
  last_active_date date,
  current_outing jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---- tile_progress: cumulative dwell/boost per user per H3 cell ----
create table if not exists public.tile_progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  h3_cell text not null,
  dwell_ms bigint not null default 0,
  boost_ms bigint not null default 0,
  first_seen_at timestamptz,
  unlocked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, h3_cell)
);

-- ---- activities: append-only log (never updated, so never conflicts) ----
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  category text,
  capture_type text,
  lat double precision,
  lng double precision,
  h3_cell text,
  tiles text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.tortle_profiles enable row level security;
alter table public.tile_progress enable row level security;
alter table public.activities enable row level security;

drop policy if exists "owner all" on public.tortle_profiles;
create policy "owner all" on public.tortle_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner all" on public.tile_progress;
create policy "owner all" on public.tile_progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner all" on public.activities;
create policy "owner all" on public.activities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Tables created via raw SQL get no role privileges by default (the
-- dashboard builder adds these silently). Without them PostgREST refuses
-- before RLS is even evaluated — the 403 "permission denied for table".
grant all on public.tortle_profiles to authenticated;
grant all on public.tile_progress to authenticated;
grant all on public.activities to authenticated;
grant execute on function public.apply_tile_deltas(jsonb) to authenticated;

-- ---- Delta-additive merge RPC ----
-- The client pushes time *deltas* (never absolute totals), so progress earned
-- on two devices adds up instead of overwriting. Deltas apply atomically per
-- batch; retries are safe because the client clears its outbox only after a
-- successful call. Timestamps keep the earliest non-null value.
create or replace function public.apply_tile_deltas(deltas jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  d jsonb;
begin
  for d in select * from jsonb_array_elements(coalesce(deltas, '[]'::jsonb))
  loop
    insert into public.tile_progress
      (user_id, h3_cell, dwell_ms, boost_ms, first_seen_at, unlocked_at, updated_at)
    values
      (auth.uid(), d->>'h3_cell',
       coalesce((d->>'dwell_ms')::bigint, 0),
       coalesce((d->>'boost_ms')::bigint, 0),
       (d->>'first_seen_at')::timestamptz,
       (d->>'unlocked_at')::timestamptz,
       now())
    on conflict (user_id, h3_cell) do update set
      dwell_ms      = public.tile_progress.dwell_ms + excluded.dwell_ms,
      boost_ms      = public.tile_progress.boost_ms + excluded.boost_ms,
      first_seen_at = least(
        coalesce(public.tile_progress.first_seen_at, excluded.first_seen_at),
        coalesce(excluded.first_seen_at, public.tile_progress.first_seen_at)),
      unlocked_at   = least(
        coalesce(public.tile_progress.unlocked_at, excluded.unlocked_at),
        coalesce(excluded.unlocked_at, public.tile_progress.unlocked_at)),
      updated_at    = now();
  end loop;
end;
$$;
