-- ============================================================================
-- Axiom — 001_initial_schema.sql
-- Multi-user schema: profiles, courses, course PDFs, 10-level roadmaps,
-- study attempts, the private `course-materials` Storage bucket, and strict
-- Row Level Security so every user can only read/write/delete their own data.
--
-- Run with:  supabase db push   (or paste into the Supabase SQL editor)
-- ============================================================================

-- gen_random_uuid() is built into Postgres 13+ (no pgcrypto needed).

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text,
  mastery_elo     int  not null default 1000,
  daily_streak    int  not null default 0,
  last_study_date date,
  created_at      timestamptz not null default now()
);

create table if not exists public.courses (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references auth.users (id) on delete cascade,
  title                      text not null,
  -- Lightweight topic & formula syllabus produced by batched PDF extraction
  combined_syllabus_summary  text,
  -- App metadata (beyond the minimal spec)
  code                       text not null default 'ENG',
  exam_date                  date,
  detected_language          text not null default 'English',
  course_digest              text,
  created_at                 timestamptz not null default now()
);

create table if not exists public.course_pdfs (
  id                      uuid primary key default gen_random_uuid(),
  course_id               uuid not null references public.courses (id) on delete cascade,
  user_id                 uuid not null references auth.users (id) on delete cascade,
  file_name               text not null,
  -- `{user_id}/{course_id}/{sanitized_filename}` inside the course-materials bucket
  storage_path            text not null,
  extracted_summary       text,
  -- App metadata (beyond the minimal spec)
  doc_category            text not null default 'lecture_notes'
                          check (doc_category in ('lecture_notes', 'slides', 'past_exam', 'problem_set')),
  size_bytes              bigint not null default 0,
  extracted_topics        jsonb not null default '[]'::jsonb,
  -- Gemini Files API handle cache (expires ~48h); refreshed server-side from Storage
  gemini_file_uri         text,
  gemini_file_expires_at  timestamptz,
  created_at              timestamptz not null default now(),
  constraint course_pdfs_unique_name unique (course_id, file_name),
  constraint course_pdfs_unique_path unique (storage_path)
);

create table if not exists public.levels (
  id                      uuid primary key default gen_random_uuid(),
  course_id               uuid not null references public.courses (id) on delete cascade,
  user_id                 uuid not null references auth.users (id) on delete cascade,
  level_number            int  not null check (level_number between 1 and 10),
  title                   text not null,
  description             text,
  -- Array of matched PDF filenames used for smart context slicing (max 2)
  relevant_pdf_names      jsonb not null default '[]'::jsonb,
  is_unlocked             boolean not null default false,
  best_score              int not null default 0 check (best_score between 0 and 100),
  -- Generated mini-lesson & worked example (Markdown rendering, portable)
  cached_lesson_markdown  text,
  -- Generated Level Climb questions (saves Gemini quota across devices)
  cached_questions        jsonb,
  -- App metadata (beyond the minimal spec)
  tier                    text not null default 'foundation'
                          check (tier in ('foundation', 'application', 'exam', 'distinction')),
  objectives              jsonb not null default '[]'::jsonb,
  key_formulas            jsonb not null default '[]'::jsonb,
  source_excerpt          text,
  cached_lesson           jsonb,            -- structured lesson rendered by the UI
  lesson_doubts           jsonb not null default '[]'::jsonb,
  is_mastered             boolean not null default false,
  attempts                int not null default 0,
  reflex_passed           int not null default 0,
  feynman_best_clarity    int check (feynman_best_clarity between 0 and 100),
  updated_at              timestamptz not null default now(),
  constraint levels_unique_number unique (course_id, level_number)
);

create table if not exists public.study_attempts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  level_id    uuid not null references public.levels (id) on delete cascade,
  mode        text not null check (mode in ('level_climb', 'first_2_lines', 'feynman')),
  score       int  not null check (score between 0 and 100),
  elo_delta   int  not null default 0,
  summary     text,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. Indexes
-- ----------------------------------------------------------------------------

