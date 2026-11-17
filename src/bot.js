import { getMenu } from './menu.js';
import { matchMenu } from './match.js';
import { isOpen } from './pricing.js';
import { menuLink, trackLink, ACTIVE } from './orders.js';
import { digits } from './whatsapp.js';

// Simple intent rules. They catch the common questions; anything unclear gets the menu link.
const HUMAN = /\b(human|staff|agent|person|manager|complain|complaint|refund|problem)\b|موظف|شكوى/i;
const ALLERGY = /\b(allerg\w*|nuts?|peanuts?|gluten|dairy|lactose|vegan|halal)\b|حساسية/i;
const HOURS = /\b(open|opening|close|closing|hours|timings?)\b|متى|ساعات/i;
const WHERE = /\b(where are you|location|address|directions)\b|وين|موقع/i;
const STATUS = /\b(status|where is my order|my order|track)\b|طلبي/i;

/** Handles one WhatsApp webhook payload (may hold several messages and delivery statuses). */
export async function handleWebhook(ctx, payload) {
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const s of v.statuses || []) ctx.db.prepare('UPDATE messages SET status = ? WHERE wa_id = ?').run(String(s.status), String(s.id));
      for (const m of v.messages || []) await handleMessage(ctx, m, v.contacts?.find((c) => c.wa_id === m.from));
    }
  }
}

async function handleMessage(ctx, m, contact) {
  const { db, wa, config } = ctx;
  const phone = digits(m.from);
  const text = (m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '').trim();
  const now = ctx.now();

  // Meta can deliver the same message twice; the unique wa_id makes the second one a no-op.
  if (db.prepare("INSERT OR IGNORE INTO messages(wa_id, phone, dir, body, status, at) VALUES(?, ?, 'in', ?, 'received', ?)")
    .run(String(m.id), phone, text || `[${m.type}]`, now).changes === 0) return;
  db.prepare(`INSERT INTO customers(phone, name, last_inbound_at, created_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET last_inbound_at = excluded.last_inbound_at, name = COALESCE(customers.name, excluded.name)`)
    .run(phone, contact?.profile?.name || null, now, now);

  // A staff member is handling this chat: stay quiet, just show it on the staff screen.
  const open = db.prepare('SELECT id FROM handoffs WHERE phone = ? AND replied_at IS NULL').get(phone);
  if (open) { ctx.bus.emit('handoff', { id: open.id, phone, text }); return; }

  const handoff = async (why) => {
    const r = db.prepare('INSERT INTO handoffs(phone, text, at) VALUES(?, ?, ?)').run(phone, text, now);
    ctx.bus.emit('handoff', { id: Number(r.lastInsertRowid), phone, text, why });
    await wa.send(phone, why === 'allergy'
      ? 'Thanks for telling us. A team member will confirm the ingredients with you here in a few minutes.'
      : 'A team member will reply to you here shortly.');
  };

  // Rating reply after delivery.
  if (/^[1-5]$/.test(text)) {
    const o = db.prepare("SELECT id FROM orders WHERE phone = ? AND status IN ('DELIVERED','COLLECTED') AND rating IS NULL AND delivered_at > ? ORDER BY id DESC LIMIT 1").get(phone, now - 86400000);
    if (o) {
      db.prepare('UPDATE orders SET rating = ? WHERE id = ?').run(Number(text), o.id);
      if (Number(text) <= 2) await handoff('low_rating');
      else await wa.send(phone, 'Thank you! 🙏 See you again soon.');
      return;
    }
  }
  if (HUMAN.test(text)) return handoff('asked');
  if (ALLERGY.test(text)) return handoff('allergy'); // food safety: a person answers, never the bot
  if (STATUS.test(text)) {
    const o = db.prepare(`SELECT id, status, track_token FROM orders WHERE phone = ? AND status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(phone, ...ACTIVE);
    if (o) return wa.send(phone, `Order #${o.id} is ${o.status.replace('_', ' ').toLowerCase()}.`, { label: 'Track your order', url: trackLink(ctx, o) });
  }
  if (HOURS.test(text)) return wa.send(phone, `We're open every day from ${config.shop.open} to ${config.shop.close}.`, { label: 'See the menu', url: menuLink(ctx, phone) });
  if (WHERE.test(text)) return wa.send(phone, `We're here: https://maps.google.com/?q=${config.shop.lat},${config.shop.lng}`);

  if (!isOpen(new Date(now), config.shop)) {
    return wa.send(phone, `We're closed right now. We open at ${config.shop.open}. You can look at the menu meanwhile.`, { label: 'See the menu', url: menuLink(ctx, phone) });
  }

  const items = getMenu(db).items.filter((i) => i.available);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const { exact, closest } = text ? matchMenu(text, items) : { exact: [], closest: [] };
  if (exact.length) {
    const lines = exact.map((e) => `${e.qty}× ${byId[e.id].name}`).join('\n');
    const c = encodeURIComponent(exact.map((e) => `${e.id}:${e.qty}`).join(','));
    return wa.send(phone, `Got it 👍\n${lines}\nTap below to check your cart, add extras, and pay.`, { label: 'Review your order', url: menuLink(ctx, phone, `&c=${c}`) });
  }
  if (closest.length) {
    const names = closest.map((id) => byId[id].name).join(', ');
    return wa.send(phone, `We don't have that exactly. Closest on our menu: ${names}.`, { label: `See ${byId[closest[0]].name}`.slice(0, 20), url: menuLink(ctx, phone, `&item=${closest[0]}`) });
  }
  const name = contact?.profile?.name ? ` ${contact.profile.name}` : '';
  return wa.send(phone, `Hi${name}! 👋 Welcome to ${config.shop.name}. Tap below to see the menu and order. You can also just type what you want, like "2 shawarma".`, { label: 'Open menu', url: menuLink(ctx, phone) });
}

/** Missed call or phone call → send the menu link on WhatsApp. */
export async function missedCall(ctx, phone) {
  phone = digits(phone);
  if (phone.length < 9) return { status: 'invalid' };
  return ctx.wa.send(phone, `Thanks for calling ${ctx.config.shop.name}! Order here on WhatsApp in a few taps.`, { label: 'Open menu', url: menuLink(ctx, phone) });
}
