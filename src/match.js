// Finds menu dishes in a customer's free-text message, tolerating typos ("chiken biriyani")
// and suggesting the closest dish when the exact one isn't on the menu ("orange juice" → Mango Juice).
// shortcut: spelling-distance matching only; swap in Claude for mixed-language or complex orders later.
const STOP = new Set(['and', 'with', 'the', 'for', 'please', 'pls', 'plz', 'want', 'need', 'give', 'send', 'can', 'get',
  'order', 'some', 'also', 'one', 'two', 'three', 'four', 'five', 'six', 'bread', 'wrap']);
const NUM = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

export const words = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 || /^\d+$/.test(w));

function lev(a, b) {
  let p = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[b.length];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);

/**
 * items: [{ id, name, nameAr, keywords }]
 * Returns { exact: [{ id, qty }], closest: [id] }. "exact" = a dish keyword or a small typo of it.
 */
export function matchMenu(text, items) {
  const ws = words(text);
  const exact = [], close = [];
  for (const m of items) {
    const weak = words(`${m.name} ${m.nameAr || ''}`).filter((w) => !STOP.has(w));
    let kw = 0, wk = 0, at = -1;
    ws.forEach((w, i) => {
      if (STOP.has(w) || /^\d+$/.test(w)) return;
      for (const k of m.keywords) { const s = sim(w, k); if (s > kw) { kw = s; at = i; } }
      for (const k of weak) wk = Math.max(wk, sim(w, k) * 0.9);
    });
    if (kw >= 0.75) exact.push({ id: m.id, qty: qtyBefore(ws, at), score: kw });
    else if (wk >= 0.6) close.push({ id: m.id, score: wk });
  }
  return {
    exact: exact.map(({ id, qty }) => ({ id, qty })),
    closest: exact.length ? [] : close.sort((a, b) => b.score - a.score).slice(0, 3).map((c) => c.id),
  };
}

function qtyBefore(ws, at) {
  for (let j = at - 1; j >= Math.max(0, at - 3); j--) {
    if (/^\d+$/.test(ws[j])) return Math.min(Math.max(+ws[j], 1), 20);
    if (NUM[ws[j]]) return NUM[ws[j]];
  }
  return 1;
}
