function isServerWarmupResponse(status: number, rawText: string, contentType: string | null): boolean {
  const lower = rawText.toLowerCase();
  if (lower.includes('starting server')) {
    return true;
  }
  if ((status === 502 || status === 503) && contentType?.includes('text/html')) {
    return true;
  }
  return false;
}

const RATE_LIMIT_DELAYS_MS = [3000, 6000];

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  onRetryStatus?: (statusText: string | null) => void;
}

async function waitWithCountdown(
  delayMs: number,
  onRetryStatus?: (statusText: string | null) => void,
): Promise<void> {
  const totalSeconds = Math.ceil(delayMs / 1000);
  for (let remaining = totalSeconds; remaining > 0; remaining--) {
    onRetryStatus?.(`Cooling down API quota, retrying in ${remaining}s…`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  onRetryStatus?.('Retrying request…');
}

export async function safeFetchJson<T>(url: string, options: SafeFetchOptions = {}): Promise<T> {
  const maxWarmupAttempts = 6;
  const { timeoutMs = 45000, onRetryStatus, ...fetchInit } = options;

  let rateLimitRetries = 0;

  for (let attempt = 0; attempt < maxWarmupAttempts + RATE_LIMIT_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    let rawText: string;
    try {
      res = await fetch(url, {
        credentials: 'same-origin',
        ...fetchInit,
        signal: controller.signal,
      });
      rawText = await res.text();
    } catch (err) {
      window.clearTimeout(timer);
      onRetryStatus?.(null);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(
          `Request timed out after ${Math.round(timeoutMs / 1000)}s. Please retry.`,
        );
      }
      throw err instanceof Error ? err : new Error('Network request failed.');
    } finally {
      window.clearTimeout(timer);
    }

    const contentType = res.headers.get('content-type');

    if (isServerWarmupResponse(res.status, rawText, contentType)) {
      if (attempt < maxWarmupAttempts - 1) {
        onRetryStatus?.('Waking up backend server…');
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      onRetryStatus?.(null);
      throw new Error(
        'Server is still starting up after idle sleep. Please try again in a few seconds.',
      );
    }

    let parsed: unknown = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch {
      onRetryStatus?.(null);
      if (res.status === 403) {
        throw new Error(
          'Session authorization expired or blocked by preview proxy (HTTP 403). Please reload this page and try again.',
        );
      }
      if (res.status === 413) {
        throw new Error(
          'Upload payload exceeded the server 32 MB request limit. Try uploading fewer or smaller PDFs.',
        );
      }
      if (res.status === 504 || res.status === 502) {
        throw new Error(
          `Server gateway timeout or unavailable (HTTP ${res.status}). Please retry in a moment.`,
        );
      }
      const snippet = rawText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      throw new Error(
        `Unexpected non-JSON response (HTTP ${res.status})${snippet ? `: ${snippet}` : '.'}`,
      );
    }

    // Automatic exponential backoff retry (3s -> 6s) on 429 rate limit
    if (res.status === 429 && rateLimitRetries < RATE_LIMIT_DELAYS_MS.length) {
      const waitMs = RATE_LIMIT_DELAYS_MS[rateLimitRetries];
      rateLimitRetries++;
      await waitWithCountdown(waitMs, onRetryStatus);
      continue;
    }

    onRetryStatus?.(null);

    if (!res.ok) {
      const errObj = parsed as { error?: string; message?: string };
      throw new Error(errObj?.error || errObj?.message || `Request failed (HTTP ${res.status}).`);
    }

    return parsed as T;
  }

  onRetryStatus?.(null);
  throw new Error('Request failed while waiting for server or API quota cooldown.');
}
