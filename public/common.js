// Small helpers shared by all pages.
export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const aed = (fils) => `AED ${(fils / 100).toFixed(2)}`;

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let r;
  try { r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw Object.assign(new Error('No internet connection. Please try again.'), { status: 0 }); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: r.status });
  return data;
}

// localStorage can throw (private mode, blocked storage); never let that break the page.
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export const STATUS = {
  PAYMENT_PENDING: ['Waiting for payment', 't-warn'], CONFIRMED: ['New', 't-warn'], ACCEPTED: ['Cooking', 't-info'],
  READY: ['Ready', 't-ok'], RIDER_ASSIGNED: ['Rider assigned', 't-info'], PICKED_UP: ['On the way', 't-info'],
  ARRIVING: ['Arriving', 't-info'], DELIVERED: ['Delivered', 't-ok'], COLLECTED: ['Collected', 't-ok'],
  REJECTED: ['Rejected', 't-bad'], CANCELLED: ['Cancelled', 't-bad'], EXPIRED: ['Payment expired', 't-bad'],
};
export const PAY = { card: 'Card (online)', cod: 'Cash', cardod: 'Card machine' };

export function km(a, b) {
  const rad = (d) => (d * Math.PI) / 180, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = Object.assign(document.createElement('div'), { className: 'toast', role: 'status', textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

export const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };

// shortcut: free OpenStreetMap tiles are fine for a pilot; switch to a paid tile provider (Mapbox, MapTiler) at real traffic.
export function tiles(map) {
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
}
// One icon family: 24px grid, 2px round strokes, currentColor.
const svg = (d, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icon = {
  back: svg('<path d="M15 18l-6-6 6-6"/>', 22),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 14),
  star: svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor" stroke="none"/>', 12),
  chat: svg('<path d="M20 11.5a8 8 0 0 1-11.8 7L4 20l1.5-4A8 8 0 1 1 20 11.5z"/>', 18),
};

// The map library (~40 kB) loads only when a map is actually shown.
let leaflet = null;
export function loadLeaflet() {
  if (window.L) return Promise.resolve();
  leaflet ||= new Promise((ok, fail) => {
    const base = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet';
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${base}.css`, integrity: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=', crossOrigin: '' }));
    document.head.append(Object.assign(document.createElement('script'), { src: `${base}.js`, integrity: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=', crossOrigin: '', onload: ok, onerror: () => { leaflet = null; fail(new Error('map')); } }));
  });
  return leaflet;
}
export const dotIcon =(color) => window.L.divIcon({ className: '', html: `<div class="mapdot" style="background:${color}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
