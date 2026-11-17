import { HttpError } from './http.js';

/**
 * Price a cart on the server (never trust prices from the browser).
 * lines: [{ id, qty, addons: [addonId] }]. Returns amounts in fils; UAE prices include 5% VAT.
 */
export function priceCart(db, lines, { type, deliveryFee = 0 }) {
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Your cart is empty.');
  if (lines.length > 50) throw new HttpError(400, 'Too many lines in one order.');
  const getItem = db.prepare('SELECT id, name_en, price, available FROM menu_items WHERE id = ?');
  const getAddon = db.prepare('SELECT id, name, price FROM addons WHERE item_id = ? AND id = ?');

  const items = lines.map((l) => {
    const item = getItem.get(String(l?.id ?? ''));
    if (!item) throw new HttpError(400, 'One of the items is no longer on the menu. Please refresh the menu.');
    if (!item.available) throw new HttpError(409, `Sorry, ${item.name_en} is sold out right now.`);
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, `Choose between 1 and 20 of ${item.name_en}.`);
    const ids = [...new Set(Array.isArray(l.addons) ? l.addons.map(String) : [])];
    const addons = ids.map((a) => {
      const found = getAddon.get(item.id, a);
      if (!found) throw new HttpError(400, `That add-on isn't available for ${item.name_en}.`);
      return found;
    });
    const unit = item.price + addons.reduce((s, a) => s + a.price, 0);
    return { itemId: item.id, name: item.name_en, qty, unit, addons };
  });

  const subtotal = items.reduce((s, i) => s + i.unit * i.qty, 0);
  const fee = type === 'delivery' ? deliveryFee : 0;
  const total = subtotal + fee;
  return { items, subtotal, fee, total, vat: vatIncluded(total) };
}

/** VAT already inside a VAT-inclusive total: total × 5/105. */
export const vatIncluded = (total) => Math.round((total * 5) / 105);

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Open check in the shop's time zone. Handles hours past midnight (10:00–02:00). open === close means 24 hours. */
export function isOpen(date, { open, close, tz }) {
  if (open === close) return true;
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date).split(':').map(Number);
  const now = h * 60 + m, o = toMin(open), c = toMin(close);
  return o < c ? now >= o && now < c : now >= o || now < c;
}
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

export const aed = (fils) => `AED ${(fils / 100).toFixed(2)}`;
