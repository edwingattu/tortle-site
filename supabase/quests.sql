-- Tortle quest framework: admin-created points of interest, playable city-wide.
-- Run once in the Supabase SQL editor AFTER roles.sql (uses public.my_role()).
-- V0 scope: any authenticated user reads active quests; the client shows only
-- the current city's (server-side city scoping needs a trusted user position
-- we don't collect yet). Writes are admin/superadmin-only; creators own rows.
create table if not exists public.quests (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users (id) on delete cascade,
  region text not null default 'hyd',
  h3_cell text,
  lat double precision not null,
  lng double precision not null,
  title text not null default 'Untitled quest',
  status text not null default 'active' check (status in ('draft', 'active', 'archived')),
  created_at timestamptz not null default now()
);

alter table public.quests enable row level security;

drop policy if exists "authenticated read" on public.quests;
create policy "authenticated read" on public.quests
  for select using (auth.role() = 'authenticated');

drop policy if exists "admin create" on public.quests;
create policy "admin create" on public.quests
  for insert with check (public.my_role() in ('admin', 'superadmin'));

drop policy if exists "creator change" on public.quests;
create policy "creator change" on public.quests
  for update
  using (quests.creator_id = auth.uid() or public.my_role() = 'superadmin')
  with check (quests.creator_id = auth.uid() or public.my_role() = 'superadmin');

drop policy if exists "creator revoke" on public.quests;
create policy "creator revoke" on public.quests
  for delete using (quests.creator_id = auth.uid() or public.my_role() = 'superadmin');

grant select, insert, update, delete on public.quests to authenticated;
