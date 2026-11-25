-- ============================================================================
-- Axiom — 002_byok_api_keys.sql
-- Bring-Your-Own-Key: each user can store their own Gemini API key.
--
-- Keys are encrypted by server.ts (AES-256-GCM, server-only BYOK_ENCRYPTION_KEY)
-- BEFORE they reach Postgres. The table only ever holds ciphertext plus the
-- last 4 characters for display, so a database leak does not expose usable keys.
-- ============================================================================

create table if not exists public.user_api_keys (
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null default 'gemini' check (provider in ('gemini')),
  -- format: v1:<iv_b64>:<auth_tag_b64>:<ciphertext_b64>
  encrypted_key  text not null check (encrypted_key like 'v1:%'),
  key_hint       text not null check (char_length(key_hint) <= 8),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, provider)
);

drop trigger if exists user_api_keys_touch_updated_at on public.user_api_keys;
create trigger user_api_keys_touch_updated_at
  before update on public.user_api_keys
  for each row execute function public.touch_updated_at();

alter table public.user_api_keys enable row level security;
revoke all on public.user_api_keys from anon;

drop policy if exists "user_api_keys_select_own" on public.user_api_keys;
create policy "user_api_keys_select_own" on public.user_api_keys
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "user_api_keys_insert_own" on public.user_api_keys;
create policy "user_api_keys_insert_own" on public.user_api_keys
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "user_api_keys_update_own" on public.user_api_keys;
create policy "user_api_keys_update_own" on public.user_api_keys
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "user_api_keys_delete_own" on public.user_api_keys;
create policy "user_api_keys_delete_own" on public.user_api_keys
  for delete to authenticated using ((select auth.uid()) = user_id);
