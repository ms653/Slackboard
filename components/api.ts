export class ApiError extends Error {
  constructor(public status: number, public code: string, public hint: string, public data: any = {}) { super(hint || code); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'network error');
  }
  const j = await res.json().catch(() => ({ ok: false, error: `http_${res.status}`, hint: '' }));
  if (!res.ok || !j.ok) {
    if (res.status === 401 && j.error === 'session_invalid') window.dispatchEvent(new Event('sb:session-expired'));
    throw new ApiError(res.status, j.error ?? `http_${res.status}`, j.hint ?? '', j);
  }
  return j as T;
}
