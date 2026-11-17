import { HttpError, bearer } from './http.js';
import { sha256, safeEqual } from './tokens.js';
import { customerFromToken } from './orders.js';
import { digits } from './whatsapp.js';

const cache = new Map(); // Supabase token → { phone, until }

/**
 * Who is this customer? Two ways in:
 *  1. `t` = the signed link the WhatsApp bot sent (phone already proven: they messaged us from it).
 *  2. Authorization: Bearer <Supabase access token> after phone OTP login (customer came from Google Maps / website).
 */
export async function customerPhone(ctx, req, t) {
  const p = customerFromToken(ctx, t);
  if (p) return p;
  const token = bearer(req);
  if (!token || !ctx.config.supabase.url) return null;
  const hit = cache.get(token);
  if (hit && hit.until > ctx.now()) return hit.phone;
  // Ask Supabase who owns the token; it checks signature + expiry for us.
  const r = await ctx.fetch(`${ctx.config.supabase.url}/auth/v1/user`, {
    headers: { apikey: ctx.config.supabase.anonKey, Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!r?.ok) return null;
  const user = await r.json().catch(() => null);
  if (!user?.phone || !user.phone_confirmed_at) return null; // only a verified phone counts
  const phone = digits(user.phone);
  if (cache.size > 5000) cache.clear();
  cache.set(token, { phone, until: ctx.now() + 60000 });
  return phone;
}

export function requireStaff(ctx, req) {
  const token = bearer(req) || req.query.token || ''; // EventSource can't send headers, so the stream uses ?token=
  if (!safeEqual(token, ctx.config.staffToken)) throw new HttpError(401, 'Staff login required.');
}

export function requireRider(ctx, req) {
  const token = bearer(req);
  const rider = token && ctx.db.prepare('SELECT * FROM riders WHERE token_hash = ? AND active = 1').get(sha256(token));
  if (!rider) throw new HttpError(401, 'Rider login required.');
  return rider;
}
