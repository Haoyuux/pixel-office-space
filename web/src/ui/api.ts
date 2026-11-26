/** REST client for the UI. Never throws: failures come back as `{ ok: false, error }` with the server's error text. */
export type Result<T = unknown> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Result<T>> {
  try {
    const r = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: unknown = null;
    try { data = await r.json(); } catch { /* empty body */ }
    if (r.ok) return { ok: true, data: data as T };
    const error = (data as { error?: unknown } | null)?.error;
    return { ok: false, status: r.status, error: typeof error === 'string' ? error : `Request failed (${r.status})` };
  } catch (e) {
    return { ok: false, status: 0, error: `Server unreachable: ${(e as Error).message}` };
  }
}

const enc = encodeURIComponent;
export const paths = {
  projects: () => '/api/projects',
  project: (id: string) => `/api/projects/${enc(id)}`,
  tickets: (projectId: string) => `/api/projects/${enc(projectId)}/tickets`,
  gate: (ticketId: string, gate: string) => `/api/tickets/${enc(ticketId)}/gates/${enc(gate)}`,
  messages: (ticketId: string) => `/api/tickets/${enc(ticketId)}/messages`,
  cancel: (ticketId: string) => `/api/tickets/${enc(ticketId)}/cancel`,
};
