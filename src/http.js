// Tiny router + helpers on top of node:http (no framework needed for this size).
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function router({ corsOrigin = '*' } = {}) {
  const routes = [];
  const add = (method) => (path, handler) =>
    routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      if (req.method === 'OPTIONS') return send(res, 204);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      req.params = m.groups || {};
      req.query = Object.fromEntries(url.searchParams);
      try {
        const out = await r.handler(req, res);
        if (!res.headersSent && !res.writableEnded) send(res, 200, out ?? { ok: true });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
      }
      return;
    }
    send(res, 404, { error: 'Not found' });
  }
  return { get: add('GET'), post: add('POST'), patch: add('PATCH'), handle };
}

export function send(res, status, body, type = 'application/json') {
  if (body === undefined) { res.writeHead(status).end(); return; }
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }).end(text);
}

/** Raw request body (needed to verify WhatsApp signatures). Rejects bodies over 1 MB. */
export function rawBody(req, limit = 1_000_000) {
  if (req._raw) return Promise.resolve(req._raw);
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve((req._raw = Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

export async function json(req) {
  const raw = await rawBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Body must be valid JSON.'); }
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
