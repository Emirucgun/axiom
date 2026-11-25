import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, X } from 'lucide-react';
import type { ApiKeyStatus } from '../services/apiKeyService';
import { removeApiKey, saveApiKey } from '../services/apiKeyService';

interface ApiKeySettingsProps {
  open: boolean;
  status: ApiKeyStatus | null;
  onClose: () => void;
  /** Called after the key was saved or removed so the app can refresh state. */
  onChanged: (next: ApiKeyStatus) => void;
}

export const ApiKeySettings: React.FC<ApiKeySettingsProps> = ({ open, status, onClose, onChanged }) => {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue('');
      setReveal(false);
      setConfirmRemove(false);
      setError(null);
      setNotice(null);
    }
  }, [open]);

  if (!open) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const next = await saveApiKey(value);
      setValue('');
      setNotice(`Key verified with Gemini and saved (ending in ${next.keyHint}).`);
      onChanged({ ...status, ...next } as ApiKeyStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key.');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    setBusy('remove');
    setError(null);
    setNotice(null);
    try {
      const next = await removeApiKey();
      setConfirmRemove(false);
      setNotice('Your API key was removed.');
      onChanged({ ...status, ...next } as ApiKeyStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove API key.');
    } finally {
      setBusy(null);
    }
  };

  const statusLine = status?.hasKey
    ? { tone: 'ok' as const, text: `Using your Gemini key •••• ${status.keyHint ?? ''}` }
    : status?.serverFallbackAvailable
      ? { tone: 'info' as const, text: 'Using the shared server key. Add your own for private quota.' }
      : { tone: 'warn' as const, text: 'No key yet — AI features are disabled until you add one.' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="byok-title"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="byok-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <KeyRound className="w-4.5 h-4.5 text-sky-600 dark:text-sky-400" />
              Gemini API Key
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Bring your own key: lessons, questions and grading run on your Gemini quota.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div
          className={`rounded-lg border px-3 py-2.5 text-xs flex items-center gap-2 ${
            statusLine.tone === 'ok'
              ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200'
              : statusLine.tone === 'info'
                ? 'border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-200'
                : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200'
          }`}
        >
          {statusLine.tone === 'warn' ? (
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          )}
          <span className="tabular-nums">{statusLine.text}</span>
        </div>

        <form onSubmit={handleSave} className="space-y-3">
          <label htmlFor="byok-input" className="text-xs font-medium text-slate-700 dark:text-slate-300">
            {status?.hasKey ? 'Replace key' : 'Paste your key'}
          </label>
          <div className="relative">
            <input
              id="byok-input"
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="AIza…"
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 pl-3 pr-10 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? 'Hide key' : 'Show key'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
            >
              {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-sky-700 dark:text-sky-400 hover:underline"
          >
            Get a free key from Google AI Studio
            <ExternalLink className="w-3 h-3" />
          </a>

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

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {status?.hasKey ? (
              confirmRemove ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={handleRemove}
                    className="px-3 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-medium cursor-pointer"
                  >
                    {busy === 'remove' ? 'Removing…' : 'Confirm remove'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(false)}
                    className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(true)}
                  className="px-3 py-2 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                >
                  Remove key
                </button>
              )
            ) : (
              <span />
            )}
            <button
              type="submit"
              disabled={!value.trim() || busy !== null}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-xs font-medium cursor-pointer"
            >
              {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {busy === 'save' ? 'Verifying…' : 'Verify & save'}
            </button>
          </div>
        </form>

        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-4">
          <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span>
            Your key is encrypted on our server (AES-256-GCM) before it is stored and is never sent back to the
            browser — only its last 4 characters are shown.
          </span>
        </p>
      </div>
    </div>
  );
};
