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
      `SELECT invoices.*, (SELECT MAX(created_at) FROM events WHERE invoice_id=invoices.id AND event_type IN ('INVOICING.INVOICE.PAID','RECORD_PAYMENT')) AS paid_at FROM invoices ORDER BY created_at DESC,rowid DESC`,
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
