export interface RetryOptions {
  attempts?: number;
  signal?: AbortSignal;
  /** Return a delay in milliseconds when the response should be retried. */
  retryAfter?: (response: Response) => number | undefined;
}

/** Retry transient transport and HTTP failures with bounded exponential backoff. */
export async function fetchWithRetry(
  request: () => Promise<Response>,
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? 4;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request aborted");
    try {
      const response = await request();
      const retryAfter = options.retryAfter?.(response) ?? retryDelay(response);
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        await response.body?.cancel().catch(() => undefined);
        await wait(retryAfter ?? Math.min(8_000, 500 * 2 ** attempt), options.signal);
        continue;
      }
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (attempt + 1 >= attempts) throw error;
      await wait(Math.min(8_000, 500 * 2 ** attempt), options.signal);
    }
  }
  throw lastError;
}

function retryDelay(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Request aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
