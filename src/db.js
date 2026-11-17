import { DatabaseSync } from 'node:sqlite';
import { MENU } from './menu-seed.js';

// shortcut: SQLite (built into Node) for the MVP and pilot; move to Postgres when running several servers.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS menu_items(
  id TEXT PRIMARY KEY, cat TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT, price INTEGER NOT NULL,
  descr TEXT, tags TEXT, veg INTEGER, best INTEGER, keywords TEXT, image TEXT, sort INTEGER,
  available INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS addons(item_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, PRIMARY KEY(item_id, id));
CREATE TABLE IF NOT EXISTS customers(phone TEXT PRIMARY KEY, name TEXT, last_inbound_at INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS riders(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, token_hash TEXT UNIQUE,
  lat REAL, lng REAL, loc_at INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  payment_method TEXT NOT NULL, payment_status TEXT NOT NULL,
  subtotal INTEGER NOT NULL, fee INTEGER NOT NULL, total INTEGER NOT NULL, vat INTEGER NOT NULL,
  address TEXT, lat REAL, lng REAL, prep_min INTEGER, ready_by INTEGER, rider_id INTEGER,
  track_token TEXT UNIQUE NOT NULL, idem_key TEXT UNIQUE, cash_collected INTEGER, rating INTEGER,
  alerted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_at INTEGER);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);
CREATE TABLE IF NOT EXISTS order_items(order_id INTEGER NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL, unit INTEGER NOT NULL, addons TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, status TEXT NOT NULL, by TEXT, note TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, order_id INTEGER NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT UNIQUE, phone TEXT NOT NULL, dir TEXT NOT NULL, body TEXT, status TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS handoffs(id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, text TEXT, at INTEGER NOT NULL, replied_at INTEGER);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  if (!db.prepare('SELECT COUNT(*) n FROM menu_items').get().n) seedMenu(db);
  return db;
}

function seedMenu(db) {
  const item = db.prepare('INSERT INTO menu_items(id,cat,name_en,name_ar,price,descr,tags,veg,best,keywords,image,sort) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const addon = db.prepare('INSERT INTO addons(item_id,id,name,price) VALUES(?,?,?,?)');
  tx(db, () => MENU.forEach((m, i) => {
    item.run(m.id, m.cat, m.en, m.ar, m.price * 100, m.desc, JSON.stringify(m.tags), m.veg ? 1 : 0, m.best ? 1 : 0, JSON.stringify(m.kw), m.image, i);
    for (const [id, name, price] of m.addons) addon.run(m.id, id, name, price * 100);
  }));
}

/** Run fn inside one transaction; rolls back on any error. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
