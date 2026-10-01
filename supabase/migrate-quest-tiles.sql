-- Tortle quest tile ledger: per-user dwell/boost per H3 cell on the quest map.
-- Fully separate from tile_progress (regular and quest contexts never mix).
-- Run once in the Supabase SQL editor.
create table if not exists public.quest_tiles (
  user_id uuid not null references auth.users (id) on delete cascade,
  h3_cell text not null,
  dwell_ms bigint not null default 0,
  boost_ms bigint not null default 0,
  first_seen_at timestamptz,
  unlocked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, h3_cell)
);

alter table public.quest_tiles enable row level security;

drop policy if exists "owner all" on public.quest_tiles;
create policy "owner all" on public.quest_tiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.quest_tiles to authenticated;

-- Delta-additive merge RPC (mirrors apply_tile_deltas): the client pushes
-- time *deltas*, so progress earned on two devices adds up. Timestamps keep
-- the earliest non-null value. Retries are safe — the client clears its
-- outbox only after a successful call.
create or replace function public.apply_quest_deltas(deltas jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  d jsonb;
begin
  for d in select * from jsonb_array_elements(coalesce(deltas, '[]'::jsonb))
  loop
    insert into public.quest_tiles
      (user_id, h3_cell, dwell_ms, boost_ms, first_seen_at, unlocked_at, updated_at)
    values
      (auth.uid(), d->>'h3_cell',
       coalesce((d->>'dwell_ms')::bigint, 0),
       coalesce((d->>'boost_ms')::bigint, 0),
       (d->>'first_seen_at')::timestamptz,
       (d->>'unlocked_at')::timestamptz,
       now())
    on conflict (user_id, h3_cell) do update set
      dwell_ms      = public.quest_tiles.dwell_ms + excluded.dwell_ms,
      boost_ms      = public.quest_tiles.boost_ms + excluded.boost_ms,
      first_seen_at = least(
        coalesce(public.quest_tiles.first_seen_at, excluded.first_seen_at),
        coalesce(excluded.first_seen_at, public.quest_tiles.first_seen_at)),
      unlocked_at   = least(
        coalesce(public.quest_tiles.unlocked_at, excluded.unlocked_at),
        coalesce(excluded.unlocked_at, public.quest_tiles.unlocked_at)),
      updated_at    = now();
  end loop;
end;
$$;

-- Grants last: the function must exist before it can be granted.
grant execute on function public.apply_quest_deltas(jsonb) to authenticated;
