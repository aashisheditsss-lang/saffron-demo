// Restaurant screen: kitchen board, reception chats, dispatch, menu stock, riders, today's numbers.
// Live: Server-Sent Events push every order change, so the board updates without refreshing.
import { $, esc, aed, api, store, toast, ago, STATUS, PAY } from './common.js';

const app = $('#app');
let token = store.get('staffToken');
// One screen, three doors: /kitchen (live orders), /owner (takings, menu, riders), /staff (everything).
// shortcut: all three use the same staff password; give the owner a separate login before real staff use it.
const ROLES = {
  kitchen: { label: 'Kitchen', tabs: ['orders', 'chats'] },
  owner: { label: 'Owner', tabs: ['today', 'menu', 'riders', 'orders'] },
  staff: { label: '', tabs: ['orders', 'chats', 'menu', 'riders', 'today'] },
};
const ROLE = ROLES[location.pathname.replace(/\W/g, '')] || ROLES.staff;
let tab = ROLE.tabs[0], orders = new Map(), riders = [], chats = [], menu = null, report = null, alerts = [], es = null, newRider = null;
let streamRetry = null, everConnected = false;
const REASONS = ['Too busy right now', 'Item not available', 'Address problem'];
const COLS = [['New orders', ['CONFIRMED', 'PAYMENT_PENDING']], ['Cooking', ['ACCEPTED']], ['Ready', ['READY']], ['Out for delivery', ['RIDER_ASSIGNED', 'PICKED_UP', 'ARRIVING']]];
const call = (path, opts = {}) => api(path, { ...opts, token });

token ? start() : loginScreen();

function loginScreen(msg = '') {
  es?.close(); clearTimeout(streamRetry); clearTimeout(pollTimer); everConnected = false;
  app.innerHTML = `<form class="loginbox" id="login"><h1>Restaurant login</h1>
    <p class="muted" style="margin:0">For kitchen, reception and the manager.</p>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted)">Staff password<input class="input" id="pw" type="password" autocomplete="current-password" required></label>
    ${msg ? `<p class="errbox">${esc(msg)}</p>` : ''}
    <button class="btn primary wide">Log in</button></form>`;
  $('#login').onsubmit = (e) => { e.preventDefault(); token = $('#pw').value; start(); };
}

async function start() {
  try {
    const [list, r, m, c] = await Promise.all([call('/api/staff/orders'), call('/api/staff/riders'), api('/api/menu'), call('/api/staff/handoffs')]);
    store.set('staffToken', token);
    orders = new Map(list.map((o) => [o.id, o])); riders = r; menu = m; chats = c;
  } catch (e) {
    store.set('staffToken', null);
    return loginScreen(e.status === 401 ? 'Wrong password.' : e.message);
  }
  shell(); render(); stream(); poll();
}

// Safety net under the live stream: some networks/proxies (e.g. Cloudflare quick tunnels) never deliver it.
// Re-check every 4 s and redraw only when something changed, so typing in a form isn't interrupted.
let pollTimer = null, lastSig = '';
async function poll() {
  clearTimeout(pollTimer);
  if (!token) return;
  try {
    const [list, c] = await Promise.all([call('/api/staff/orders'), call('/api/staff/handoffs')]);
    if ($('#live') && es?.readyState !== 1) $('#live').textContent = 'Live'; // fresh within 4 s even without the stream
    const sig = JSON.stringify([list.map((o) => [o.id, o.status, o.rider_id]), c.length]);
    if (sig !== lastSig) {
      const fresh = list.filter((o) => o.status === 'CONFIRMED' && orders.get(o.id)?.status !== 'CONFIRMED');
      if (lastSig && fresh.length) { beep(); toast(`New order #${fresh[0].id}`); }
      lastSig = sig; orders = new Map(list.map((o) => [o.id, o])); chats = c;
      if (tab === 'orders' || tab === 'today') render(); else renderTabs();
    }
  } catch (e) { if (e.status === 401) return loginScreen('Please log in again.'); }
  pollTimer = setTimeout(poll, 4000);
}

