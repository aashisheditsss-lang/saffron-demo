// Live order tracking. The page is built once; each poll only updates text and moves the rider dot
// (re-drawing everything every few seconds is what made the prototype's map glitch).
import { $, esc, aed, api, km, ago, STATUS, PAY, tiles, dotIcon, loadLeaflet, icon } from './common.js';

const k = new URLSearchParams(location.search).get('k');
const FINAL = ['DELIVERED', 'COLLECTED', 'REJECTED', 'CANCELLED', 'EXPIRED'];
const MOVING = ['PICKED_UP', 'ARRIVING'];
const RIDER_KM_PER_MIN = 0.4; // ~25 km/h in city traffic
let map = null, riderMarker = null, fitted = false, timer = null, last = null;

if (!k) fail('This tracking link is not complete. Open it again from WhatsApp.');
else poll();

async function poll() {
  try {
    last = await api(`/api/track?k=${encodeURIComponent(k)}`);
    render(last);
    if (!FINAL.includes(last.status)) timer = setTimeout(poll, MOVING.includes(last.status) ? 4000 : 10000);
  } catch (e) {
    if (e.status === 404 || e.status === 410) return fail(e.message);
    timer = setTimeout(poll, 10000); // network blip: keep trying
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && last && !FINAL.includes(last.status)) { clearTimeout(timer); poll(); } });

function fail(msg) { $('#loading').hidden = false; $('#loading').className = 'warnbox'; $('#loading').textContent = msg; $('#view').hidden = true; }

