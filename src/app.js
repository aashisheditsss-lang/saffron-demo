import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { openDb } from './db.js';
import { router, json, rawBody, send, HttpError } from './http.js';
import { getMenu } from './menu.js';
import { createWhatsApp, verifySignature } from './whatsapp.js';
import { createPayments } from './payments.js';
import { handleWebhook, missedCall } from './bot.js';
import { customerPhone, requireStaff, requireRider } from './auth.js';
import { createOrder, transition, getOrder, riderLocation, trackLink, ACTIVE } from './orders.js';
import { randomToken, sha256, safeEqual, sign, verify } from './tokens.js';
import { aed } from './pricing.js';

export function createApp(config, { fetch = globalThis.fetch, now = Date.now, db } = {}) {
  const ctx = { config, db: db || openDb(config.dbFile), bus: new EventEmitter(), fetch, now };
  ctx.bus.setMaxListeners(200);
  ctx.wa = createWhatsApp(ctx);
  ctx.payments = createPayments(ctx);
  const r = router({ corsOrigin: config.corsOrigin });
  const inList = (arr) => arr.map(() => '?').join(',');

  // ---------- WhatsApp ----------
  r.get('/webhooks/whatsapp', (req, res) => {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && safeEqual(q['hub.verify_token'] || '', config.wa.verifyToken)) return send(res, 200, q['hub.challenge'], 'text/plain');
    throw new HttpError(403, 'Verification failed.');
  });
  r.post('/webhooks/whatsapp', async (req) => {
    const raw = await rawBody(req);
    if (!verifySignature(raw, req.headers['x-hub-signature-256'], config.wa.appSecret)) throw new HttpError(401, 'Bad signature.');
    await handleWebhook(ctx, JSON.parse(raw.toString('utf8') || '{}'));
    return { ok: true };
  });
  // Phone system / missed-call service posts { phone } here.
  r.post('/webhooks/missed-call', async (req) => {
    if (!config.missedCallSecret || !safeEqual(req.headers['x-webhook-secret'] || '', config.missedCallSecret)) throw new HttpError(401, 'Bad secret.');
    return missedCall(ctx, (await json(req)).phone);
  });

  // ---------- Customer ----------
  r.get('/api/menu', () => ({ shop: publicShop(), ...getMenu(ctx.db) }));
  r.get('/api/me', async (req) => {
    const phone = await customerPhone(ctx, req, req.query.t);
    if (!phone) throw new HttpError(401, 'Link expired.');
    const c = ctx.db.prepare('SELECT name FROM customers WHERE phone = ?').get(phone);
    const last = ctx.db.prepare("SELECT address, lat, lng FROM orders WHERE phone = ? AND type = 'delivery' ORDER BY id DESC LIMIT 1").get(phone);
    return { phone: `+${phone.slice(0, 3)} •••• ${phone.slice(-4)}`, name: c?.name || null,
      lastAddress: last ? { ...JSON.parse(last.address), lat: last.lat, lng: last.lng } : null, cardPayments: ctx.payments.enabled };
  });
  r.post('/api/orders', async (req) => {
    const body = await json(req);
    return createOrder(ctx, await customerPhone(ctx, req, body.token), body);
  });
  r.get('/api/track', (req) => {
    const row = ctx.db.prepare('SELECT id FROM orders WHERE track_token = ?').get(String(req.query.k || ''));
    if (!row) throw new HttpError(404, 'Order not found.');
    const o = getOrder(ctx, row.id);
    if (o.delivered_at && ctx.now() - o.delivered_at > 2 * 3600000) throw new HttpError(410, 'This tracking link has ended.');
    const rider = o.rider_id && ['PICKED_UP', 'ARRIVING'].includes(o.status)
      ? ctx.db.prepare('SELECT name, lat, lng, loc_at AS locAt FROM riders WHERE id = ?').get(o.rider_id) : null;
    return { id: o.id, status: o.status, type: o.type, items: o.items, subtotal: o.subtotal, fee: o.fee, total: o.total, vat: o.vat,
      payment: o.payment_method, paymentStatus: o.payment_status, prepMin: o.prep_min, readyBy: o.ready_by,
      events: o.events.map(({ status, at }) => ({ status, at })), rider,
      shop: { lat: config.shop.lat, lng: config.shop.lng, name: config.shop.name, whatsapp: config.shop.whatsapp || null },
      destination: o.type === 'delivery' ? { lat: o.lat, lng: o.lng } : null };
  });

  // ---------- Mock card payment page ----------
  r.get('/pay/:id', (req, res) => {
    const p = ctx.payments.getSession(req.params.id);
    if (!p) throw new HttpError(404, 'Payment not found.');
    send(res, 200, `<!doctype html><meta name=viewport content="width=device-width"><title>Pay</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h2>Test payment</h2><p>Order #${p.order_id} · <b>${aed(p.amount)}</b></p><p style="color:#a00">This is a fake payment page for testing. No real money moves.</p>
<form method=post action="/pay/${encodeURIComponent(p.id)}/confirm"><button style="font-size:18px;padding:12px 24px">Pay ${aed(p.amount)}</button></form>`, 'text/html');
  });
  r.post('/pay/:id/confirm', async (req, res) => {
    const p = ctx.payments.getSession(req.params.id);
    if (!p) throw new HttpError(404, 'Payment not found.');
    const o = getOrder(ctx, p.order_id);
    if (o.status !== 'PAYMENT_PENDING' || !ctx.payments.markPaid(p.id)) throw new HttpError(409, 'This payment is no longer open.');
    await transition(ctx, o.id, 'CONFIRMED', { by: 'payment' });
    res.writeHead(303, { Location: trackLink(ctx, o) }).end();
  });

  // ---------- Staff (kitchen, reception, owner) ----------
  const staff = (path, fn) => r.post(path, async (req) => { requireStaff(ctx, req); return fn(req, await json(req)); });
  r.get('/api/staff/orders', (req) => {
    requireStaff(ctx, req);
    const since = dubaiMidnight(ctx.now());
    return ctx.db.prepare(`SELECT id FROM orders WHERE status IN (${inList(ACTIVE)}) OR created_at >= ? ORDER BY id DESC LIMIT 300`)
      .all(...ACTIVE, since).map((x) => getOrder(ctx, x.id));
  });
  staff('/api/staff/orders/:id/accept', (req, b) => transition(ctx, req.params.id, 'ACCEPTED', { prepMin: b.prepMin }));
  staff('/api/staff/orders/:id/reject', (req, b) => transition(ctx, req.params.id, 'REJECTED', { reason: b.reason }));
  staff('/api/staff/orders/:id/ready', (req) => transition(ctx, req.params.id, 'READY'));
  staff('/api/staff/orders/:id/assign', (req, b) => transition(ctx, req.params.id, 'RIDER_ASSIGNED', { riderId: b.riderId }));
  staff('/api/staff/orders/:id/unassign', (req) => transition(ctx, req.params.id, 'READY'));
  staff('/api/staff/orders/:id/collected', (req) => transition(ctx, req.params.id, 'COLLECTED'));
  staff('/api/staff/orders/:id/cancel', (req, b) => transition(ctx, req.params.id, 'CANCELLED', { reason: b.reason }));
  r.patch('/api/staff/menu/:id', async (req) => {
    requireStaff(ctx, req);
    const b = await json(req);
    if (typeof b.available !== 'boolean') throw new HttpError(400, 'Send { "available": true | false }.');
    if (!ctx.db.prepare('UPDATE menu_items SET available = ? WHERE id = ?').run(b.available ? 1 : 0, req.params.id).changes) throw new HttpError(404, 'Dish not found.');
    ctx.bus.emit('menu', { id: req.params.id, available: b.available });
    return { ok: true };
  });
  r.get('/api/staff/handoffs', (req) => {
    requireStaff(ctx, req);
    return ctx.db.prepare('SELECT * FROM handoffs WHERE replied_at IS NULL ORDER BY id').all().map((h) => ({
      ...h, messages: ctx.db.prepare('SELECT dir, body, at FROM messages WHERE phone = ? ORDER BY id DESC LIMIT 20').all(h.phone).reverse() }));
  });
  staff('/api/staff/handoffs/:id/reply', async (req, b) => {
    const h = ctx.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(Number(req.params.id));
    if (!h) throw new HttpError(404, 'Chat not found.');
    if (b.text) await ctx.wa.send(h.phone, String(b.text).slice(0, 4096));
    if (b.close !== false) ctx.db.prepare('UPDATE handoffs SET replied_at = ? WHERE id = ?').run(ctx.now(), h.id); // bot takes over again
    return { ok: true };
  });
  r.get('/api/staff/riders', (req) => { requireStaff(ctx, req); return ctx.db.prepare('SELECT id, name, phone, lat, lng, loc_at, active FROM riders').all(); });
  staff('/api/staff/riders', (req, b) => {
    if (!String(b.name || '').trim()) throw new HttpError(400, 'Rider name is required.');
    const token = randomToken(24);
    const x = ctx.db.prepare('INSERT INTO riders(name, phone, token_hash) VALUES(?, ?, ?)').run(String(b.name).trim().slice(0, 80), String(b.phone || ''), sha256(token));
    return { id: Number(x.lastInsertRowid), token, note: 'Give this token to the rider now. It is not shown again.' };
  });
  r.get('/api/staff/report', (req) => {
    requireStaff(ctx, req);
    const since = dubaiMidnight(ctx.now()), q = (sql) => ctx.db.prepare(sql).get(since);
    return {
      since,
      orders: q('SELECT COUNT(*) n FROM orders WHERE created_at >= ?').n,
      delivered: q("SELECT COUNT(*) n FROM orders WHERE created_at >= ? AND status IN ('DELIVERED','COLLECTED')").n,
      cancelled: q("SELECT COUNT(*) n FROM orders WHERE created_at >= ? AND status IN ('REJECTED','CANCELLED','EXPIRED')").n,
      revenue: q("SELECT COALESCE(SUM(total),0) s FROM orders WHERE created_at >= ? AND status IN ('DELIVERED','COLLECTED')").s,
      avgRating: q('SELECT AVG(rating) a FROM orders WHERE created_at >= ? AND rating IS NOT NULL').a,
      cashByRider: ctx.db.prepare(`SELECT r.name, COALESCE(SUM(o.cash_collected),0) cash FROM orders o JOIN riders r ON r.id = o.rider_id
        WHERE o.created_at >= ? AND o.payment_method = 'cod' AND o.status = 'DELIVERED' GROUP BY r.id`).all(since),
    };
  });
  // Live updates for the staff screens (Server-Sent Events). EventSource can't send headers, so the screen first
  // swaps its password (header) for a 60-second pass, and only that pass goes in the URL — never the password.
  r.post('/api/staff/stream-ticket', (req) => { requireStaff(ctx, req); return { ticket: sign({ staff: 1 }, config.secret, 60, ctx.now()) }; });
  r.get('/api/staff/stream', (req, res) => {
    if (!verify(req.query.ticket, config.secret, ctx.now())?.staff) throw new HttpError(401, 'Staff login required.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const subs = ['order', 'alert', 'handoff', 'rider', 'menu'].map((ev) => {
      const fn = (data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      ctx.bus.on(ev, fn); return [ev, fn];
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); subs.forEach(([ev, fn]) => ctx.bus.off(ev, fn)); });
  });

  // ---------- Rider ----------
  const mine = (rider, id) => {
    const o = getOrder(ctx, id);
    if (!o || o.rider_id !== rider.id) throw new HttpError(404, 'This order is not assigned to you.');
    return o;
  };
  r.get('/api/rider/orders', (req) => {
    const rider = requireRider(ctx, req);
    return ctx.db.prepare("SELECT id FROM orders WHERE rider_id = ? AND status IN ('RIDER_ASSIGNED','PICKED_UP','ARRIVING') ORDER BY id").all(rider.id)
      .map((x) => getOrder(ctx, x.id))
      .map((o) => ({ id: o.id, status: o.status, phone: o.phone, address: o.address, lat: o.lat, lng: o.lng, items: o.items,
        total: o.total, collect: o.payment_method === 'card' ? 0 : o.total, payment: o.payment_method }));
  });
  r.post('/api/rider/orders/:id/pickup', (req) => { const rd = requireRider(ctx, req); mine(rd, req.params.id); return transition(ctx, req.params.id, 'PICKED_UP', { by: `rider:${rd.id}` }).then(() => ({ ok: true })); });
  r.post('/api/rider/orders/:id/deliver', async (req) => {
    const rd = requireRider(ctx, req); mine(rd, req.params.id);
    // The rider can't choose the cash amount: the full total is recorded. Shortfalls are settled by staff at hand-in.
    await transition(ctx, req.params.id, 'DELIVERED', { by: `rider:${rd.id}` });
    return { ok: true };
  });
  r.post('/api/rider/location', async (req) => {
    const rd = requireRider(ctx, req), b = await json(req);
    await riderLocation(ctx, rd, Number(b.lat), Number(b.lng));
    return { ok: true };
  });

  // ---------- Dev helpers ----------
  if (!config.production) {
    r.get('/api/dev/outbox', () => ctx.db.prepare("SELECT phone, body, status, at FROM messages WHERE dir = 'out' ORDER BY id DESC LIMIT 50").all());
  }
  // ---------- Web pages (customer menu + tracking, staff, rider) ----------
  for (const page of ['menu', 'track', 'staff', 'rider', 'home']) r.get(`/${page}`, (req, res) => serveFile(res, `${page}.html`));
  r.get('/', (req, res) => serveFile(res, 'site.html')); // product showcase; /home is the sample restaurant's own site
  r.get('/static/:f', (req, res) => serveFile(res, req.params.f));
  r.get('/img/:f', (req, res) => serveFile(res, `img/${req.params.f}`));

  r.get('/health',() => ({ ok: true, whatsapp: ctx.wa.live ? 'live' : 'mock', supabase: !!config.supabase.url }));

  function publicShop() {
    const s = config.shop;
    return { name: s.name, whatsapp: s.whatsapp || null, lat: s.lat, lng: s.lng, radiusKm: s.radiusKm, deliveryFee: s.deliveryFee, minOrder: s.minOrder, open: s.open, close: s.close,
      cardPayments: ctx.payments.enabled, supabase: config.supabase.url ? { url: config.supabase.url, anonKey: config.supabase.anonKey } : null };
  }

  const server = createServer((req, res) => r.handle(req, res));
  return { ctx, server };
}

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
async function serveFile(res, name) {
  const type = TYPES[extname(name)];
  if (!type || name.includes('..')) throw new HttpError(404, 'Not found');
  const buf = await readFile(join(PUBLIC, name)).catch(() => null);
  if (!buf) throw new HttpError(404, 'Not found');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type.startsWith('image') ? 'public, max-age=86400' : 'no-cache' }).end(buf);
}

// Dubai is UTC+4 all year (no daylight saving).
const dubaiMidnight = (ms) => { const off = 4 * 3600000; return Math.floor((ms + off) / 86400000) * 86400000 - off; };