function shell() {
  app.innerHTML = `<header class="staffbar"><h1>${esc(menu.shop.name)}${ROLE.label ? ` · ${ROLE.label}` : ''}</h1><span class="live" id="live">Connecting…</span><button class="sbtn" id="logout">Log out</button></header>
    <nav class="tabs" role="tablist" id="tabs"></nav>
    <main class="staffmain"><div class="alerts" id="alerts" aria-live="assertive"></div><div id="body"></div></main>`;
  $('#logout').onclick = () => { store.set('staffToken', null); token = null; loginScreen(); };
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; render(); } };
  $('#alerts').onclick = (e) => { const b = e.target.closest('[data-dismiss]'); if (b) { alerts.splice(Number(b.dataset.dismiss), 1); renderAlerts(); } };
  $('#body').onclick = onClick;
  $('#body').onsubmit = onSubmit;
}

async function stream() {
  es?.close(); clearTimeout(streamRetry);
  let ticket;
  try { ({ ticket } = await call('/api/staff/stream-ticket', { method: 'POST', body: {} })); }
  catch (e) {
    if (e.status === 401) { store.set('staffToken', null); return loginScreen('Please log in again.'); }
    $('#live').textContent = 'Reconnecting…'; streamRetry = setTimeout(stream, 5000); return;
  }
  es = new EventSource(`/api/staff/stream?ticket=${encodeURIComponent(ticket)}`);
  // A proxy that buffers the stream (e.g. Cloudflare quick tunnels) leaves it hanging and ties up one of the
  // browser's few connections to this site. If it hasn't opened in 5 s, drop it and let poll() keep the screen fresh.
  const thisEs = es;
  setTimeout(() => { if (es === thisEs && es.readyState !== 1) { es.onerror = null; es.close(); } }, 5000);
  es.onopen = async () => {
    $('#live').textContent = 'Live';
    if (everConnected) { orders = new Map((await call('/api/staff/orders').catch(() => [])).map((o) => [o.id, o])); render(); } // catch up on anything missed
    everConnected = true;
  };
  // The pass is single-use per connection; on any drop, get a fresh one rather than letting the browser retry the old URL.
  es.onerror = () => { $('#live').textContent = 'Reconnecting…'; es.close(); streamRetry = setTimeout(stream, 3000); };
  es.addEventListener('order', (e) => {
    const o = JSON.parse(e.data), isNew = !orders.has(o.id) || orders.get(o.id).status !== o.status;
    orders.set(o.id, o);
    if (isNew && o.status === 'CONFIRMED') { beep(); toast(`New order #${o.id}`); }
    if (tab === 'orders') render(); else renderTabs();
  });
  es.addEventListener('alert', (e) => { alerts.push(JSON.parse(e.data)); beep(); renderAlerts(); });
  es.addEventListener('handoff', async () => { chats = await call('/api/staff/handoffs').catch(() => chats); beep(); tab === 'chats' ? render() : renderTabs(); });
  es.addEventListener('rider', (e) => { const p = JSON.parse(e.data), r = riders.find((x) => x.id === p.id); if (r) Object.assign(r, { lat: p.lat, lng: p.lng, loc_at: Date.now() }); });
  es.addEventListener('menu', async () => { menu = await api('/api/menu'); if (tab === 'menu') render(); });
}

let ac;
function beep() {
  try {
    ac ||= new AudioContext();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.15; o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.25);
  } catch { /* sound is a bonus */ }
}

const active = () => [...orders.values()].filter((o) => COLS.some(([, s]) => s.includes(o.status)));
function renderTabs() {
  const nNew = [...orders.values()].filter((o) => o.status === 'CONFIRMED').length;
  const all = { orders: ['Orders', nNew], chats: ['Chats', chats.length], menu: ['Menu', 0], riders: ['Riders', 0], today: ['Today', 0] };
  const t = ROLE.tabs.map((id) => [id, ...all[id]]);
  $('#tabs').innerHTML = t.map(([id, label, n]) => `<button role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}${n ? `<span class="badge">${n}</span>` : ''}</button>`).join('');
  document.title = nNew ? `(${nNew}) New order${nNew > 1 ? 's' : ''}` : 'Restaurant orders';
}
function renderAlerts() {
  $('#alerts').innerHTML = alerts.map((a, i) => `<div class="alert" role="alert"><span>${esc(a.text)}</span><button class="sbtn" data-dismiss="${i}">Dismiss</button></div>`).join('');
}

