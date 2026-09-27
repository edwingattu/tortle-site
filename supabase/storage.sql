-- Tortle media bucket (optimized photo/video + voice). Run once after schema.sql.
-- PRIVATE: reads are owner-only (RLS on folder prefix). The app mints
-- short-lived signed URLs per view — never stored, never shareable.
insert into storage.buckets (id, name, public) values ('tortle-media', 'tortle-media', false)
on conflict (id) do update set public = false;
update storage.buckets set public = false where id = 'tortle-media';

-- Owner-only read: user can read only under their own folder user_id/
drop policy if exists "public read" on storage.objects;
drop policy if exists "owner read" on storage.objects;
create policy "owner read" on storage.objects for select
  using (bucket_id = 'tortle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "owner write" on storage.objects;
create policy "owner write" on storage.objects for insert
  with check (bucket_id = 'tortle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "owner update" on storage.objects;
create policy "owner update" on storage.objects for update
  using (bucket_id = 'tortle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "owner delete" on storage.objects;
create policy "owner delete" on storage.objects for delete
  using (bucket_id = 'tortle-media' and auth.uid()::text = (storage.foldername(name))[1]);

-- Activities: add media columns if not exists
alter table public.activities add column if not exists media_url text;
alter table public.activities add column if not exists media_type text;
alter table public.activities add column if not exists media_meta jsonb;
alter table public.activities add column if not exists media_path text;
