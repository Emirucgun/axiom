/**
 * BYOK (Bring Your Own Key). The raw key only ever travels browser → our
 * server over HTTPS; the server validates it with Gemini, encrypts it
 * (AES-256-GCM) and stores ciphertext in `user_api_keys`. The browser never
 * reads it back — only the last 4 characters for display.
 */
import { safeFetchJson } from '../utils/apiClient';

export interface ApiKeyStatus {
  provider: 'gemini';
  hasKey: boolean;
  keyHint: string | null;
  updatedAt?: string | null;
  /** True when the server has its own GEMINI_API_KEY to fall back on. */
  serverFallbackAvailable?: boolean;
}

export function getApiKeyStatus(): Promise<ApiKeyStatus> {
  return safeFetchJson<ApiKeyStatus>('/api/byok', { method: 'GET', timeoutMs: 20000 });
}

export function saveApiKey(apiKey: string): Promise<ApiKeyStatus> {
  return safeFetchJson<ApiKeyStatus>('/api/byok', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: apiKey.trim() }),
    timeoutMs: 30000,
  });
}

export function removeApiKey(): Promise<ApiKeyStatus> {
  return safeFetchJson<ApiKeyStatus>('/api/byok', { method: 'DELETE', timeoutMs: 20000 });
}

/** AI features work when the user has a key or the server provides a fallback. */
export function isAiAvailable(status: ApiKeyStatus | null): boolean {
  return Boolean(status && (status.hasKey || status.serverFallbackAvailable));
}
