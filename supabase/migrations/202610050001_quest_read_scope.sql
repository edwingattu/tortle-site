-- RLS hardening: unpublished quests go dark + admin inserts bind creator.
-- 1. SELECT on quests/quest_objectives: launched rows stay public to
--    authenticated users; drafts/finished visible to creator + superadmin.
-- 2. INSERT on quests: admins can only create as themselves (superadmin
--    retains attribution). Closes the admin-spoofing vector.
-- Apply with: supabase db push

-- ---- quests: scoped reads ----
drop policy if exists "authenticated read" on public.quests;
create policy "scoped read" on public.quests
  for select using (
    auth.role() = 'authenticated'
    and (
      quests.status = 'deployed'
      or quests.creator_id = auth.uid()
      or public.my_role() = 'superadmin'
    )
  );

-- ---- quests: creator-bound admin insert ----
drop policy if exists "admin create" on public.quests;
create policy "admin create" on public.quests
  for insert with check (
    public.my_role() in ('admin', 'superadmin')
    and (
      quests.creator_id = auth.uid()
      or public.my_role() = 'superadmin'
    )
  );

-- ---- quest_objectives: scoped reads (via parent quest) ----
drop policy if exists "authenticated read" on public.quest_objectives;
create policy "scoped read" on public.quest_objectives
  for select using (
    auth.role() = 'authenticated'
    and exists (
      select 1 from public.quests
      where quests.id = quest_objectives.quest_id
        and (
          quests.status = 'deployed'
          or quests.creator_id = auth.uid()
          or public.my_role() = 'superadmin'
        )
    )
  );
