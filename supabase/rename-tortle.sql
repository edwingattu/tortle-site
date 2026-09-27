-- Tortle rename migration (Tourle → Tortle). Run ONCE in the Supabase SQL
-- editor AFTER deploying app code that reads the new names.
-- The app is silent-local: users mid-session retry against the new names.
--
-- Rollback: rename tortle_profiles back; move objects back with
--   update storage.objects set bucket_id = 'tourtle-media'
--     where bucket_id = 'tortle-media';

-- 1. Profiles table. RLS policies + grants ride along with RENAME.
alter table if exists public.tourtle_profiles rename to tortle_profiles;

-- 2. Media bucket: create the new private bucket + duplicate owner policies.
insert into storage.buckets (id, name, public) values ('tortle-media', 'tortle-media', false)
on conflict (id) do update set public = false;

drop policy if exists "tortle owner read" on storage.objects;
create policy "tortle owner read" on storage.objects for select
  using (bucket_id = 'tortle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "tortle owner write" on storage.objects;
create policy "tortle owner write" on storage.objects for insert
  with check (bucket_id = 'tortle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "tortle owner update" on storage.objects;
create policy "tortle owner update" on storage.objects for update
  using (bucket_id = 'tortle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "tortle owner delete" on storage.objects;
create policy "tortle owner delete" on storage.objects for delete
  using (bucket_id = 'tortle-media' and auth.uid()::text = (storage.foldername(name))[1]);

-- 3. Move objects. DO NOT move them with SQL: file bytes live under
-- bucket-keyed paths, so updating bucket_id orphans the bytes (reachable
-- metadata, undownloadable files). Move server-side instead — Storage
-- dashboard drag-and-drop per user folder, or the API (download+re-upload).
-- Stored media_path values are bucket-relative within each user folder, so
-- app rows need no changes as long as folder structure is preserved.

-- 4. VERIFY FIRST, then run cleanup:
--    select bucket_id, count(*) from storage.objects group by bucket_id;
--    select count(*) from public.tortle_profiles;
-- Cleanup (only after the app is confirmed healthy on new names):
--    delete from storage.buckets where id = 'tourtle-media';
--    drop policy if exists "owner read" on storage.objects;
--    drop policy if exists "owner write" on storage.objects;
--    drop policy if exists "owner update" on storage.objects;
--    drop policy if exists "owner delete" on storage.objects;
