import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False when `.env.local` is missing the Supabase keys — the app shows a setup screen. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

/** Google OAuth button is hidden until the provider is enabled in the Supabase dashboard. */
export const isGoogleAuthEnabled = import.meta.env.VITE_ENABLE_GOOGLE_AUTH === 'true';

export const COURSE_MATERIALS_BUCKET = 'course-materials';

// createClient throws on an empty URL, so fall back to inert placeholders when
// unconfigured. App.tsx gates on `isSupabaseConfigured` before any call is made.
export const supabase = createClient<Database>(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'missing-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

/** Returns the signed-in user's id or throws — services call this before every write. */
export async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  const id = data.session?.user.id;
  if (error || !id) {
    throw new Error('Your session has expired. Please sign in again.');
  }
  return id;
}

/** Current access token (JWT) for authenticating calls to our own /api server. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
