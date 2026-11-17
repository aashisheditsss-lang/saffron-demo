import { hmac, safeEqual } from './tokens.js';

const DAY = 24 * 3600 * 1000;
export const digits = (p) => String(p ?? '').replace(/\D/g, '');

/**
 * Sends WhatsApp messages through the Meta Cloud API.
 * Without WA_TOKEN it runs in mock mode: messages are only saved in the `messages` table (see /api/dev/outbox).
 * Never throws: a failed message must not break an order.
 */
export function createWhatsApp(ctx) {
  const { config, db } = ctx;
  const live = !!(config.wa.token && config.wa.phoneNumberId);
  const save = db.prepare('INSERT INTO messages(wa_id, phone, dir, body, status, at) VALUES(?, ?, ?, ?, ?, ?)');

  async function send(phone, text, button) {
    phone = digits(phone);
    const c = db.prepare('SELECT last_inbound_at FROM customers WHERE phone = ?').get(phone);
    const inWindow = c?.last_inbound_at && ctx.now() - c.last_inbound_at < DAY; // Meta's 24-hour customer service window
    let payload;
    if (inWindow) {
      payload = button
        ? { type: 'interactive', interactive: { type: 'cta_url', body: { text: text.slice(0, 1024) },
            action: { name: 'cta_url', parameters: { display_text: button.label.slice(0, 20), url: button.url } } } }
        : { type: 'text', text: { body: text.slice(0, 4096), preview_url: false } };
    } else if (config.wa.updateTemplate) {
      // Outside the window only an approved template may be sent. Its one {{1}} param can't hold newlines.
      const param = `${text}${button ? ` ${button.url}` : ''}`.replace(/\s*\n\s*/g, ' · ').replace(/ {4,}/g, ' ').slice(0, 1000);
      payload = { type: 'template', template: { name: config.wa.updateTemplate, language: { code: config.wa.templateLang },
        components: [{ type: 'body', parameters: [{ type: 'text', text: param }] }] } };
    } else {
      save.run(null, phone, 'out', text, 'skipped_no_window', ctx.now());
      return { status: 'skipped' };
    }
    const body = button ? `${text}\n[${button.label}] ${button.url}` : text;
    if (!live) { save.run(null, phone, 'out', body, 'mock', ctx.now()); return { status: 'mock' }; }
    try {
      const r = await ctx.fetch(`https://graph.facebook.com/${config.wa.apiVersion}/${config.wa.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.wa.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, ...payload }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out?.error?.message || `HTTP ${r.status}`);
      save.run(out.messages?.[0]?.id || null, phone, 'out', body, 'sent', ctx.now());
      return { status: 'sent' };
    } catch (err) {
      console.error('WhatsApp send failed:', err.message);
      save.run(null, phone, 'out', body, 'failed', ctx.now());
      return { status: 'failed' };
    }
  }

  return { send, live };
}

/** Meta signs each webhook: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
export function verifySignature(raw, header, appSecret) {
  if (!appSecret) return true; // dev only; config refuses to start in production without it
  const sig = String(header || '');
  return sig.startsWith('sha256=') && safeEqual(Buffer.from(sig.slice(7), 'hex'), hmac(appSecret, raw));
}
