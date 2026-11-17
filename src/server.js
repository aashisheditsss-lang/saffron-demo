import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { runJobs } from './orders.js';

const config = loadConfig();
const { ctx, server } = createApp(config);
server.listen(config.port, () => {
  console.log(`${config.shop.name} backend on port ${config.port}  (WhatsApp: ${ctx.wa.live ? 'live' : 'mock'}, ${config.production ? 'production' : 'development'})`);
});
const jobs = setInterval(() => runJobs(ctx).catch((e) => console.error('jobs:', e)), 30000);

// Hosts stop the app with SIGTERM on every deploy/restart. Close the database cleanly so no order is lost.
function shutdown(sig) {
  console.log(`${sig}: shutting down`);
  clearInterval(jobs);
  server.close();
  ctx.db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
