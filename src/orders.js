import { HttpError } from './http.js';
import { tx } from './db.js';
import { priceCart, haversineKm, isOpen, aed } from './pricing.js';
import { sign, verify, randomToken } from './tokens.js';

// Which status can follow which. Anything else is refused.
export const FLOW = {
  PAYMENT_PENDING: ['CONFIRMED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['READY', 'CANCELLED'],
  READY: ['RIDER_ASSIGNED', 'COLLECTED', 'CANCELLED'],
  RIDER_ASSIGNED: ['PICKED_UP', 'READY'], // READY again = unassign rider
  PICKED_UP: ['ARRIVING', 'DELIVERED'],
  ARRIVING: ['DELIVERED'],
};
export const ACTIVE = Object.keys(FLOW);
export const ARRIVING_KM = 0.3;
const PAY_LABEL = { card: 'Card (paid online)', cod: 'Cash on delivery', cardod: 'Card machine on delivery' };

export function getOrder(ctx, id) {
  const o = ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
  if (!o) return null;
  o.items = ctx.db.prepare('SELECT item_id, name, qty, unit, addons FROM order_items WHERE order_id = ?').all(o.id)
    .map((i) => ({ ...i, addons: JSON.parse(i.addons) }));
  o.address = o.address ? JSON.parse(o.address) : null;
  o.events = ctx.db.prepare('SELECT status, by, note, at FROM order_events WHERE order_id = ? ORDER BY id').all(o.id);
  return o;
}

export const menuLink = (ctx, phone, extra = '') =>
  `${ctx.config.menuUrl}?t=${encodeURIComponent(sign({ p: phone }, ctx.config.secret, 7 * 86400, ctx.now()))}${extra}`;
export const trackLink = (ctx, o) => `${ctx.config.trackUrl}?k=${o.track_token}`;
export const customerFromToken = (ctx, t) => verify(t, ctx.config.secret, ctx.now())?.p || null;

const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/** Customer places an order from the menu page. */
export async function createOrder(ctx, phone, body) {
  const { db, config } = ctx;
  if (!phone) throw new HttpError(401, 'This menu link has expired. Send us any message on WhatsApp for a new one, or log in with your phone number.');
  if (!isOpen(new Date(ctx.now()), config.shop)) throw new HttpError(409, `We're closed right now. We open at ${config.shop.open}.`);

  const idem = body.idemKey ? `${phone}:${str(body.idemKey, 64)}` : null; // same tap sent twice = same order
  if (idem) {
    const prev = db.prepare('SELECT id FROM orders WHERE idem_key = ?').get(idem);
    if (prev) return orderResult(ctx, getOrder(ctx, prev.id));
  }

  const type = ['delivery', 'pickup'].includes(body.type) ? body.type : null;
  if (!type) throw new HttpError(400, 'Choose delivery or pickup.');
  const payment = ['card', 'cod', 'cardod'].includes(body.payment) ? body.payment : null;
  if (!payment) throw new HttpError(400, 'Choose how you want to pay.');
  if (payment === 'card' && !ctx.payments.enabled) throw new HttpError(400, 'Online card payment is not available yet. Choose cash or card on delivery.');

  let address = null, lat = null, lng = null;
  if (type === 'delivery') {
    const a = body.address || {};
    lat = Number(a.lat); lng = Number(a.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Drop a pin on the map so the rider can find you.');
    if (!str(a.building, 120)) throw new HttpError(400, 'Add your building or street name.');
    if (haversineKm({ lat, lng }, config.shop) > config.shop.radiusKm) throw new HttpError(400, `Sorry, we only deliver within ${config.shop.radiusKm} km of the restaurant.`);
    address = { building: str(a.building, 120), flat: str(a.flat, 60), landmark: str(a.landmark, 200), makani: str(a.makani, 20) };
  }

  const priced = priceCart(db, body.items, { type, deliveryFee: config.shop.deliveryFee });
  if (type === 'delivery' && priced.subtotal < config.shop.minOrder) throw new HttpError(400, `Minimum order for delivery is ${aed(config.shop.minOrder)}.`);

  const now = ctx.now();
  const status = payment === 'card' ? 'PAYMENT_PENDING' : 'CONFIRMED';
  const id = tx(db, () => {
    db.prepare(`INSERT INTO customers(phone, name, created_at) VALUES(?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, customers.name)`).run(phone, str(body.name, 80) || null, now);
    const r = db.prepare(`INSERT INTO orders(phone, type, status, payment_method, payment_status, subtotal, fee, total, vat,
      address, lat, lng, track_token, idem_key, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(phone, type, status, payment, payment === 'card' ? 'pending' : 'on_delivery', priced.subtotal, priced.fee, priced.total, priced.vat,
        address && JSON.stringify(address), lat, lng, randomToken(18), idem, now, now);
    const oid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO order_items(order_id, item_id, name, qty, unit, addons) VALUES(?,?,?,?,?,?)');
    for (const i of priced.items) ins.run(oid, i.itemId, i.name, i.qty, i.unit, JSON.stringify(i.addons));
    db.prepare('INSERT INTO order_events(order_id, status, by, at) VALUES(?,?,?,?)').run(oid, status, 'customer', now);
    return oid;
  });

  const order = getOrder(ctx, id);
  if (payment === 'card') return { ...orderResult(ctx, order), payUrl: ctx.payments.createSession(order).url };
  await notify(ctx, order);
  ctx.bus.emit('order', order);
  return orderResult(ctx, order);
}

const orderResult = (ctx, o) => ({ id: o.id, status: o.status, total: o.total, trackUrl: trackLink(ctx, o) });

/**
 * Move an order to its next status. `by` = 'staff' | 'rider:<id>' | 'customer' | 'system' | 'payment'.
 * Safe when two people tap at once: only one update wins, the other gets a 409.
 */
export async function transition(ctx, id, to, { by = 'staff', prepMin, riderId, reason, cashCollected } = {}) {
  const { db } = ctx;
  const o = getOrder(ctx, id);
  if (!o) throw new HttpError(404, 'Order not found.');
  if (!(FLOW[o.status] || []).includes(to)) throw new HttpError(409, `Order #${o.id} is ${o.status.toLowerCase()} and can't change to ${to.toLowerCase()}.`);

  const now = ctx.now();
  const set = { status: to, updated_at: now };
  if (to === 'ACCEPTED') {
    const m = Number(prepMin);
    if (!Number.isInteger(m) || m < 1 || m > 180) throw new HttpError(400, 'Pick a prep time between 1 and 180 minutes.');
    Object.assign(set, { prep_min: m, ready_by: now + m * 60000 });
  }
  if (to === 'RIDER_ASSIGNED') {
    if (o.type !== 'delivery') throw new HttpError(409, 'Pickup orders do not need a rider.');
    const rider = db.prepare('SELECT id FROM riders WHERE id = ? AND active = 1').get(Number(riderId));
    if (!rider) throw new HttpError(400, 'Choose an active rider.');
    set.rider_id = rider.id;
  }
  if (to === 'READY' && o.status === 'RIDER_ASSIGNED') set.rider_id = null;
  if (to === 'COLLECTED' && o.type !== 'pickup') throw new HttpError(409, 'Only pickup orders can be marked collected.');
  if (to === 'PICKED_UP' && o.type !== 'delivery') throw new HttpError(409, 'Only delivery orders are picked up by a rider.');
  if (to === 'DELIVERED' || to === 'COLLECTED') {
    set.delivered_at = now;
    if (o.payment_method !== 'card') { set.payment_status = 'paid'; set.cash_collected = cashCollected == null ? o.total : Math.round(Number(cashCollected)); }
  }
  if (to === 'CONFIRMED' && o.status === 'PAYMENT_PENDING') set.payment_status = 'paid';
  if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(to) && o.payment_status === 'paid') set.payment_status = ctx.payments.refund(o);

  const cols = Object.keys(set); // fixed keys above, never user input
  const changed = tx(db, () => {
    const r = db.prepare(`UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = ?`)
      .run(...cols.map((c) => set[c]), o.id, o.status);
    if (r.changes !== 1) return false;
    db.prepare('INSERT INTO order_events(order_id, status, by, note, at) VALUES(?,?,?,?,?)').run(o.id, to, by, str(reason, 300) || null, now);
    return true;
  });
  if (!changed) throw new HttpError(409, `Order #${o.id} was just updated by someone else. Refresh and try again.`);

  const updated = getOrder(ctx, o.id);
  await notify(ctx, updated, { reason });
  ctx.bus.emit('order', updated);
  return updated;
}

/** The WhatsApp message the customer gets for each status. */
export async function notify(ctx, o, { reason } = {}) {
  const items = o.items.map((i) => `${i.qty}× ${i.name}${i.addons.length ? ` (+ ${i.addons.map((a) => a.name).join(', ')})` : ''}`).join('\n');
  const where = o.type === 'delivery' ? `To: ${o.address.building}${o.address.flat ? ', ' + o.address.flat : ''}` : `Pickup at ${ctx.config.shop.name}`;
  const track = { label: 'Track your order', url: trackLink(ctx, o) };
  const msg = {
    CONFIRMED: [`✅ *Order #${o.id} confirmed*\n${items}\n${o.fee ? `Delivery ${aed(o.fee)}\n` : ''}*Total ${aed(o.total)}* (incl. VAT ${aed(o.vat)})\nPayment: ${PAY_LABEL[o.payment_method]}\n${where}\nWe'll update you here at every step.`, track],
    ACCEPTED: [`👨‍🍳 The kitchen has started order #${o.id}. Ready in about ${o.prep_min} min.`],
    REJECTED: [`We're sorry, we can't make order #${o.id} right now${reason ? ` (${reason})` : ''}. ${o.payment_status === 'refunded' || o.payment_status === 'refund_pending' ? 'Your card payment will be refunded.' : 'You have not been charged.'} Reply here and we'll help.`],
    CANCELLED: [`Order #${o.id} has been cancelled${reason ? ` (${reason})` : ''}. ${o.payment_status === 'refunded' || o.payment_status === 'refund_pending' ? 'Your card payment will be refunded.' : ''}`.trim()],
    EXPIRED: [`Order #${o.id} was cancelled because the payment wasn't completed. Send us a message to order again.`],
    READY: o.type === 'pickup' ? [`🛍️ Order #${o.id} is ready. Collect it at ${ctx.config.shop.name}.`] : null,
    PICKED_UP: [`🛵 *On the way!* Your order #${o.id} has left the restaurant.`, track],
    ARRIVING: [`📍 Your rider is about 2 minutes away.${o.payment_method === 'cod' ? ` Please keep ${aed(o.total)} in cash ready.` : ''}`],
    DELIVERED: [`🎉 Delivered. Enjoy your meal!\nHow was it? Reply with a number from 1 to 5.`],
    COLLECTED: [`🎉 Thanks for collecting your order. Enjoy!\nHow was it? Reply with a number from 1 to 5.`],
  }[o.status];
  if (msg) await ctx.wa.send(o.phone, msg[0], msg[1]);
}

/** Rider GPS update. Sends the "arriving" message once when within ~300 m. */
export async function riderLocation(ctx, rider, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, 'Location must have numeric lat and lng.');
  ctx.db.prepare('UPDATE riders SET lat = ?, lng = ?, loc_at = ? WHERE id = ?').run(lat, lng, ctx.now(), rider.id);
  const onTheWay = ctx.db.prepare("SELECT id, lat, lng FROM orders WHERE rider_id = ? AND status = 'PICKED_UP'").all(rider.id);
  for (const o of onTheWay) {
    if (haversineKm({ lat, lng }, o) <= ARRIVING_KM) await transition(ctx, o.id, 'ARRIVING', { by: 'system' }).catch(() => {});
  }
  ctx.bus.emit('rider', { id: rider.id, lat, lng });
}

/** Background checks, run every ~30 s by the server (and directly in tests). */
export async function runJobs(ctx) {
  const now = ctx.now(), { db, bus } = ctx;
  // 1) Unpaid card orders expire after 15 min.
  for (const o of db.prepare("SELECT id FROM orders WHERE status = 'PAYMENT_PENDING' AND created_at < ?").all(now - 15 * 60000)) {
    await transition(ctx, o.id, 'EXPIRED', { by: 'system' }).catch(() => {});
  }
  // 2) Kitchen hasn't accepted within 3 min → alert reception/manager (once).
  for (const o of db.prepare("SELECT id FROM orders WHERE status = 'CONFIRMED' AND (alerted & 1) = 0 AND updated_at < ?").all(now - 3 * 60000)) {
    db.prepare('UPDATE orders SET alerted = alerted | 1 WHERE id = ?').run(o.id);
    bus.emit('alert', { orderId: o.id, kind: 'kitchen_not_accepted', text: `Order #${o.id} has waited over 3 minutes for the kitchen.` });
  }
  // 3) Rider GPS silent for 60 s while delivering → alert dispatcher (once).
  for (const o of db.prepare(`SELECT o.id, r.name FROM orders o JOIN riders r ON r.id = o.rider_id
      WHERE o.status IN ('PICKED_UP','ARRIVING') AND (o.alerted & 2) = 0 AND (r.loc_at IS NULL OR r.loc_at < ?)`).all(now - 60000)) {
    db.prepare('UPDATE orders SET alerted = alerted | 2 WHERE id = ?').run(o.id);
    bus.emit('alert', { orderId: o.id, kind: 'rider_gps_lost', text: `No location from ${o.name} for over a minute (order #${o.id}).` });
  }
}
