import { randomToken } from './tokens.js';

// shortcut: mock card provider only (a fake "Pay" page). Swap in Network International / Checkout.com / Stripe UAE before launch.
export function createPayments(ctx) {
  const mock = ctx.config.payments.provider === 'mock';
  return {
    // Never take "card" orders in production with the fake provider.
    enabled: mock && !ctx.config.production,
    createSession(order) {
      const id = randomToken(12);
      ctx.db.prepare("INSERT INTO payments(id, order_id, amount, status, created_at) VALUES(?, ?, ?, 'pending', ?)").run(id, order.id, order.total, ctx.now());
      return { id, url: `${ctx.config.publicUrl}/pay/${id}` };
    },
    getSession: (id) => ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(String(id)),
    markPaid: (id) => ctx.db.prepare("UPDATE payments SET status = 'paid' WHERE id = ? AND status = 'pending'").run(String(id)).changes === 1,
    refund(order) {
      ctx.db.prepare("UPDATE payments SET status = 'refunded' WHERE order_id = ? AND status = 'paid'").run(order.id);
      return 'refunded';
    },
  };
}
