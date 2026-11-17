// Customer menu: browse, add-ons, cart, checkout (address pin, payment), and login.
// Who the customer is: the WhatsApp link (?t=) or, without one, Supabase phone OTP login.
import { $, esc, aed, api, km, toast, tiles, dotIcon, loadLeaflet, icon } from './common.js';

const q = new URLSearchParams(location.search);
const T = q.get('t');
const app = $('#app'), bar = $('#bar'), layer = $('#layer');
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';

let menu, shop, me = null, linkOk = false, sb = null, sbToken = null;
let veg = false, term = '', lang = 'en';
const cart = new Map(); // "itemId|addon,addon" → qty
const co = { type: 'delivery', payment: 'cod', pin: null, step: 'phone', phone: '', idem: newKey() };
let map = null, marker = null;

function newKey() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
const item = (id) => menu.items.find((i) => i.id === id);
const nm = (i) => (lang === 'ar' && i.nameAr ? i.nameAr : i.name);
const split = (key) => { const [id, a] = key.split('|'); return { id, addons: a ? a.split(',') : [] }; };
const unit = (key) => { const { id, addons } = split(key), it = item(id); return it.price + addons.reduce((s, a) => s + (it.addons.find((o) => o.id === a)?.price || 0), 0); };
const count = () => [...cart.values()].reduce((s, n) => s + n, 0);
const subtotal = () => [...cart].reduce((s, [k, n]) => s + unit(k) * n, 0);
const qtyOf = (id) => [...cart].filter(([k]) => split(k).id === id).reduce((s, [, n]) => s + n, 0);
const canOrder = () => linkOk || !!sbToken;
const hue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 20);

function bump(key, d) {
  const n = (cart.get(key) || 0) + d;
  if (n > 0) cart.set(key, Math.min(n, 20)); else cart.delete(key);
  renderList(); renderBar();
  if ($('.checkout')) { if (!count()) closeLayer(); else renderParts(); }
}

// ---------- boot ----------
boot();
async function boot() {
  try { menu = await api('/api/menu'); } catch (e) { app.innerHTML = `<p class="errbox">${esc(e.message)}</p>`; return; }
  shop = menu.shop;
  document.title = `${shop.name} · Menu`;
  if (T) {
    try { me = await api(`/api/me?t=${encodeURIComponent(T)}`); linkOk = true; } catch { /* expired link: they can still browse */ }
  }
  if (!linkOk && shop.supabase) await restoreSession();
  for (const part of (q.get('c') || '').split(',').filter(Boolean)) { // pre-filled cart from the WhatsApp bot
    const [id, n] = part.split(':');
    if (item(id)?.available) cart.set(`${id}|`, Math.min(Math.max(parseInt(n, 10) || 1, 1), 20));
  }
  renderShell(); renderList(); renderBar();
  const focus = q.get('item');
  if (focus && item(focus)) flash(focus);
  else if (cart.size) openCheckout();
}

