import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runJobs, menuLink } from '../src/orders.js';
import { priceCart, vatIncluded, isOpen } from '../src/pricing.js';
import { matchMenu } from '../src/match.js';
import { getMenu } from '../src/menu.js';
import { sign, verify } from '../src/tokens.js';

const CUSTOMER = '971501234567';
const SHOP = { lat: 25.1852, lng: 55.2721 };
const HOME = { lat: 25.1900, lng: 55.2750, building: 'Burj Views A', flat: '1204' }; // ~0.6 km away

async function start(extraEnv = {}, fakeFetch) {
  let clock = Date.UTC(2026, 10, 17, 10, 0);
  const config = loadConfig({ DB_FILE: ':memory:', OPEN_TIME: '00:00', CLOSE_TIME: '00:00', WA_APP_SECRET: 'appsecret',
    MISSED_CALL_SECRET: 'mc', ...extraEnv });
  const app = createApp(config, { now: () => clock, fetch: fakeFetch || (async () => { throw new Error('no network in tests'); }) });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  const inbound = async (text, id = String(Math.random())) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: CUSTOMER, profile: { name: 'Sara' } }],
      messages: [{ id, from: CUSTOMER, type: 'text', text: { body: text } }] } }] }] });
    const sig = 'sha256=' + createHmac('sha256', 'appsecret').update(raw).digest('hex');
    return fetch(base + '/webhooks/whatsapp', { method: 'POST', headers: { 'X-Hub-Signature-256': sig }, body: raw });
  };
  const lastOut = () => app.ctx.db.prepare("SELECT body FROM messages WHERE dir = 'out' ORDER BY id DESC LIMIT 1").get()?.body || '';
  const tick = (ms) => { clock += ms; };
  return { app, call, inbound, lastOut, tick, close: () => app.server.close() };
}

test('pricing: add-ons, VAT included, bad input refused', async () => {
  const t = await start();
  const p = priceCart(t.app.ctx.db, [{ id: 'mango', qty: 1, addons: ['lg', 'cream'] }], { type: 'delivery', deliveryFee: 0 });
  assert.equal(p.total, 2300); // AED 14 + 4 + 5
  assert.equal(p.vat, vatIncluded(2300));
  assert.throws(() => priceCart(t.app.ctx.db, [{ id: 'mango', qty: 1, addons: ['honey'] }], { type: 'pickup' }), /add-on/);
  assert.throws(() => priceCart(t.app.ctx.db, [{ id: 'mango', qty: 0 }], { type: 'pickup' }), /between 1 and 20/);
  t.close();
});

test('opening hours past midnight and tokens', () => {
  const h = { open: '10:00', close: '02:00', tz: 'Asia/Dubai' };
  assert.equal(isOpen(new Date('2026-11-17T21:30:00Z'), h), true);  // 01:30 Dubai
  assert.equal(isOpen(new Date('2026-11-17T23:00:00Z'), h), false); // 03:00 Dubai
  const tok = sign({ p: '1' }, 's', 60, 0);
  assert.equal(verify(tok, 's', 1000).p, '1');
  assert.equal(verify(tok, 'other', 1000), null);
  assert.equal(verify(tok, 's', 61000), null);
});

test('menu matching: typos and closest dish', async () => {
  const t = await start();
  const items = getMenu(t.app.ctx.db).items;
  assert.deepEqual(matchMenu('2 chiken biriyani and one shwarma', items).exact, [{ id: 'shawarma', qty: 1 }, { id: 'biryani', qty: 2 }]);
  assert.deepEqual(matchMenu('orange juice', items), { exact: [], closest: ['mango'] });
  t.close();
});