async function render() {
  renderTabs(); renderAlerts();
  const body = $('#body');
  if (tab === 'orders') body.innerHTML = board();
  if (tab === 'chats') body.innerHTML = chatsView();
  if (tab === 'menu') body.innerHTML = menuView();
  if (tab === 'riders') { riders = await call('/api/staff/riders').catch(() => riders); body.innerHTML = ridersView(); }
  if (tab === 'today') { report = await call('/api/staff/report').catch(() => report); body.innerHTML = todayView(); }
  tickTimers();
}

// ---------- Orders board ----------
function board() {
  const list = active();
  const cols = COLS.map(([title, statuses]) => {
    const os = list.filter((o) => statuses.includes(o.status)).sort((a, b) => a.id - b.id);
    return `<section class="col"><h2>${title} <span class="pill t-info">${os.length}</span></h2>${os.map(card).join('') || '<p class="empty">Nothing here</p>'}</section>`;
  }).join('');
  const done = [...orders.values()].filter((o) => !list.includes(o)).sort((a, b) => b.id - a.id);
  return `<div class="board">${cols}</div>
    <section><h2 style="font-size:15px;font-family:var(--f-body);margin-bottom:8px">Finished today (${done.length})</h2>
    ${done.length ? `<div class="tablewrap"><table><thead><tr><th>#</th><th>Status</th><th>Items</th><th>Total</th><th>Paid by</th><th>Rating</th></tr></thead><tbody>
      ${done.map((o) => `<tr><td class="mono">${o.id}</td><td><span class="pill ${STATUS[o.status][1]}">${STATUS[o.status][0]}</span></td><td>${esc(o.items.map((i) => `${i.qty}× ${i.name}`).join(', '))}</td><td class="mono">${aed(o.total)}</td><td>${PAY[o.payment_method]}</td><td>${o.rating ? `${o.rating}/5` : '–'}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">No finished orders yet today.</p>'}</section>`;
}

function card(o) {
  const items = o.items.map((i) => `<li>${i.qty}× ${esc(i.name)}${i.addons.length ? ` <span class="muted">+ ${esc(i.addons.map((a) => a.name).join(', '))}</span>` : ''}</li>`).join('');
  const where = o.type === 'delivery' ? `Delivery · ${esc(o.address?.building)}${o.address?.flat ? `, ${esc(o.address.flat)}` : ''}` : 'Pickup';
  const rider = riders.find((r) => r.id === o.rider_id);
  const pay = `${PAY[o.payment_method]}${o.payment_method === 'card' ? (o.payment_status === 'paid' ? ' · paid' : ' · not paid yet') : ''}`;
  const more = (label, act) => `<details class="more"><summary class="sbtn danger">${label}</summary><div class="row">${REASONS.map((r) => `<button class="sbtn" data-do="${act}" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div></details>`;
  let actions = '';
  if (o.status === 'CONFIRMED') actions = `<span class="muted">Accept, ready in:</span>${[10, 15, 20, 30].map((m) => `<button class="sbtn primary" data-do="accept" data-min="${m}">${m} min</button>`).join('')}${more('Reject', 'reject')}`;
  if (o.status === 'PAYMENT_PENDING') actions = `<span class="muted">Waiting for card payment</span>${more('Cancel', 'cancel')}`;
  if (o.status === 'ACCEPTED') actions = `<button class="sbtn primary" data-do="ready">Mark ready</button>${more('Cancel', 'cancel')}`;
  if (o.status === 'READY') {
    actions = o.type === 'pickup'
      ? `<button class="sbtn primary" data-do="collected">Customer collected</button>`
      : (riders.some((r) => r.active)
        ? `<select data-rider aria-label="Rider for order ${o.id}">${riders.filter((r) => r.active).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select><button class="sbtn primary" data-do="assign">Assign</button>`
        : `<span class="muted">${ROLE.tabs.includes('riders') ? 'Add a rider in the Riders tab' : 'No riders yet: the owner adds them'}</span>`);
    actions += more('Cancel', 'cancel');
  }
  if (o.status === 'RIDER_ASSIGNED') actions = `<span class="muted">${esc(rider?.name || 'Rider')} is coming to collect</span><button class="sbtn" data-do="unassign">Change rider</button>`;
  if (o.status === 'PICKED_UP' || o.status === 'ARRIVING') actions = `<span class="muted">${esc(rider?.name || 'Rider')} · ${STATUS[o.status][0].toLowerCase()}</span>`;
  const timerAttr = o.status === 'ACCEPTED' ? `data-until="${o.ready_by}"` : `data-since="${o.updated_at}" data-limit="${o.status === 'CONFIRMED' ? 3 : 0}"`;
  return `<article class="kcard${o.status === 'CONFIRMED' ? ' new' : ''}" data-id="${o.id}">
    <header><span class="mono">#${o.id}</span><span class="pill ${STATUS[o.status][1]}">${STATUS[o.status][0]}</span><span class="timer" ${timerAttr}></span></header>
    <ul>${items}</ul>
    <p>${where}</p>${o.address?.landmark ? `<p class="muted">${esc(o.address.landmark)}</p>` : ''}
    <p><b class="mono">${aed(o.total)}</b> · ${pay}</p>
    <p class="muted">+${esc(o.phone)}</p>
    <div class="row">${actions}</div>
  </article>`;
}

// Update the little timers without re-drawing the board.
function tickTimers() {
  const now = Date.now();
  document.querySelectorAll('.timer').forEach((el) => {
    if (el.dataset.until) {
      const m = Math.round((Number(el.dataset.until) - now) / 60000);
      el.textContent = m >= 0 ? `ready in ${m}m` : `${-m}m late`;
      el.classList.toggle('late', m < 0);
    } else {
      const m = Math.floor((now - Number(el.dataset.since)) / 60000), limit = Number(el.dataset.limit);
      el.textContent = `${m}m`;
      el.classList.toggle('late', limit > 0 && m >= limit);
    }
  });
}
setInterval(tickTimers, 15000);

// ---------- Chats (bot handed these to a person) ----------
function chatsView() {
  if (!chats.length) return '<p class="empty">No customers waiting for a person. The bot is handling all chats.</p>';
  return `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">${chats.map((h) => `<section class="kcard">
    <header><span class="mono">+${esc(h.phone)}</span><span class="timer">${ago(h.at)}</span></header>
    <div class="chatlog">${h.messages.map((m) => `<div class="bub ${m.dir === 'out' ? 'out' : ''}">${esc(m.body)}</div>`).join('')}</div>
    <form class="row" data-reply="${h.id}"><input class="input" name="text" placeholder="Type a reply…" aria-label="Reply to +${esc(h.phone)}" style="flex:1" autocomplete="off"><button class="sbtn primary">Send</button></form>
    <button class="sbtn" data-close-chat="${h.id}">Done: hand back to the bot</button>
  </section>`).join('')}</div>`;
}

// ---------- Menu stock ----------
function menuView() {
  return `<p class="muted" style="margin:0">Tap a dish to mark it sold out. It disappears from orders straight away.</p>
  <div class="grid avail">${menu.items.map((i) => `<button data-dish="${esc(i.id)}" aria-pressed="${i.available}"><span>${esc(i.name)}</span><span>${i.available ? 'Available' : 'Sold out'}</span></button>`).join('')}</div>`;
}

// ---------- Riders ----------
function ridersView() {
  const link = newRider ? `${location.origin}/rider#t=${encodeURIComponent(newRider.token)}` : '';
  return `${newRider ? `<div class="sec"><h4>Rider link for ${esc(newRider.name)}</h4><p class="muted" style="margin:0">Send this link to the rider's phone now. It is their login and is only shown once.</p>
      <div class="row"><input class="input mono" readonly value="${esc(link)}" style="flex:1" aria-label="Rider link"><button class="sbtn primary" data-copy="${esc(link)}">Copy</button></div></div>` : ''}
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Last location</th><th>On order</th></tr></thead><tbody>
    ${riders.map((r) => { const on = [...orders.values()].find((o) => o.rider_id === r.id && ['RIDER_ASSIGNED', 'PICKED_UP', 'ARRIVING'].includes(o.status));
      return `<tr><td>${esc(r.name)}</td><td>${esc(r.phone || '–')}</td><td>${r.loc_at ? ago(r.loc_at) : 'never'}</td><td>${on ? `#${on.id}` : 'free'}</td></tr>`; }).join('') || '<tr><td colspan="4" class="muted">No riders yet.</td></tr>'}
    </tbody></table></div>
    <form class="sec" data-add-rider><h4>Add a rider</h4><div class="fields"><label>Name<input name="name" required maxlength="80"></label><label>Phone<input name="phone" type="tel" maxlength="20"></label></div><button class="sbtn primary" style="align-self:flex-start">Add rider</button></form>`;
}

// ---------- Today ----------
function todayView() {
  if (!report) return '<p class="empty">Could not load the report.</p>';
  const k = [['Orders', report.orders], ['Delivered / collected', report.delivered], ['Rejected or cancelled', report.cancelled], ['Revenue (incl. VAT)', aed(report.revenue)], ['Average rating', report.avgRating ? `${report.avgRating.toFixed(1)} / 5` : '–']];
  return `<div class="kpis">${k.map(([l, v]) => `<div class="kpi"><small>${l}</small><b>${v}</b></div>`).join('')}</div>
  <section><h2 style="font-size:15px;font-family:var(--f-body);margin-bottom:8px">Cash each rider should hand in</h2>
  <div class="tablewrap"><table><thead><tr><th>Rider</th><th>Cash collected</th></tr></thead><tbody>
  ${report.cashByRider.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${aed(r.cash)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No cash orders yet today.</td></tr>'}</tbody></table></div></section>`;
}

// ---------- actions ----------
async function onClick(e) {
  const t = e.target;
  const btn = t.closest('[data-do]');
  if (btn) {
    const cardEl = btn.closest('.kcard'), id = cardEl.dataset.id, act = btn.dataset.do;
    const body = act === 'accept' ? { prepMin: Number(btn.dataset.min) } : act === 'assign' ? { riderId: Number(cardEl.querySelector('[data-rider]').value) } : { reason: btn.dataset.reason };
    btn.disabled = true;
    try { const o = await call(`/api/staff/orders/${id}/${act}`, { method: 'POST', body }); orders.set(o.id, o); render(); }
    catch (err) { toast(err.message); btn.disabled = false; if (err.status === 409) { orders = new Map((await call('/api/staff/orders')).map((o) => [o.id, o])); render(); } }
    return;
  }
  const dish = t.closest('[data-dish]');
  if (dish) {
    const it = menu.items.find((i) => i.id === dish.dataset.dish);
    try { await call(`/api/staff/menu/${encodeURIComponent(it.id)}`, { method: 'PATCH', body: { available: !it.available } }); it.available = !it.available; render(); }
    catch (err) { toast(err.message); }
    return;
  }
  const close = t.closest('[data-close-chat]');
  if (close) { await call(`/api/staff/handoffs/${close.dataset.closeChat}/reply`, { method: 'POST', body: { close: true } }).catch((err) => toast(err.message)); chats = await call('/api/staff/handoffs'); render(); return; }
  const copy = t.closest('[data-copy]');
  if (copy) { navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('Link copied'), () => toast('Copy failed. Select the link and copy it.')); }
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  if (f.dataset.reply) {
    const text = f.elements.text.value.trim();
    if (!text) return;
    try { await call(`/api/staff/handoffs/${f.dataset.reply}/reply`, { method: 'POST', body: { text, close: false } }); chats = await call('/api/staff/handoffs'); render(); }
    catch (err) { toast(err.message); }
  }
  if (f.hasAttribute('data-add-rider')) {
    try { const r = await call('/api/staff/riders', { method: 'POST', body: { name: f.elements.name.value, phone: f.elements.phone.value } }); newRider = { ...r, name: f.elements.name.value }; render(); }
    catch (err) { toast(err.message); }
  }
}