function flash(id) {
  const el = $(`#d-${CSS.escape(id)}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2200);
}

function renderShell() {
  const expired = T && !linkOk;
  app.innerHTML = `
  <section class="rcard">
    <div><h1>${esc(shop.name)}</h1><p>${shop.open === shop.close ? "Open 24 hours" : `Open ${esc(shop.open)}–${esc(shop.close)}`} · Delivery within ${shop.radiusKm} km</p></div>
    <div class="rmeta"><span>${shop.deliveryFee ? `Delivery ${aed(shop.deliveryFee)}` : 'Free delivery'}</span>
      <span>${shop.minOrder ? `Min. order ${aed(shop.minOrder)}` : 'No minimum order'}</span></div>
  </section>
  ${expired ? `<p class="warnbox">This menu link has expired. You can still look around. To order, ${shop.supabase ? 'log in with your phone number at checkout, or ' : ''}send us any message on WhatsApp for a new link.</p>` : ''}
  ${me?.name ? `<p class="muted" style="margin:0">Hi ${esc(me.name)}. What would you like today?</p>` : ''}
  <div class="searchrow">
    <label class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" type="search" placeholder="Search dishes" aria-label="Search dishes" autocomplete="off"></label>
    <button class="vegtoggle" id="veg" aria-pressed="false"><span class="vegmark"></span>Veg</button>
    <button class="vegtoggle lang" id="lang" aria-label="Switch language">عربي</button>
  </div>
  <nav class="chips" aria-label="Categories">${menu.categories.map((c) => `<a href="#c-${c.id}">${esc(c.en)}</a>`).join('')}</nav>
  <div id="list"></div>`;
  $('#q').oninput = (e) => { term = e.target.value; renderList(); };
  $('#veg').onclick = (e) => { veg = !veg; e.currentTarget.setAttribute('aria-pressed', veg); renderList(); };
  $('#lang').onclick = (e) => {
    lang = lang === 'en' ? 'ar' : 'en';
    e.currentTarget.textContent = lang === 'en' ? 'عربي' : 'English';
    $('#list').dir = lang === 'ar' ? 'rtl' : 'ltr';
    renderList();
  };
  $('#list').onclick = onListClick;
}

function renderList() {
  const t = term.trim().toLowerCase();
  const shown = menu.items.filter((i) => (!veg || i.veg) && (!t || [i.name, i.nameAr, i.desc, ...i.keywords].join(' ').toLowerCase().includes(t)));
  const html = menu.categories.map((c) => {
    const list = shown.filter((i) => i.cat === c.id);
    if (!list.length) return '';
    return `<h2 class="cathead" id="c-${c.id}">${esc(lang === 'ar' ? c.ar : c.en)} <span>(${list.length})</span></h2>${list.map(dish).join('')}`;
  }).join('');
  $('#list').innerHTML = html || `<p class="empty">No dishes match “${esc(term)}”.</p>`;
}

function dish(i) {
  return `<article class="dish${i.available ? '' : ' sold'}" id="d-${esc(i.id)}">
    <div>
      <div class="drow"><span class="vegmark${i.veg ? '' : ' nv'}" role="img" aria-label="${i.veg ? 'Vegetarian' : 'Non-vegetarian'}"></span>${i.bestseller ? '<span class="best">${icon.star} Bestseller</span>' : ''}</div>
      <h3>${esc(nm(i))}</h3>
      <div class="dprice">${aed(i.price)}</div>
      <p class="ddesc">${esc(i.desc)}</p>
      <div class="tags">${i.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>
    </div>
    <div class="thumbwrap">
      <div class="thumb" style="--h:${hue(i.id)}">${esc(i.name[0])}${i.image ? `<img src="/${esc(i.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
      <div class="addwrap">${control(i)}</div>
      ${i.addons.length && i.available ? '<span class="addonsbtn" aria-hidden="true">Customisable</span>' : ''}
    </div>
  </article>`;
}

function control(i) {
  if (!i.available) return '<span class="soldtag">Sold out</span>';
  const n = qtyOf(i.id);
  if (!n) return `<button class="addbtn2" data-add="${esc(i.id)}" aria-label="Add ${esc(i.name)}">ADD</button>`;
  return `<div class="stepper"><button data-minus="${esc(i.id)}" aria-label="Remove one ${esc(i.name)}">−</button><span class="mono" aria-live="polite">${n}</span><button data-add="${esc(i.id)}" aria-label="Add one more ${esc(i.name)}">+</button></div>`;
}

function onListClick(e) {
  const add = e.target.closest('[data-add]'), minus = e.target.closest('[data-minus]');
  if (add) { const it = item(add.dataset.add); it.addons.length ? openAddons(it) : bump(`${it.id}|`, 1); }
  if (minus) { const keys = [...cart.keys()].filter((k) => split(k).id === minus.dataset.minus); bump(keys.at(-1), -1); }
}

function renderBar() {
  const n = count();
  bar.innerHTML = n ? `<button class="cartbar" id="cartbtn"><span>${n} item${n > 1 ? 's' : ''} · <span class="mono">${aed(subtotal())}</span><small>${shop.deliveryFee ? '' : 'Free delivery · '}No minimum order</small></span><span>View cart →</span></button>` : '';
  if (n) $('#cartbtn').onclick = openCheckout;
}

// ---------- add-ons sheet ----------
function openAddons(it) {
  const sel = new Set(); let n = 1;
  const draw = () => {
    const price = it.price + it.addons.filter((a) => sel.has(a.id)).reduce((s, a) => s + a.price, 0);
    layer.innerHTML = `<div class="addsheet-bg" data-close></div>
    <div class="addsheet" role="dialog" aria-modal="true" aria-label="Customise ${esc(it.name)}">
      <div class="row between"><h3 style="font-size:19px">${esc(nm(it))}</h3><span class="mono">${aed(it.price)}</span></div>
      <p class="muted" style="margin:0">Choose extras (optional)</p>
      ${it.addons.map((a) => `<button class="addopt" data-opt="${esc(a.id)}" aria-pressed="${sel.has(a.id)}"><span class="check">${sel.has(a.id) ? icon.check : ''}</span><span style="flex:1">${esc(a.name)}</span><span class="mono">${a.price ? `+${aed(a.price)}` : 'Free'}</span></button>`).join('')}
      <div class="row between" style="margin-top:8px">
        <div class="stepper"><button data-n="-1" aria-label="Fewer">−</button><span class="mono">${n}</span><button data-n="1" aria-label="More">+</button></div>
        <button class="btn primary" data-confirm style="flex:1">Add · ${aed(price * n)}</button>
      </div>
    </div>`;
  };
  draw();
  layer.onclick = (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return closeLayer();
    const opt = t.closest('[data-opt]');
    if (opt) { sel.has(opt.dataset.opt) ? sel.delete(opt.dataset.opt) : sel.add(opt.dataset.opt); draw(); }
    const dn = t.closest('[data-n]');
    if (dn) { n = Math.min(20, Math.max(1, n + Number(dn.dataset.n))); draw(); }
    if (t.closest('[data-confirm]')) {
      closeLayer();
      bump(`${it.id}|${[...sel].sort().join(',')}`, n);
      toast(`Added ${n}× ${it.name}`);
    }
  };
}

function closeLayer() {
  if (map) map.remove();
  map = null; marker = null;
  layer.innerHTML = ''; layer.onclick = null;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && layer.firstChild) closeLayer(); });

// ---------- checkout ----------
function openCheckout() {
  layer.innerHTML = `<div class="sheet checkout" role="dialog" aria-modal="true" aria-label="Your order">
    <header class="sheethead"><button data-close aria-label="Back to menu">${icon.back}</button><h2>Your order</h2></header>
    <div class="sheet-body">
      <section class="sec" id="lines"></section>
      <div class="seg" role="group" aria-label="Delivery or pickup"><button data-type="delivery">Delivery</button><button data-type="pickup">Pickup</button></div>
      <section class="sec" id="addr">
        <h3>Where should we deliver?</h3>
        <div id="pickmap" class="pickmap" aria-label="Map: tap to place your pin"></div>
        <div class="row between"><button class="sbtn" data-locate>Use my location</button><span class="zone2" id="zone" aria-live="polite"></span></div>
        <div class="fields">
          <label class="full">Building / street *<input id="building" autocomplete="address-line1" maxlength="120"></label>
          <label>Flat / villa no.<input id="flat" autocomplete="address-line2" maxlength="60"></label>
          <label>Makani no. (optional)<input id="makani" inputmode="numeric" maxlength="20"></label>
          <label class="full">Landmark / note for the rider<input id="landmark" maxlength="200"></label>
        </div>
      </section>
      <section class="sec" id="pickup" hidden>
        <h3>Pickup</h3>
        <p class="muted" style="margin:0">Collect from ${esc(shop.name)}. We'll message you on WhatsApp when it's ready. <a href="https://maps.google.com/?q=${shop.lat},${shop.lng}" target="_blank" rel="noopener">Directions</a></p>
      </section>
      <section class="sec"><div class="fields"><label class="full">Your name<input id="name" autocomplete="name" maxlength="80"></label></div></section>
      <section class="sec"><h3>Payment</h3><div class="payopts" id="pay"></div></section>
      <section class="sec sum" id="sum"></section>
      <section id="login"></section>
      <p class="errbox" id="err" role="alert" hidden></p>
    </div>
    <div class="sheet-foot"><button class="btn primary wide" id="place"></button></div>
  </div>`;
  const a = me?.lastAddress;
  if (a) { for (const f of ['building', 'flat', 'landmark', 'makani']) $(`#${f}`).value = a[f] || ''; if (!co.pin && a.lat) co.pin = [a.lat, a.lng]; }
  if (me?.name) $('#name').value = me.name;
  layer.onclick = onCheckoutClick;
  $('#place').onclick = placeOrder;
  setupMap(); renderParts(); renderLogin();
}

function renderParts() {
  const pickup = co.type === 'pickup';
  $('#lines').innerHTML = `<h3>Items</h3>${[...cart].map(([k, n]) => {
    const { id, addons } = split(k), it = item(id);
    const extras = addons.map((x) => it.addons.find((o) => o.id === x)?.name).filter(Boolean).join(', ');
    return `<div class="cline"><div>${esc(it.name)}${extras ? `<small>+ ${esc(extras)}</small>` : ''}</div>
      <div class="stepper"><button data-k="${esc(k)}" data-d="-1" aria-label="Remove one">−</button><span class="mono">${n}</span><button data-k="${esc(k)}" data-d="1" aria-label="Add one">+</button></div>
      <span class="mono">${aed(unit(k) * n)}</span></div>`;
  }).join('')}<button class="sbtn" data-close style="align-self:flex-start">+ Add more items</button>`;
  layer.querySelectorAll('[data-type]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.type === co.type));
  $('#addr').hidden = pickup; $('#pickup').hidden = !pickup;
  if (!pickup) setTimeout(() => map?.invalidateSize(), 0);

  const opts = [
    ...(shop.cardPayments ? [['card', 'Card / Apple Pay', 'Pay now, securely']] : []),
    ['cod', pickup ? 'Cash at pickup' : 'Cash on delivery', ''],
    ['cardod', pickup ? 'Card at the counter' : 'Card machine on delivery', pickup ? '' : 'The rider brings a card machine'],
  ];
  if (!opts.some(([v]) => v === co.payment)) co.payment = 'cod';
  $('#pay').innerHTML = opts.map(([v, label, hint]) => `<button data-pay="${v}" aria-pressed="${co.payment === v}"><span>${label}${hint ? `<br><small>${hint}</small>` : ''}</span><span class="radio" aria-hidden="true"></span></button>`).join('');

  const sub = subtotal(), fee = pickup ? 0 : shop.deliveryFee, total = sub + fee;
  $('#sum').innerHTML = `<div class="line"><span>Items</span><span>${aed(sub)}</span></div>
    ${pickup ? '' : `<div class="line"><span>Delivery</span><span>${fee ? aed(fee) : 'Free'}</span></div>`}
    <div class="line total"><span>Total</span><span>${aed(total)}</span></div>
    <div class="vat">Includes 5% VAT (${aed(Math.round((total * 5) / 105))})</div>`;
  const place = $('#place');
  place.textContent = !canOrder() ? 'Log in to place your order' : co.payment === 'card' ? `Pay ${aed(total)}` : `Place order · ${aed(total)}`;
  place.disabled = !canOrder();
}

function onCheckoutClick(e) {
  const t = e.target;
  if (t.closest('[data-close]')) return closeLayer();
  const k = t.closest('[data-k]');
  if (k) return bump(k.dataset.k, Number(k.dataset.d));
  const ty = t.closest('[data-type]');
  if (ty) { co.type = ty.dataset.type; return renderParts(); }
  const p = t.closest('[data-pay]');
  if (p) { co.payment = p.dataset.pay; return renderParts(); }
  if (t.closest('[data-locate]')) return locate();
  if (t.closest('[data-send]')) return sendCode();
  if (t.closest('[data-verify]')) return verifyCode();
  if (t.closest('[data-change]')) { co.step = 'phone'; return renderLogin(); }
  if (t.closest('[data-logout]')) return logout();
}

// ---------- map pin ----------
async function setupMap() {
  zone();
  try { await loadLeaflet(); } catch { /* handled below */ }
  const el = $('#pickmap');
  if (!el || map) return; // checkout closed while the map was loading
  if (!window.L) { el.outerHTML = '<p class="warnbox">The map could not load. Please type your full address below.</p>'; return; }
  map = window.L.map('pickmap').setView(co.pin || [shop.lat, shop.lng], co.pin ? 16 : 13);
  tiles(map);
  window.L.circle([shop.lat, shop.lng], { radius: shop.radiusKm * 1000, color: '#A85A08', weight: 1, fillOpacity: 0.04 }).addTo(map);
  window.L.marker([shop.lat, shop.lng], { icon: dotIcon('#1F1A14'), title: shop.name, keyboard: false }).addTo(map);
  map.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng));
  if (co.pin) setPin(...co.pin); else zone();
}