create index if not exists courses_user_id_idx            on public.courses (user_id, created_at);
create index if not exists course_pdfs_course_id_idx      on public.course_pdfs (course_id);
create index if not exists course_pdfs_user_id_idx        on public.course_pdfs (user_id);
create index if not exists levels_user_id_idx             on public.levels (user_id);
-- (course_id, level_number) is covered by the levels_unique_number constraint
create index if not exists study_attempts_user_created_idx on public.study_attempts (user_id, created_at desc);
create index if not exists study_attempts_level_id_idx    on public.study_attempts (level_id);

-- ----------------------------------------------------------------------------
-- 3. updated_at maintenance for levels
-- ----------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists levels_touch_updated_at on public.levels;
create trigger levels_touch_updated_at
  before update on public.levels
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Auto-create a profile row on sign-up
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 5. Row Level Security — owner-only access on every table
-- ----------------------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.courses        enable row level security;
alter table public.course_pdfs    enable row level security;
alter table public.levels         enable row level security;
alter table public.study_attempts enable row level security;

-- Anonymous (signed-out) clients get nothing at all.
revoke all on public.profiles, public.courses, public.course_pdfs, public.levels, public.study_attempts from anon;

-- profiles: normally created by the trigger; users can read/update their own row,
-- and self-heal a missing row (e.g. accounts that existed before this migration).
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- courses
drop policy if exists "courses_select_own" on public.courses;
create policy "courses_select_own" on public.courses
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "courses_insert_own" on public.courses;
create policy "courses_insert_own" on public.courses
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "courses_update_own" on public.courses;
create policy "courses_update_own" on public.courses
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "courses_delete_own" on public.courses;
create policy "courses_delete_own" on public.courses
  for delete to authenticated using ((select auth.uid()) = user_id);

-- course_pdfs: must belong to the user AND point at a course the user owns.
drop policy if exists "course_pdfs_select_own" on public.course_pdfs;
create policy "course_pdfs_select_own" on public.course_pdfs
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "course_pdfs_insert_own" on public.course_pdfs;
create policy "course_pdfs_insert_own" on public.course_pdfs
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid()))
    and storage_path like ((select auth.uid())::text || '/' || course_id::text || '/%')
  );

drop policy if exists "course_pdfs_update_own" on public.course_pdfs;
create policy "course_pdfs_update_own" on public.course_pdfs
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid()))
    and storage_path like ((select auth.uid())::text || '/' || course_id::text || '/%')
  );

drop policy if exists "course_pdfs_delete_own" on public.course_pdfs;
create policy "course_pdfs_delete_own" on public.course_pdfs
  for delete to authenticated using ((select auth.uid()) = user_id);

-- levels: must belong to the user AND point at a course the user owns.
drop policy if exists "levels_select_own" on public.levels;
create policy "levels_select_own" on public.levels
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "levels_insert_own" on public.levels;
create policy "levels_insert_own" on public.levels
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid()))
  );

drop policy if exists "levels_update_own" on public.levels;
create policy "levels_update_own" on public.levels
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid()))
  );

drop policy if exists "levels_delete_own" on public.levels;
create policy "levels_delete_own" on public.levels
  for delete to authenticated using ((select auth.uid()) = user_id);

-- study_attempts: append-only log; must reference a level the user owns.
drop policy if exists "study_attempts_select_own" on public.study_attempts;
create policy "study_attempts_select_own" on public.study_attempts
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "study_attempts_insert_own" on public.study_attempts;
create policy "study_attempts_insert_own" on public.study_attempts
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.levels l where l.id = level_id and l.user_id = (select auth.uid()))
  );

drop policy if exists "study_attempts_delete_own" on public.study_attempts;
create policy "study_attempts_delete_own" on public.study_attempts
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ----------------------------------------------------------------------------
-- 6. Progression RPCs (SECURITY INVOKER → RLS above still applies)
-- ----------------------------------------------------------------------------

-- Applies a single Elo delta (used after each graded Level Climb question).
create or replace function public.apply_elo_delta(p_delta int)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_elo int;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  update public.profiles
     set mastery_elo = greatest(600, mastery_elo + greatest(-100, least(100, p_delta)))
   where id = (select auth.uid())
  returning mastery_elo into v_elo;

  return v_elo;
end;
$$;

