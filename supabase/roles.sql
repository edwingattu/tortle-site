-- Tortle role ladder: superadmin > admin > developer. Run once in Supabase SQL editor.
-- All enforcement is server-side (RLS); clients only read their own rung.
-- Idiom: presence of a row IS the grant. Removing the row revokes.

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('superadmin', 'admin', 'developer')),
  granted_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;

-- Own rung, RLS-bypassed internally (SECURITY DEFINER + fixed search_path so
-- policies can call it without recursing).
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_roles where user_id = auth.uid()
$$;

-- Anyone reads exactly their own row (nobody enumerates the admin set).
drop policy if exists "own role read" on public.user_roles;
create policy "own role read" on public.user_roles
  for select using (auth.uid() = user_id);

-- Grants: superadmin anything; admin developer-only and never self.
drop policy if exists "role grant" on public.user_roles;
create policy "role grant" on public.user_roles
  for insert with check (
    public.my_role() = 'superadmin'
    or (public.my_role() = 'admin'
        and user_roles.role = 'developer'
        and user_roles.user_id <> auth.uid())
  );

-- Changes: same ladder on old row, same ladder on new row, never own row.
drop policy if exists "role change" on public.user_roles;
create policy "role change" on public.user_roles
  for update
  using (
    user_roles.user_id <> auth.uid()
    and (public.my_role() = 'superadmin'
         or (public.my_role() = 'admin' and user_roles.role = 'developer'))
  )
  with check (
    public.my_role() = 'superadmin'
    or (public.my_role() = 'admin'
        and user_roles.role = 'developer'
        and user_roles.user_id <> auth.uid())
  );

-- Revokes: superadmin or admin-over-developer; NOBODY deletes their own row
-- through the API (superadmin removal requires direct database access).
drop policy if exists "role revoke" on public.user_roles;
create policy "role revoke" on public.user_roles
  for delete using (
    user_roles.user_id <> auth.uid()
    and (public.my_role() = 'superadmin'
         or (public.my_role() = 'admin' and user_roles.role = 'developer'))
  );

-- Table privileges (RLS policies above do the actual restricting).
grant select, insert, update, delete on public.user_roles to authenticated;

-- ---- Audit: every grant/change/revoke, who did what to whom ----
create table if not exists public.role_grants_log (
  id bigint generated always as identity primary key,
  actor uuid,
  target uuid,
  old_role text,
  new_role text,
  action text not null,
  created_at timestamptz not null default now()
);

alter table public.role_grants_log enable row level security;

drop policy if exists "superadmin audit read" on public.role_grants_log;
create policy "superadmin audit read" on public.role_grants_log
  for select using (public.my_role() = 'superadmin');

grant select on public.role_grants_log to authenticated;

-- Trigger writes bypass RLS (definer) — app roles have no write path here.
create or replace function public.log_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.role_grants_log (actor, target, old_role, new_role, action)
  values (
    auth.uid(),
    coalesce(new.user_id, old.user_id),
    case when tg_op = 'INSERT' then null else old.role end,
    case when tg_op = 'DELETE' then null else new.role end,
    tg_op
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists role_change_audit on public.user_roles;
create trigger role_change_audit
  after insert or update or delete on public.user_roles
  for each row execute function public.log_role_change();

-- ---- Seed: first (and boss) superadmin. Service-role context bypasses RLS. ----
insert into public.user_roles (user_id, role, granted_by)
values ('6fc554ce-a5a8-4e12-884d-ea2b95456cc3', 'superadmin', '6fc554ce-a5a8-4e12-884d-ea2b95456cc3')
on conflict (user_id) do update set role = 'superadmin';
