import { db, invoices } from "./db.js";

 db.exec(`CREATE TABLE IF NOT EXISTS collections_state (
 invoice_id TEXT PRIMARY KEY, last_remind_at TEXT, last_tone TEXT,
 remind_count INTEGER NOT NULL DEFAULT 0, next_action_at TEXT, plan_notes TEXT);`);
export function today() {
 const d = new Date();
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const days = (a: string, b: string) => Math.floor((Date.parse(a.slice(0,10)) - Date.parse(b.slice(0,10))) / 86400000);
export const balance = (i: any) => Math.max(0, Math.round((i.amount - Number(i.paid_amount || 0))*100)/100);
export function unpaid(i: any) {
 return balance(i)>0 && !['DRAFT','PAID','CANCELLED','REFUNDED'].includes(i.status) &&
 (['SENT','PARTIALLY_PAID'].includes(i.status) || i.due_date < today());
}
export function scanCollections() {
 const date = today();
 const rows = invoices().filter(i => unpaid(i) && i.due_date && days(i.due_date,date)<=7).map(i => {
  db.prepare('INSERT OR IGNORE INTO collections_state(invoice_id) VALUES (?)').run(i.id);
  const state = db.prepare('SELECT * FROM collections_state WHERE invoice_id=?').get(i.id) as any;
  const overdue_days = Math.max(0,days(date,i.due_date));
  const soon_due = i.due_date >= date;
  const tone = soon_due || state.remind_count===0 ? 'friendly' : overdue_days>20 || state.remind_count>=2 ? 'final' : overdue_days>=7 || state.remind_count===1 ? 'firm' : 'friendly';
  const note = soon_due ? 'Due within 7 days; offer a friendly heads-up.' : `${overdue_days} days overdue; request a payment date.`;
  db.prepare('UPDATE collections_state SET plan_notes=?, next_action_at=COALESCE(next_action_at,?) WHERE invoice_id=?').run(note,date,i.id);
  return {...i, outstanding:balance(i), overdue_days, soon_due, tone, collections_state:{...state,plan_notes:note}, eligible:!state.next_action_at || state.next_action_at.slice(0,10)<=date};
 });
 const totals: Record<string,number> = {};
 rows.forEach(i => totals[i.currency]=(totals[i.currency]||0)+i.outstanding);
 return {kind:'collections', rows, totals, description:'Proposed tones only. Every reminder requires confirmation. Recently reminded invoices wait until their next action date.'};
}
export function reminderPlan(i: any) {
 return {invoice_id:i.id,tone:i.tone,subject:`${i.tone === 'final' ? 'Final notice' : i.tone === 'firm' ? 'Payment overdue' : 'Friendly payment reminder'} · ${i.id}`,
 message:`Hello ${i.client}, your outstanding balance is ${i.currency} ${i.outstanding.toFixed(2)}, due ${i.due_date}. ${i.soon_due ? 'A friendly heads-up before the due date. Thank you!' : i.tone==='final' ? 'Please arrange immediate payment or contact us today.' : i.tone==='firm' ? 'Please pay promptly and confirm your payment date.' : 'Please arrange payment when you have a moment. Thank you!'}`};
}
export function recordReminder(id: string, tone='friendly') {
 const now = new Date(); const next = new Date(now.getTime()+3*86400000).toISOString();
 db.prepare(`INSERT INTO collections_state(invoice_id,last_remind_at,last_tone,remind_count,next_action_at,plan_notes) VALUES (?,?,?,1,?,?)
 ON CONFLICT(invoice_id) DO UPDATE SET last_remind_at=excluded.last_remind_at,last_tone=excluded.last_tone,remind_count=remind_count+1,next_action_at=excluded.next_action_at,plan_notes=excluded.plan_notes`).run(id,now.toISOString(),tone,next,'Reminder sent; review again in 3 days.');
}
export function cashflow() {
 const all = invoices(), date=today(), month=date.slice(0,7);
 const currencies=[...new Set(all.map(i=>i.currency))].sort();
 const groups = currencies.map(currency => {
  const rows=all.filter(i=>i.currency===currency), open=rows.filter(unpaid);
  const sum=(r:any[],f=(i:any)=>balance(i))=>Math.round(r.reduce((s,i)=>s+f(i),0)*100)/100;
  const by_client=[...new Set(rows.map(i=>i.client))].map(client=>{
   const owned=rows.filter(i=>i.client===client), outstanding=owned.filter(unpaid);
   const late_count=owned.filter(i=>i.paid_at && days(i.paid_at,i.due_date)>0).length;
   const overdue=outstanding.filter(i=>i.due_date<date);
   const high=late_count>=2 || overdue.some(i=>days(date,i.due_date)>14);
   return {client,currency,outstanding:sum(outstanding),late_count,risk:high?'high':late_count===1 || overdue.length?'medium':'low',note:`${late_count} late paid invoice(s); ${overdue.length} currently overdue.`};
  });
  return {currency,outstanding:sum(open),receivables_this_month:sum(open.filter(i=>i.due_date?.startsWith(month))),overdue_amount:sum(open.filter(i=>i.due_date<date)),expected_next_7_days:sum(open.filter(i=>i.due_date>=date && days(i.due_date,date)<=7)),unpaid_count:open.length,received_this_month:sum(rows.filter(i=>i.paid_at?.startsWith(month)),i=>Number(i.paid_amount)||i.amount),by_client};
 });
 return {...(groups.find(g=>g.currency==='USD') || {currency:'USD',outstanding:0,receivables_this_month:0,overdue_amount:0,expected_next_7_days:0,unpaid_count:0,received_this_month:0,by_client:[]}),by_currency:groups,risk_method:'heuristic',source:'Local PayPal invoice mirror'};
}
