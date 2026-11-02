import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base = new URL(process.env.URL || 'https://ledgerly.yufeng.fun/');
const file = 'data/seed-sandbox.json';
const tag = 'ledgerly-demo-seed';
const args = process.argv.slice(2);
if (args.some(a => !['--clean', '--purge-local'].includes(a))) throw Error('Usage: seed:sandbox -- [--clean] [--purge-local]');
const api = async (path, body, admin = false) => {
  const r = await fetch(new URL('api/' + path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-token': process.env.ADMIN_TOKEN || '' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Never print server response bodies or credentials.
  if (!r.ok) throw Error(`API request failed (${r.status})`);
  return r.json();
};
let state;
try { state = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (state && state.url !== base.href) throw Error('Seed manifest belongs to another URL');
state ||= { url: base.href, tag, invoices: [], notes: [] };
const persist = async () => { await mkdir('data', { recursive: true }); await writeFile(file, JSON.stringify(state, null, 2) + '\n'); };
if (args.includes('--clean')) {
  for (const entry of state.invoices) {
    if (entry.cleaned) continue;
    try {
      const i = await api('invoices/' + encodeURIComponent(entry.id));
      if (i.status === 'DRAFT') await api(`invoices/${entry.id}/delete`, {});
      else if (['SENT', 'PARTIALLY_PAID'].includes(i.status)) await api(`invoices/${entry.id}/cancel`, {});
      else { entry.cleanup = 'Remote paid/refunded invoice retained'; await persist(); continue; }
      entry.cleaned = true;
    } catch { entry.cleanup = 'Cleanup unavailable; remote invoice retained'; }
    await persist();
  }
  if (args.includes('--purge-local')) {
    if (!process.env.ADMIN_TOKEN) throw Error('ADMIN_TOKEN required for local purge');
    await api('admin/purge-local', { ids: state.invoices.map(i => i.id) }, true);
  }
  console.log('Cleanup finished; see manifest for retained invoices.');
} else {
  if (state.invoices.length) throw Error('Manifest already contains invoices; archive it after cleanup before reseeding');
  const date = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const clients = ['Northwind Studio', 'Lumen Coffee Co.', 'Atlas Robotics', 'Bluebird Bakery', 'Orbit Media', 'Pine & Co. Architects'];
  for (let n = 0; n < clients.length; n++) {
    const body = { client_name: clients[n], client_email: `demo${n + 1}@example.com`, currency: 'USD', note: tag,
      items: [{ name: `${tag}: freelance services`, quantity: 1, unit_amount: 600 + n * 175 }], due_date: date(n === 4 ? -5 : 14) };
    let cards;
    try { cards = await api('invoices', body); }
    catch (e) {
      if (n !== 4) throw e;
      try { cards = await api('invoices', { ...body, payment_term: 'NET_10', invoice_date: date(-15) }); state.notes.push('Past due date rejected; NET_10 with backdated issue date accepted.'); }
      catch { cards = await api('invoices', { ...body, due_date: date(0) }); state.notes.push('Past dates rejected; earliest attempted allowed due date is today. Invoice becomes overdue tomorrow.'); }
    }
    for (const i of cards.filter(i => i.id)) { state.invoices.push({ id: i.id, client: clients[n] }); await persist(); }
    const id = cards[0].id;
    if (n < 5) {
      const pending = await api(`invoices/${id}/send`, {});
      await api(`actions/${pending[0].id}/confirm`, {});
    }
    if (n < 3) await api(`invoices/${id}/record-payment`, {});
    if (n === 2) {
      const pending = await api(`invoices/${id}/refund`, { amount: 150 });
      await api(`actions/${pending[0].id}/confirm`, {});
    }
  }
  // Persist each month separately so interrupted runs retain every created ID.
  const group = `retainer-${Date.now()}`;
  for (let month = 0; month < 3; month++) {
    const due = new Date(); due.setUTCMonth(due.getUTCMonth() + month + 1, 1);
    const cards = await api('invoices', { client_name: clients[0], client_email: 'demo1@example.com', note: `${tag}: ${group}, month ${month + 1}/3`,
      recurrence_group: group, recurrence: { count: 1 }, due_date: due.toISOString().slice(0, 10), items: [{ name: 'Monthly retainer', quantity: 1, unit_amount: 900 }] });
    state.invoices.push({ id: cards[0].id, series: group, month: month + 1 }); await persist();
  }
  console.log('Seed complete; invoice IDs saved to data/seed-sandbox.json.');
}
