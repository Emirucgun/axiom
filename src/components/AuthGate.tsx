import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { isGoogleAuthEnabled, supabase } from '../lib/supabase';

type AuthMode = 'sign_in' | 'sign_up';

const inputClass =
  'w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500';

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}

export const AuthGate: React.FC = () => {
  const [mode, setMode] = useState<AuthMode>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === 'sign_in') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setNotice('Check your inbox to confirm your email, then sign in.');
          switchModeKeepNotice('sign_in');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed.';
      setError(
        /failed to fetch|networkerror|load failed/i.test(message)
          ? 'Cannot reach the authentication server. Check your connection and try again.'
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  const switchModeKeepNotice = (next: AuthMode) => {
    setMode(next);
    setPassword('');
  };

  const handleGoogle = async () => {
    setError(null);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (oauthError) setError(oauthError.message);
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError('Enter your email above first, then click "Forgot password?".');
      return;
    }
    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    });
    if (resetError) setError(resetError.message);
    else setNotice('Password reset link sent. Check your inbox.');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0B0F17] px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5 text-center">
          <div className="text-2xl font-bold tracking-tight font-display text-slate-900 dark:text-slate-100">
            Axiom
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {mode === 'sign_in'
              ? 'Sign in to continue your mastery climb.'
              : 'Create an account to sync courses across devices.'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
            {(['sign_in', 'sign_up'] as AuthMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  mode === m
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {m === 'sign_in' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          {isGoogleAuthEnabled && (
            <>
              <button
                type="button"
                onClick={handleGoogle}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
              >
                <GoogleMark />
                <span>Continue with Google</span>
              </button>
              <div className="flex items-center gap-3 text-[11px] text-slate-400">
                <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                <span>or</span>
                <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div className="space-y-1.5">
              <label htmlFor="auth-email" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Email
              </label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@university.edu"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="auth-password" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  Password
                </label>
                {mode === 'sign_in' && (
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-[11px] text-sky-700 dark:text-sky-400 hover:underline cursor-pointer"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                id="auth-password"
                type="password"
                autoComplete={mode === 'sign_in' ? 'current-password' : 'new-password'}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'sign_up' ? 'At least 6 characters' : '••••••••'}
                className={inputClass}
              />
            </div>

            {error && (
              <div role="alert" className="p-2.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {notice && (
              <div role="status" className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50 text-xs text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white text-sm font-medium transition-colors cursor-pointer"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{mode === 'sign_in' ? 'Sign in' : 'Create account'}</span>
            </button>
          </form>
        </div>

        <p className="text-center text-[11px] text-slate-400 dark:text-slate-500">
          Your PDFs and progress are private to your account.
        </p>
      </div>
    </div>
  );
};

export const SupabaseSetupRequired: React.FC = () => (
  <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0B0F17] px-4">
    <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-3">
      <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">Supabase is not configured</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
        Copy <code className="font-mono text-xs">.env.example</code> to{' '}
        <code className="font-mono text-xs">.env.local</code>, fill in{' '}
        <code className="font-mono text-xs">VITE_SUPABASE_URL</code> and{' '}
        <code className="font-mono text-xs">VITE_SUPABASE_ANON_KEY</code> from your Supabase project's API
        settings, run the SQL in <code className="font-mono text-xs">supabase/migrations/</code>, then restart the
        dev server.
      </p>
    </div>
  </div>
);
