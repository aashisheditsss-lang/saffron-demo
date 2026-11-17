// Rider screen: assigned orders, navigation/call buttons, pickup/deliver, and GPS sharing.
// Login = the link the restaurant sends (/rider#t=…). The token sits in the # part so it never reaches server logs.
import { $, esc, aed, api, store, toast, ago } from './common.js';

const app = $('#app');
const fromLink = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromLink) { store.set('riderToken', fromLink); history.replaceState(null, '', location.pathname); }
const token = fromLink || store.get('riderToken');
let orders = [], watch = null, lastSent = 0, sentAt = null, gpsMsg = '', confirmId = null;
const SEND_EVERY_MS = 8000;

if (!token) app.innerHTML = '<div class="loginbox"><h1>Rider</h1><p class="warnbox">Open the rider link the restaurant sent you on WhatsApp.</p></div>';
else { load(); setInterval(load, 15000); setInterval(drawGps, 5000); }

async function load() {
  try { orders = await api('/api/rider/orders', { token }); }
  catch (e) {
    if (e.status === 401) { store.set('riderToken', null); app.innerHTML = '<div class="loginbox"><h1>Rider</h1><p class="errbox">This rider link no longer works. Ask the restaurant for a new one.</p></div>'; stopGps(); return; }
    return toast(e.message);
  }
  orders.length ? startGps() : stopGps();
  render();
}

function render() {
  app.innerHTML = `<header class="row between"><h1 style="font-size:24px">My deliveries</h1><span class="gps" id="gps"></span></header>
  ${orders.length ? orders.map(card).join('') : '<p class="empty">No orders right now. New ones appear here automatically.</p>'}`;
  app.onclick = onClick;
  drawGps();
}

function card(o) {
  const a = o.address || {};
  const collect = o.payment === 'cod' ? `Collect <b>${aed(o.collect)}</b> cash` : o.payment === 'cardod' ? `Take card payment: <b>${aed(o.collect)}</b>` : 'Paid online. Collect nothing.';
  const next = o.status === 'RIDER_ASSIGNED'
    ? `<button class="btn primary big" data-pickup="${o.id}">I've picked up the order</button>`
    : `<button class="btn primary big" data-deliver="${o.id}">${confirmId === o.id ? 'Tap again to confirm delivered' : 'Delivered'}</button>`;
  return `<section class="sec">
    <div class="row between"><b class="mono" style="font-size:18px">#${o.id}</b><span class="pill ${o.status === 'RIDER_ASSIGNED' ? 't-warn' : 't-info'}">${o.status === 'RIDER_ASSIGNED' ? 'Collect from restaurant' : o.status === 'ARRIVING' ? 'Arriving' : 'On the way'}</span></div>
    <div><b>${esc(a.building)}</b>${a.flat ? `, ${esc(a.flat)}` : ''}${a.makani ? `<br><span class="muted">Makani ${esc(a.makani)}</span>` : ''}${a.landmark ? `<br><span class="muted">${esc(a.landmark)}</span>` : ''}</div>
    <div class="row">
      <a class="sbtn" href="https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}" target="_blank" rel="noopener">Navigate</a>
      <a class="sbtn" href="tel:+${esc(o.phone)}">Call</a>
      <a class="sbtn" href="https://wa.me/${esc(o.phone)}" target="_blank" rel="noopener">WhatsApp</a>
    </div>
    <p style="margin:0" class="muted">${esc(o.items.map((i) => `${i.qty}× ${i.name}`).join(', '))}</p>
    <p class="collect" style="margin:0">${collect}</p>
    ${next}
  </section>`;
}

async function onClick(e) {
  const p = e.target.closest('[data-pickup]'), d = e.target.closest('[data-deliver]');
  if (p) {
    p.disabled = true;
    try { await api(`/api/rider/orders/${p.dataset.pickup}/pickup`, { method: 'POST', body: {}, token }); toast('Customer told you are on the way'); sendNow(); }
    catch (err) { toast(err.message); }
    return load();
  }
  if (d) {
    const id = Number(d.dataset.deliver);
    if (confirmId !== id) { confirmId = id; render(); setTimeout(() => { if (confirmId === id) { confirmId = null; render(); } }, 4000); return; }
    confirmId = null; d.disabled = true;
    try { await api(`/api/rider/orders/${id}/deliver`, { method: 'POST', body: {}, token }); toast('Delivered. Thank you!'); }
    catch (err) { toast(err.message); }
    load();
  }
}

// ---------- GPS ----------
function startGps() {
  if (watch != null) return;
  if (!navigator.geolocation) { gpsMsg = 'This phone cannot share location'; return; }
  watch = navigator.geolocation.watchPosition(onPos, (err) => {
    gpsMsg = err.code === 1 ? 'Location is blocked. Allow it in your browser settings.' : 'Searching for GPS…';
    drawGps();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function stopGps() { if (watch != null) navigator.geolocation.clearWatch(watch); watch = null; gpsMsg = ''; }

let lastPos = null;
function onPos(p) {
  lastPos = { lat: p.coords.latitude, lng: p.coords.longitude };
  if (Date.now() - lastSent >= SEND_EVERY_MS) sendNow();
}
async function sendNow() {
  if (!lastPos) return;
  lastSent = Date.now();
  try { await api('/api/rider/location', { method: 'POST', body: lastPos, token }); sentAt = Date.now(); gpsMsg = ''; }
  catch { gpsMsg = 'Could not send location (no internet?)'; }
  drawGps();
}
function drawGps() {
  const el = $('#gps');
  if (!el) return;
  el.textContent = gpsMsg || (watch == null ? '' : sentAt ? `Sharing location · ${ago(sentAt)}` : 'Starting GPS…');
  el.style.color = gpsMsg ? 'var(--bad)' : 'var(--ok)';
}
