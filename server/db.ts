import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
const path = process.env.DB_PATH || "./data/app.db";
mkdirSync(dirname(path), { recursive: true });
export const db = new Database(path);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY,paypal_id TEXT,client TEXT,email TEXT,amount REAL,currency TEXT,status TEXT,due_date TEXT,recurrence_group TEXT,data TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,invoice_id TEXT,event_type TEXT,data TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY,role TEXT,content TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS paypal_objects (id TEXT PRIMARY KEY,data TEXT);`);
export function invoices() {
  return db
    .prepare(
      `SELECT invoices.*, (SELECT MAX(created_at) FROM events WHERE invoice_id=invoices.id AND event_type IN ('INVOICING.INVOICE.PAID','RECORD_PAYMENT','INVOICE.PAID_VIA_PAYPAL','SYNC.PAID')) AS paid_at FROM invoices ORDER BY created_at DESC,rowid DESC`,
    )
    .all() as any[];
}
export function invoice(id: string) {
  return db
    .prepare("SELECT * FROM invoices WHERE id=? OR paypal_id=?")
    .get(id, id) as any;
}
export function saveObject(o: any) {
  db.prepare("INSERT OR REPLACE INTO paypal_objects VALUES (?,?)").run(
    o.id,
    JSON.stringify(o),
  );
  return o;
}
export function object(id: string) {
  const r = db
    .prepare("SELECT data FROM paypal_objects WHERE id=?")
    .get(id) as any;
  return r ? JSON.parse(r.data) : undefined;
}

for (const [table, column, type] of [
  ["messages", "session_id", "TEXT DEFAULT 'default'"],
  ["messages", "payload", "TEXT"],
  ["invoices", "refunded", "REAL DEFAULT 0"],
  ["invoices", "paid_amount", "REAL DEFAULT 0"],
]) {
  if (
    !(db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(
      (c) => c.name === column,
    )
  )
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, pending TEXT);
CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, session_id TEXT, name TEXT, args TEXT, status TEXT DEFAULT 'pending');`);

db.exec(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, description TEXT, amount REAL, currency TEXT, status TEXT, capture_id TEXT, refunded REAL DEFAULT 0, approve_url TEXT, data TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, order_id TEXT UNIQUE, amount REAL, currency TEXT, status TEXT, refunded REAL DEFAULT 0);`);
export function order(id: string) { return db.prepare("SELECT * FROM orders WHERE id=?").get(id) as any; }
export function orders() { return (db.prepare("SELECT * FROM orders ORDER BY created_at DESC,rowid DESC").all() as any[]).map(o => ({ ...o, kind: "payment", payment: db.prepare("SELECT * FROM payments WHERE order_id=?").get(o.id), timeline: db.prepare("SELECT * FROM events WHERE invoice_id=? ORDER BY rowid").all(o.id) })); }