function setPin(lat, lng) {
  co.pin = [lat, lng];
  if (map && window.L) {
    if (!marker) {
      marker = window.L.marker(co.pin, { draggable: true, title: 'Your door' }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); setPin(p.lat, p.lng); });
    } else marker.setLatLng(co.pin);
  }
  zone();
}

function zone() {
  const z = $('#zone');
  if (!z) return;
  if (!co.pin) { z.textContent = 'Tap the map to drop a pin at your door'; z.style.color = 'var(--muted)'; return; }
  const d = km({ lat: co.pin[0], lng: co.pin[1] }, shop);
  const ok = d <= shop.radiusKm;
  z.textContent = ok ? `We deliver here (${d.toFixed(1)} km)` : `Outside our delivery area (${d.toFixed(1)} km)`;
  z.style.color = ok ? 'var(--ok)' : 'var(--bad)';
}

function locate() {
  if (!navigator.geolocation) return toast('Your browser cannot share location. Tap the map instead.');
  $('#zone').textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    (p) => { setPin(p.coords.latitude, p.coords.longitude); map?.setView(co.pin, 17); },
    () => { zone(); toast("Couldn't get your location. Tap the map instead."); },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

// ---------- Supabase phone login (only when the customer has no WhatsApp link) ----------
async function client() {
  if (sb) return sb;
  if (!window.supabase) {
    await new Promise((ok, fail) => document.head.append(Object.assign(document.createElement('script'), { src: SUPABASE_JS, onload: ok, onerror: fail })));
  }
  sb = window.supabase.createClient(shop.supabase.url, shop.supabase.anonKey);
  return sb;
}

async function restoreSession() {
  try {
    const { data } = await (await client()).auth.getSession();
    if (!data.session) return;
    sbToken = data.session.access_token;
    me = await api('/api/me', { token: sbToken });
  } catch { sbToken = null; }
}

// UAE numbers: 050 123 4567 → +971501234567
const e164 = (v) => { let d = v.replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('0')) d = `971${d.slice(1)}`; else if (d.length === 9 && d.startsWith('5')) d = `971${d}`; return `+${d}`; };

