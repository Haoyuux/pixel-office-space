/** REST client for the UI. Never throws: failures come back as `{ ok: false, error }` with the server's error text. */
export type Result<T = unknown> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Result<T>> {
  try {
    // every mutation is JSON (even cancel/delete): the server refuses other content types to block cross-site posts
    const mutation = method !== 'GET';
    const r = await fetch(path, {
      method,
      headers: mutation ? { 'Content-Type': 'application/json' } : undefined,
      body: mutation ? JSON.stringify(body ?? {}) : undefined,
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
  resume: (ticketId: string) => `/api/tickets/${enc(ticketId)}/resume`,
  stop: (ticketId: string) => `/api/tickets/${enc(ticketId)}/stop`,
  gitInit: (projectId: string) => `/api/projects/${enc(projectId)}/git-init`,
  attachments: (projectId: string) => `/api/projects/${enc(projectId)}/attachments`,
  files: (projectId: string, q: string) => `/api/projects/${enc(projectId)}/files?q=${enc(q)}`,
  conversation: (rootId: string) => `/api/conversations/${enc(rootId)}`,
  summary: (since: string) => `/api/summary?since=${enc(since)}`,
  devServer: (projectId: string) => `/api/projects/${enc(projectId)}/devserver`,
  devServerStart: (projectId: string) => `/api/projects/${enc(projectId)}/devserver/start`,
  devServerStop: (projectId: string) => `/api/projects/${enc(projectId)}/devserver/stop`,
  memory: (projectId: string) => `/api/projects/${enc(projectId)}/memory`,
  memoryEntry: (projectId: string, entryId: string) => `/api/projects/${enc(projectId)}/memory/${enc(entryId)}`,
};