test('end to end: WhatsApp → order → kitchen → rider → delivered → rating', async () => {
  const t = await start();
  // Bad signature is refused.
  const bad = await fetch(t.app.ctx.config.publicUrl.replace('8080', t.app.server.address().port) + '/webhooks/whatsapp', { method: 'POST', body: '{}' });
  assert.equal(bad.status, 401);

  await t.inbound('hi', 'm1');
  assert.match(t.lastOut(), /Welcome/);
  await t.inbound('hi', 'm1'); // duplicate delivery from Meta → ignored
  assert.equal(t.app.ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE dir='out'").get().n, 1);

  await t.inbound('2 shawarma pls');
  assert.match(t.lastOut(), /2× Chicken Shawarma[\s\S]*c=shawarma%3A2/);
  const token = new URL(t.lastOut().match(/https?:\S+/)[0]).searchParams.get('t');

  const me = await t.call('GET', `/api/me?t=${encodeURIComponent(token)}`);
  assert.equal(me.data.name, 'Sara');

  const far = await t.call('POST', '/api/orders', { token, type: 'delivery', payment: 'cod', items: [{ id: 'shawarma', qty: 2 }], address: { ...HOME, lat: 25.3 } });
  assert.equal(far.status, 400);

  const body = { token, idemKey: 'k1', type: 'delivery', payment: 'cod', items: [{ id: 'shawarma', qty: 2 }, { id: 'mango', qty: 1, addons: ['lg'] }], address: HOME };
  const o = await t.call('POST', '/api/orders', body);
  assert.equal(o.status, 200);
  assert.equal(o.data.status, 'CONFIRMED');
  assert.equal(o.data.total, 4200); // 2×12 + 14 + 4
  assert.equal((await t.call('POST', '/api/orders', body)).data.id, o.data.id); // double tap → same order
  assert.match(t.lastOut(), /Order #1 confirmed[\s\S]*AED 42.00/);
  const k = new URL(o.data.trackUrl).searchParams.get('k');

  // Staff auth + kitchen.
  assert.equal((await t.call('GET', '/api/staff/orders')).status, 401);
  assert.equal((await t.call('POST', '/api/staff/orders/1/ready', {}, 'dev-staff')).status, 409); // can't skip accept
  assert.equal((await t.call('POST', '/api/staff/orders/1/accept', { prepMin: 15 }, 'dev-staff')).data.status, 'ACCEPTED');
  assert.match(t.lastOut(), /15 min/);
  await t.call('POST', '/api/staff/orders/1/ready', {}, 'dev-staff');

  // Rider.
  const rider = (await t.call('POST', '/api/staff/riders', { name: 'Imran' }, 'dev-staff')).data;
  assert.equal((await t.call('POST', '/api/staff/orders/1/assign', { riderId: rider.id }, 'dev-staff')).data.status, 'RIDER_ASSIGNED');
  assert.equal((await t.call('GET', '/api/rider/orders', undefined, rider.token)).data[0].collect, 4200);
  await t.call('POST', '/api/rider/orders/1/pickup', {}, rider.token);
  assert.match(t.lastOut(), /On the way[\s\S]*Track your order/);
  await t.call('POST', '/api/rider/location', SHOP, rider.token);
  assert.equal((await t.call('GET', `/api/track?k=${k}`)).data.rider.name, 'Imran');
  await t.call('POST', '/api/rider/location', { lat: 25.1895, lng: 55.2748 }, rider.token); // ~100 m away
  assert.equal((await t.call('GET', `/api/track?k=${k}`)).data.status, 'ARRIVING');
  assert.match(t.lastOut(), /2 minutes away[\s\S]*AED 42.00 in cash/);
  await t.call('POST', '/api/rider/orders/1/deliver', {}, rider.token);
  assert.match(t.lastOut(), /Delivered/);

  await t.inbound('5');
  assert.equal(t.app.ctx.db.prepare('SELECT rating FROM orders WHERE id = 1').get().rating, 5);
  const report = (await t.call('GET', '/api/staff/report', undefined, 'dev-staff')).data;
  assert.equal(report.revenue, 4200);
  assert.deepEqual(report.cashByRider, [{ name: 'Imran', cash: 4200 }]);

  t.tick(3 * 3600000);
  assert.equal((await t.call('GET', `/api/track?k=${k}`)).status, 410);
  t.close();
});

test('bot: closest dish, allergy goes to staff, sold out', async () => {
  const t = await start();
  await t.inbound('orange juice');
  assert.match(t.lastOut(), /Closest on our menu: Fresh Mango Juice[\s\S]*item=mango/);
  await t.inbound('does the kunafa have nuts?');
  assert.match(t.lastOut(), /team member will confirm/);
  await t.inbound('hello?'); // bot stays quiet while staff handles the chat
  assert.match(t.lastOut(), /team member will confirm/);
  const h = (await t.call('GET', '/api/staff/handoffs', undefined, 'dev-staff')).data[0];
  await t.call('POST', `/api/staff/handoffs/${h.id}/reply`, { text: 'Yes, pistachio.' }, 'dev-staff');
  assert.equal(t.lastOut(), 'Yes, pistachio.');

  await t.call('PATCH', '/api/staff/menu/kunafa', { available: false }, 'dev-staff');
  const token = new URL(menuLink(t.app.ctx, CUSTOMER)).searchParams.get('t');
  const r = await t.call('POST', '/api/orders', { token, type: 'pickup', payment: 'cod', items: [{ id: 'kunafa', qty: 1 }] });
  assert.equal(r.status, 409);
  t.close();
});

test('card payment: pay page confirms; unpaid order expires after 15 min', async () => {
  const t = await start();
  const token = new URL(menuLink(t.app.ctx, CUSTOMER)).searchParams.get('t');
  const a = (await t.call('POST', '/api/orders', { token, type: 'pickup', payment: 'card', items: [{ id: 'falafel', qty: 1 }] })).data;
  assert.equal(a.status, 'PAYMENT_PENDING');
  const payPath = new URL(a.payUrl).pathname;
  assert.match((await t.call('GET', payPath)).data, /AED 10.00/);
  assert.equal((await t.call('POST', payPath + '/confirm')).status, 303);
  assert.match(t.lastOut(), /confirmed/);
  assert.equal((await t.call('POST', payPath + '/confirm')).status, 409); // can't pay twice

  const b = (await t.call('POST', '/api/orders', { token, type: 'pickup', payment: 'card', items: [{ id: 'falafel', qty: 1 }] })).data;
  t.tick(16 * 60000);
  await runJobs(t.app.ctx);
  assert.equal(t.app.ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(b.id).status, 'EXPIRED');
  t.close();
});

test('security: rider cannot set cash amount; staff password never accepted in the URL', async () => {
  const t = await start();
  const token = new URL(menuLink(t.app.ctx, CUSTOMER)).searchParams.get('t');
  const o = (await t.call('POST', '/api/orders', { token, type: 'delivery', payment: 'cod', items: [{ id: 'grill', qty: 1 }], address: HOME })).data;
  for (const step of [['accept', { prepMin: 10 }], ['ready', {}]]) await t.call('POST', `/api/staff/orders/${o.id}/${step[0]}`, step[1], 'dev-staff');
  const rider = (await t.call('POST', '/api/staff/riders', { name: 'R' }, 'dev-staff')).data;
  await t.call('POST', `/api/staff/orders/${o.id}/assign`, { riderId: rider.id }, 'dev-staff');
  await t.call('POST', `/api/rider/orders/${o.id}/pickup`, {}, rider.token);
  await t.call('POST', `/api/rider/orders/${o.id}/deliver`, { cashCollected: 1 }, rider.token); // tries to report AED 0.01
  assert.equal(t.app.ctx.db.prepare('SELECT cash_collected FROM orders WHERE id = ?').get(o.id).cash_collected, 5500);

  assert.equal((await t.call('GET', '/api/staff/orders?token=dev-staff')).status, 401);
  assert.equal((await t.call('GET', '/api/staff/stream?token=dev-staff')).status, 401);
  assert.equal((await t.call('GET', `/api/staff/stream?ticket=${encodeURIComponent(token)}`)).status, 401); // a customer link is not a staff pass
  const { ticket } = (await t.call('POST', '/api/staff/stream-ticket', {}, 'dev-staff')).data;
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${t.app.server.address().port}/api/staff/stream?ticket=${encodeURIComponent(ticket)}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  ctrl.abort();
  t.tick(61000);
  assert.equal((await t.call('GET', `/api/staff/stream?ticket=${encodeURIComponent(ticket)}`)).status, 401); // expired
  t.close();
});

test('web pages and photos are served; path tricks are refused', async () => {
  const t = await start();
  for (const p of ['/menu', '/track', '/staff', '/rider']) assert.match((await t.call('GET', p)).data, /<!doctype html>/);
  const img = await fetch(`http://127.0.0.1:${t.app.server.address().port}/img/mango.jpg`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await t.call('GET', '/static/..%2Fsrc%2Fconfig.js')).status, 404);
  t.close();
});

test('Supabase phone login can place an order; unverified phone cannot', async () => {
  const users = { good: { phone: '971509999999', phone_confirmed_at: '2026-11-17' }, unverified: { phone: '971508888888', phone_confirmed_at: null } };
  const fake = async (url, opts) => {
    assert.equal(url, 'https://proj.supabase.co/auth/v1/user');
    const u = users[opts.headers.Authorization.slice(7)];
    return { ok: !!u, json: async () => u };
  };
  const t = await start({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon' }, fake);
  const order = { type: 'pickup', payment: 'cod', items: [{ id: 'hummus', qty: 1 }] };
  assert.equal((await t.call('POST', '/api/orders', order, 'good')).data.status, 'CONFIRMED');
  assert.equal(t.app.ctx.db.prepare('SELECT phone FROM orders WHERE id = 1').get().phone, '971509999999');
  assert.equal((await t.call('POST', '/api/orders', order, 'unverified')).status, 401);
  assert.equal((await t.call('POST', '/api/orders', order, 'forged')).status, 401);
  t.close();
});