function renderLogin() {
  const box = $('#login');
  if (!box) return;
  if (linkOk) { box.innerHTML = `<p class="muted" style="margin:0">Ordering as ${esc(me.phone)} (from WhatsApp)</p>`; return; }
  if (sbToken) { box.innerHTML = `<p class="muted row" style="margin:0">Logged in as ${esc(me?.phone || '')} <button class="sbtn" data-logout>Log out</button></p>`; return; }
  if (!shop.supabase) { box.innerHTML = '<p class="warnbox">To order, open this menu from our WhatsApp chat. Send us any message and we\'ll reply with your link.</p>'; return; }
  box.innerHTML = co.step === 'phone'
    ? `<div class="sec"><h3>Log in with your phone number</h3><p class="muted" style="margin:0">We'll text you a 6-digit code. Order updates come on WhatsApp to this number.</p>
       <div class="row"><input class="input" id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="050 123 4567" aria-label="Mobile number" value="${esc(co.phone)}" style="flex:1"><button class="btn primary" data-send>Send code</button></div></div>`
    : `<div class="sec"><h3>Enter the code</h3><p class="muted" style="margin:0">Sent to ${esc(co.phone)}. <button class="sbtn" data-change>Change number</button></p>
       <div class="row"><input class="input" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" aria-label="6-digit code" style="flex:1"><button class="btn primary" data-verify>Verify</button></div></div>`;
}

