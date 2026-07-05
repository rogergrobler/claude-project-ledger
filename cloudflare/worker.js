/**
 * Project Ledger Cloudflare Worker  (v2 — adds the write route for auto-persist)
 *
 * Serves the partner's private dashboard from R2 behind Basic Auth, AND accepts
 * authenticated writes from the dashboard so that hitting "Done" (or deferring,
 * deleting, adding a note/task) is persisted to the backend automatically —
 * no "Send to Claude" copy-paste.
 *
 * Required bindings:
 *   - R2:     LEDGER  → ledger  (the bucket)
 *   - Secret: AUTH_PASS → the partner's dashboard password
 *
 * Routes (all behind Basic Auth):
 *   GET  /            → serve current.html from R2
 *   GET  /<key>       → serve that R2 object
 *   POST /api/change  → append one change as an immutable object under inbox/.
 *                       The Mac-side reconcile poller lists inbox/, applies each
 *                       change (drops Done cards, updates done-ledger), republishes
 *                       to R2, then deletes the processed inbox objects.
 *
 * Writing each change as its own object (keyed by time + uuid) means there is no
 * read-modify-write race on a shared file, even if several taps land together.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Basic Auth (every route) ─────────────────────────────────────────
    const expected = env.AUTH_PASS;
    if (expected) {
      const auth = request.headers.get('Authorization') || '';
      const decoded = auth.startsWith('Basic ') ? atob(auth.slice(6)) : '';
      const password = decoded.split(':')[1] || '';
      if (password !== expected) {
        return new Response('Authentication required', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Basic realm="Project Ledger"',
            'Content-Type': 'text/plain',
          },
        });
      }
    }

    // ── Write route: POST /api/change ────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/change') {
      let change;
      try {
        change = await request.json();
      } catch (e) {
        return json({ ok: false, error: 'bad json' }, 400);
      }
      if (!change || typeof change !== 'object' || !change.type) {
        return json({ ok: false, error: 'missing type' }, 400);
      }
      change.receivedAt = new Date().toISOString();
      const key = `inbox/${Date.now()}-${crypto.randomUUID()}.json`;
      await env.LEDGER.put(key, JSON.stringify(change), {
        httpMetadata: { contentType: 'application/json' },
      });
      return json({ ok: true, key });
    }

    // Only GET past this point.
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // ── Serve from R2 ────────────────────────────────────────────────────
    const key = url.pathname === '/' ? 'current.html' : url.pathname.slice(1);
    const object = await env.LEDGER.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'no-cache, max-age=0');
    return new Response(object.body, { headers });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
