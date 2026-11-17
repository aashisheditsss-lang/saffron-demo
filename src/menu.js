import { CATEGORIES } from './menu-seed.js';

/** Full menu with add-ons. All amounts are in fils (AED × 100). */
export function getMenu(db) {
  const addons = db.prepare('SELECT item_id, id, name, price FROM addons ORDER BY rowid').all();
  const items = db.prepare('SELECT * FROM menu_items ORDER BY sort').all().map((m) => ({
    id: m.id, cat: m.cat, name: m.name_en, nameAr: m.name_ar, price: m.price, desc: m.descr,
    tags: JSON.parse(m.tags || '[]'), veg: !!m.veg, bestseller: !!m.best, image: m.image,
    available: !!m.available, keywords: JSON.parse(m.keywords || '[]'),
    addons: addons.filter((a) => a.item_id === m.id).map(({ id, name, price }) => ({ id, name, price })),
  }));
  return { categories: CATEGORIES, items };
}