-- Logs a study attempt and atomically applies all progression side effects:
--   level_climb   → best_score, attempts, mastery; unlock level N+1 when score >= 80
--   first_2_lines → reflex_passed += 1 when p_passed
--   feynman       → feynman_best_clarity = max(previous, score)
--   all modes     → daily_streak / last_study_date, and mastery_elo (if p_apply_elo)
create or replace function public.record_study_attempt(
  p_level_id   uuid,
  p_mode       text,
  p_score      int,
  p_elo_delta  int,
  p_summary    text    default null,
  p_passed     boolean default null,
  p_local_date date    default null,
  p_apply_elo  boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_level    public.levels%rowtype;
  v_profile  public.profiles%rowtype;
  v_score    int  := greatest(0, least(100, coalesce(p_score, 0)));
  v_delta    int  := greatest(-200, least(200, coalesce(p_elo_delta, 0)));
  v_today    date := coalesce(p_local_date, current_date);
  v_passed   boolean;
  v_unlocked int  := null;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_mode not in ('level_climb', 'first_2_lines', 'feynman') then
    raise exception 'Invalid study mode: %', p_mode;
  end if;

  -- Accept the client's local calendar date (for timezone-correct streaks), but
  -- never more than one day away from the server's date.
  if v_today not between current_date - 1 and current_date + 1 then
    v_today := current_date;
  end if;

  select * into v_level
    from public.levels
   where id = p_level_id and user_id = v_uid
   for update;

  if not found then
    raise exception 'Level not found';
  end if;

  insert into public.study_attempts (user_id, level_id, mode, score, elo_delta, summary)
  values (v_uid, p_level_id, p_mode, v_score, v_delta, p_summary);

  if p_mode = 'level_climb' then
    v_passed := v_score >= 80;

    update public.levels
       set best_score  = greatest(best_score, v_score),
           attempts    = attempts + 1,
           is_mastered = is_mastered or v_passed
     where id = p_level_id;

    if v_passed and v_level.level_number < 10 then
      update public.levels
         set is_unlocked = true
       where course_id = v_level.course_id
         and user_id = v_uid
         and level_number = v_level.level_number + 1;
      v_unlocked := v_level.level_number + 1;
    end if;

  elsif p_mode = 'first_2_lines' then
    v_passed := coalesce(p_passed, v_score >= 80);
    if v_passed then
      update public.levels set reflex_passed = reflex_passed + 1 where id = p_level_id;
    end if;

  else -- feynman
    v_passed := coalesce(p_passed, v_score >= 80);
    update public.levels
       set feynman_best_clarity = greatest(coalesce(feynman_best_clarity, 0), v_score)
     where id = p_level_id;
  end if;

  update public.profiles
     set daily_streak = case
                          when last_study_date = v_today     then greatest(1, daily_streak)
                          when last_study_date = v_today - 1 then daily_streak + 1
                          else 1
                        end,
         last_study_date = greatest(coalesce(last_study_date, v_today), v_today),
         mastery_elo = case when p_apply_elo then greatest(600, mastery_elo + v_delta) else mastery_elo end
   where id = v_uid
  returning * into v_profile;

  return jsonb_build_object(
    'passed',            v_passed,
    'unlocked_level',    v_unlocked,
    'mastery_elo',       v_profile.mastery_elo,
    'daily_streak',      v_profile.daily_streak,
    'last_study_date',   v_profile.last_study_date
  );
end;
$$;

revoke all on function public.apply_elo_delta(int) from public, anon;
revoke all on function public.record_study_attempt(uuid, text, int, int, text, boolean, date, boolean) from public, anon;
grant execute on function public.apply_elo_delta(int) to authenticated;
grant execute on function public.record_study_attempt(uuid, text, int, int, text, boolean, date, boolean) to authenticated;

-- Trigger-only helpers must not be callable through the API.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Storage: private `course-materials` bucket
--    Object keys: {user_id}/{course_id}/{filename}
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-materials', 'course-materials', false, 52428800, array['application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "course_materials_select_own" on storage.objects;
create policy "course_materials_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "course_materials_insert_own" on storage.objects;
create policy "course_materials_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    -- second path segment must be a course the uploader owns
    and exists (
      select 1 from public.courses c
       where c.id::text = (storage.foldername(name))[2]
         and c.user_id = (select auth.uid())
    )
  );

drop policy if exists "course_materials_update_own" on storage.objects;
create policy "course_materials_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "course_materials_delete_own" on storage.objects;
create policy "course_materials_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