async function sendCode() {
  const phone = e164($('#phone').value);
  if (phone.length < 11) return showErr('Enter your mobile number, like 050 123 4567.');
  try {
    const { error } = await (await client()).auth.signInWithOtp({ phone });
    if (error) throw error;
    co.phone = phone; co.step = 'code'; showErr(''); renderLogin(); $('#code')?.focus();
  } catch (e) { showErr(e.message || 'Could not send the code. Please try again.'); }
}

async function verifyCode() {
  const token = $('#code').value.trim();
  if (!/^\d{6}$/.test(token)) return showErr('Enter the 6-digit code from the SMS.');
  try {
    const { data, error } = await (await client()).auth.verifyOtp({ phone: co.phone, token, type: 'sms' });
    if (error) throw error;
    sbToken = data.session.access_token;
    me = await api('/api/me', { token: sbToken });
    showErr('');
    if (me.lastAddress && !$('#building').value) { for (const f of ['building', 'flat', 'landmark', 'makani']) $(`#${f}`).value = me.lastAddress[f] || ''; if (!co.pin && me.lastAddress.lat) setPin(me.lastAddress.lat, me.lastAddress.lng); }
    if (me.name && !$('#name').value) $('#name').value = me.name;
    renderLogin(); renderParts();
  } catch (e) { showErr(e.message || 'That code did not work. Please try again.'); }
}