function render(o) {
  $('#loading').hidden = true; $('#view').hidden = false;
  document.title = `Order #${o.id} · ${STATUS[o.status][0]}`;
  $('#title').textContent = `Order #${o.id}`;
  const [label, tone] = STATUS[o.status];
  const pill = $('#pill'); pill.textContent = label; pill.className = `pill ${tone}`;
  const [etaLabel, eta] = etaText(o);
  $('#etaLabel').textContent = etaLabel; $('#eta').textContent = eta;

  const steps = o.type === 'delivery'
    ? [['CONFIRMED', 'Order confirmed'], ['ACCEPTED', 'Kitchen is cooking'], ['READY', 'Packed and ready'], ['PICKED_UP', 'Rider on the way'], ['ARRIVING', 'Rider is close'], ['DELIVERED', 'Delivered']]
    : [['CONFIRMED', 'Order confirmed'], ['ACCEPTED', 'Kitchen is cooking'], ['READY', 'Ready for pickup'], ['COLLECTED', 'Collected']];
  const seen = new Set(o.events.map((e) => e.status));
  if (seen.has('RIDER_ASSIGNED')) seen.add('READY');
  if (seen.has('DELIVERED')) seen.add('ARRIVING');
  const nowIdx = steps.findLastIndex(([s]) => seen.has(s));
  $('#steps').innerHTML = steps.map(([s, text], i) => {
    const at = o.events.find((e) => e.status === s)?.at;
    return `<li class="${seen.has(s) ? 'on' : ''}${i === nowIdx && !FINAL.includes(o.status) ? ' now' : ''}">${text}${at ? ` <span class="muted mono" style="font-weight:400">${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : ''}</li>`;
  }).join('');

  const r = $('#rider');
  r.hidden = !o.rider;
  if (o.rider) r.innerHTML = `<div class="ridercard"><div class="avatar">${esc(o.rider.name[0])}</div><div><b>${esc(o.rider.name)}</b> is bringing your order<br><small class="muted">${o.rider.locAt ? `Location updated ${ago(o.rider.locAt)}` : 'Waiting for location…'}</small></div></div>`;

  $('#items').innerHTML = `<h2>Your order</h2>${o.items.map((i) => `<div class="line"><span>${i.qty}× ${esc(i.name)}${i.addons.length ? ` <small class="muted">+ ${esc(i.addons.map((a) => a.name).join(', '))}</small>` : ''}</span><span>${aed(i.unit * i.qty)}</span></div>`).join('')}
    ${o.fee ? `<div class="line"><span>Delivery</span><span>${aed(o.fee)}</span></div>` : ''}
    <div class="line total"><span>Total</span><span>${aed(o.total)}</span></div>
    <div class="vat">Includes VAT ${aed(o.vat)} · ${PAY[o.payment]}${o.payment === 'card' ? (o.paymentStatus === 'paid' ? ' · paid' : o.paymentStatus === 'refunded' ? ' · refunded' : '') : o.type === 'delivery' ? ' on delivery' : ' at pickup'}</div>`;

  if (o.shop.whatsapp) {
    const a = $('#help');
    a.hidden = false; $('#helpText').hidden = true;
    a.href = `https://wa.me/${o.shop.whatsapp}?text=${encodeURIComponent(`Hi, about order #${o.id}`)}`;
    a.innerHTML = `${icon.chat} Message ${esc(o.shop.name)} on WhatsApp`;
  }
  if (o.destination) drawMap(o);
}

function etaText(o) {
  const now = Date.now();
  switch (o.status) {
    case 'PAYMENT_PENDING': return ['Waiting for your card payment', 'Complete payment to confirm'];
    case 'CONFIRMED': return ['The kitchen is checking your order', 'Confirmed'];
    case 'ACCEPTED': { const m = Math.max(1, Math.ceil((o.readyBy - now) / 60000)); return [o.type === 'delivery' ? 'Food ready in about' : 'Ready for pickup in about', `${m} min`]; }
    case 'READY': return o.type === 'delivery' ? ['Packed and ready', 'Waiting for the rider'] : ['Ready for pickup', 'Come and collect it'];
    case 'RIDER_ASSIGNED': return ['Your rider is collecting the order', 'Leaving soon'];
    case 'PICKED_UP': {
      if (!o.rider?.lat) return ['On the way', 'Arriving soon'];
      const m = Math.max(2, Math.ceil(km(o.rider, o.destination) / RIDER_KM_PER_MIN) + 1);
      return ['Arriving in about', `${m} min`];
    }
    case 'ARRIVING': return ['Your rider is nearly there', 'Arriving now'];
    case 'DELIVERED': return ['Enjoy your meal!', 'Delivered'];
    case 'COLLECTED': return ['Enjoy your meal!', 'Collected'];
    case 'REJECTED': return ['We could not make this order', 'Sorry — not accepted'];
    case 'CANCELLED': return ['This order was cancelled', 'Cancelled'];
    case 'EXPIRED': return ['Payment was not completed', 'Order cancelled'];
    default: return ['', ''];
  }
}

function drawMap(o) {
  if (!window.L) { loadLeaflet().then(() => last && drawMap(last), () => {}); return; }
  const el = $('#trackmap');
  el.hidden = false;
  if (!map) {
    map = window.L.map(el, { zoomControl: false, attributionControl: true });
    tiles(map);
    window.L.marker([o.shop.lat, o.shop.lng], { icon: dotIcon('#1F1A14'), title: o.shop.name, keyboard: false }).addTo(map);
    window.L.marker([o.destination.lat, o.destination.lng], { icon: dotIcon('#B42318'), title: 'You', keyboard: false }).addTo(map);
  }
  const pts = [[o.shop.lat, o.shop.lng], [o.destination.lat, o.destination.lng]];
  if (o.rider?.lat != null && MOVING.includes(o.status)) {
    const to = [o.rider.lat, o.rider.lng];
    if (!riderMarker) riderMarker = window.L.marker(to, { icon: dotIcon('#A85A08'), title: o.rider.name, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    else glide(riderMarker, to);
    pts.push(to);
  } else if (riderMarker) { riderMarker.remove(); riderMarker = null; }
  if (!fitted) { map.fitBounds(pts, { padding: [36, 36], maxZoom: 16 }); fitted = true; }
}

// Move the rider smoothly to the new point over ~1 s instead of jumping.
function glide(m, to) {
  const from = m.getLatLng(), t0 = performance.now();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return m.setLatLng(to);
  const step = (t) => {
    const p = Math.min(1, (t - t0) / 1000);
    m.setLatLng([from.lat + (to[0] - from.lat) * p, from.lng + (to[1] - from.lng) * p]);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
