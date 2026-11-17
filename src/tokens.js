import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Signed, expiring token for customer links (menu, order). Not encrypted: holds only the phone number. */
export function sign(payload, secret, ttlSec, nowMs = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(nowMs / 1000) + ttlSec })).toString('base64url');
  return `${body}.${hmac(secret, body).toString('base64url')}`;
}

export function verify(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(Buffer.from(sig, 'base64url'), hmac(secret, body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > nowMs / 1000 ? p : null;
  } catch { return null; }
}

export const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest();
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