async function logout() {
  await (await client()).auth.signOut().catch(() => {});
  sbToken = null; me = null; co.step = 'phone'; renderLogin(); renderParts();
}

function showErr(msg) { const el = $('#err'); if (!el) return; el.textContent = msg; el.hidden = !msg; if (msg) el.scrollIntoView({ block: 'nearest' }); }

// ---------- place order ----------
async function placeOrder() {
  const delivery = co.type === 'delivery';
  if (delivery && !co.pin) return showErr('Drop a pin on the map (or tap “Use my location”) so the rider can find you.');
  if (delivery && !$('#building').value.trim()) return showErr('Add your building or street name.');
  if (delivery && km({ lat: co.pin[0], lng: co.pin[1] }, shop) > shop.radiusKm) return showErr(`Sorry, we only deliver within ${shop.radiusKm} km. You can choose pickup instead.`);
  const body = {
    idemKey: co.idem, type: co.type, payment: co.payment, name: $('#name').value.trim(),
    items: [...cart].map(([k, qty]) => ({ ...split(k), qty })),
    ...(delivery ? { address: { lat: co.pin[0], lng: co.pin[1], building: $('#building').value, flat: $('#flat').value, landmark: $('#landmark').value, makani: $('#makani').value } } : {}),
  };
  const btn = $('#place');
  btn.disabled = true; btn.textContent = 'Placing your order…'; showErr('');
  try {
    let token;
    if (linkOk) body.token = T;
    else { const { data } = await (await client()).auth.getSession(); token = data.session?.access_token; } // fresh token (auto-refreshed)
    const r = await api('/api/orders', { method: 'POST', body, token });
    location.href = r.payUrl || r.trackUrl;
  } catch (e) {
    showErr(e.message);
    if (e.status === 401) { sbToken = null; linkOk = false; renderLogin(); }
    renderParts();
  }
}
