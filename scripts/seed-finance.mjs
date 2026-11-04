// Reproducible demo state for the finance employee, driven through the running server's HTTP API (sandbox or mock).
//   URL=http://localhost:3000/ GITHUB_WEBHOOK_SECRET=… INTAKE_TOKEN=… [FUND=api|browser|skip] node scripts/seed-finance.mjs
// Builds: 3 fictional projects; GitHub + email intake; Northwind hold funded with the sandbox card, milestone 1
// approved (partial capture + Payouts split); a simulated dispute on that capture (needs mock or DEMO_TOOLS=1);
// client memory (Contoso flips to hold-first); Fabrikam terms negotiated by a client agent over /mcp/client;
// and a pending milestone-2 card for the live demo. Idempotent per DB: existing projects are reused. Never prints secrets.
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
const URL_ = (process.env.URL || 'http://localhost:3000/').replace(/\/?$/, '/');
const API = URL_ + 'api/';
const GH = process.env.GITHUB_WEBHOOK_SECRET, TOKEN = process.env.INTAKE_TOKEN;
if (!GH || !TOKEN) throw Error('GITHUB_WEBHOOK_SECRET and INTAKE_TOKEN must match the server');
const FUND = process.env.FUND || 'api';
const j = async (path, body, headers = {}) => {
  const r = await fetch(API + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const t = await r.text(); const d = t ? JSON.parse(t) : {};
  if (!r.ok) throw Error(`${path}: ${r.status} ${d.error || t.slice(0, 200)}`);
  return d;
};
const log = (...a) => console.log('·', ...a);
const gh = (repo, n, title) => { const b = { action: 'closed', repository: { full_name: repo }, pull_request: { number: n, merged: true, title, body: '', user: { login: 'dev-demo' }, html_url: `https://github.com/${repo}/pull/${n}`, merged_at: new Date().toISOString(), labels: [] } };
  return j('intake/github', b, { 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', GH).update(JSON.stringify(b)).digest('hex') }); };
const mail = (from, id, subject, text) => j('intake/email', { message_id: `<${id}@seed.example>`, from, subject, text }, { authorization: 'Bearer ' + TOKEN });

const PROJECTS = [
  { id: 'prj_northwind', client: 'Northwind Studio', client_email: 'ap@northwind.example', repo: 'demo-org/northwind-site', title: 'Northwind site rebuild',
    sow: 'Rebuild the marketing site: design system, CMS integration, launch. Each milestone is accepted in writing by the client.',
    milestones: [{ id: 'm1', title: 'Design system', amount: 120, keywords: ['design system', 'tokens'], criteria: 'Components in Storybook' },
                 { id: 'm2', title: 'CMS integration', amount: 80, keywords: ['cms'], criteria: 'Editors can publish pages' }],
    splits: [{ name: 'Subcontractor (demo)', email: 'subcontractor-demo@example.com', percent: 25 }] },
  { id: 'prj_contoso', client: 'Contoso Labs', client_email: 'finance@contoso.example', repo: 'demo-org/contoso-app', title: 'Contoso app API',
    sow: 'Public API and docs.', milestones: [{ id: 'c1', title: 'API endpoints', amount: 60, keywords: ['api'] }, { id: 'c2', title: 'Docs', amount: 40, keywords: ['docs'] }] },
  { id: 'prj_fabrikam', client: 'Fabrikam Robotics', client_email: 'ops@fabrikam.example', repo: 'demo-org/fabrikam-portal', title: 'Fabrikam partner portal',
    sow: 'Partner portal with SSO and reports.', milestones: [{ id: 'f1', title: 'SSO', amount: 100, keywords: ['sso'] }, { id: 'f2', title: 'Reports', amount: 100, keywords: ['reports'] }] },
];

async function fundHold(id) {
  const info = await j('hold/' + id);
  if (info.hold?.status === 'active') return log(`${id}: hold already active`);
  if (FUND === 'skip') return log(`${id}: funding skipped`);
  if (info.paypal.mode !== 'sandbox') { const o = await j(`hold/${id}/order`, {}); await j('mock-pay/' + o.id, {}); await j(`hold/${id}/authorize`, { order_id: o.id }); return log(`${id}: hold authorized (mock)`); }
  if (FUND === 'browser') { const { fundViaBrowser } = await import('./fund-hold-browser.mjs'); await fundViaBrowser(URL_ + 'hold/' + id); }
  else {
    // Card through the Orders API (confirm-payment-source) stands in for the client's approval on the /hold page.
    const card = Object.fromEntries(readFileSync('/home/box/.secrets/paypal_sandbox_card.env', 'utf8').split('\n').map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
    const [mm, yy] = card.SANDBOX_CARD_EXP.split('/');
    const { request } = await import('./paypal-sandbox.mjs');
    const o = await j(`hold/${id}/order`, {});
    const c = await request(`/v2/checkout/orders/${o.id}/confirm-payment-source`, 'POST', { payment_source: { card: { number: card.SANDBOX_CARD_NUMBER, expiry: `${yy.length === 2 ? '20' + yy : yy}-${mm.padStart(2, '0')}`, security_code: card.SANDBOX_CARD_CVV, name: 'Demo Client' } } });
    log(`${id}: order ${o.id} confirmed with sandbox card → ${c.status}`);
    await j(`hold/${id}/authorize`, { order_id: o.id });
  }
  const h = (await j('hold/' + id)).hold; log(`${id}: hold ${h.status}, ${h.amount} held, authorization ${h.authorization_id}`);
}
const pendingFor = async (pid, m) => (await j('finance/plans')).find(p => p.project_id === pid && p.milestone_id === m && p.status === 'pending');
const approve = async (pid, m) => { const p = await pendingFor(pid, m); if (!p) return log(`${pid}/${m}: no pending plan`);
  const r = await j('finance/plans/' + p.id, { decision: 'approve' });
  log(`${pid}/${m}: plan ${r.status}`); for (const s of r.steps) log(`   ${s.type}: ${s.status}${s.error ? ' — ' + s.error : ''}${s.result?.capture_id ? ' capture ' + s.result.capture_id : ''}${s.result?.payout_batch_id ? " payout batch " + s.result.payout_batch_id + ' ' + (s.result.batch_status || '') : ''}`);
  return r; };

const have = new Set((await j('finance/projects')).map(p => p.id));
for (const p of PROJECTS) if (!have.has(p.id)) { await j('finance/projects', p); log('project', p.id); }

// Northwind: funds held, milestone 1 delivered + approved → capture + payout.
await fundHold('prj_northwind');
await gh('demo-org/northwind-site', 41, 'Design system: tokens, buttons, forms in Storybook');
await mail('ap@northwind.example', 'nw-m1', 'Re: Design system review', 'We went through Storybook with the team. The design system is approved, great work.\n\n> earlier thread');
await approve('prj_northwind', 'm1');

// Contoso: delivered and approved without a hold → invoice; then a simulated dispute on the Northwind capture would be
// on Northwind. Contoso gets its own funded hold so the dispute lands on Contoso and flips its memory to hold-first.
await fundHold('prj_contoso');
await gh('demo-org/contoso-app', 7, 'API endpoints v1');
await mail('finance@contoso.example', 'ct-c1', 'API endpoints', 'The API endpoints look great, approved.');
const ct = await approve('prj_contoso', 'c1');
const cap = (await j('finance/projects')).find(p => p.id === 'prj_contoso')?.hold?.captures?.[0]?.id;
if (cap && !(await j('finance/plans')).some(p => p.kind === 'dispute')) {
  try { const d = await j('dev/finance-dispute', { capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', amount: { currency_code: 'USD', value: '60.00' } }); log('simulated dispute', d.dispute_id, '→ defense card + evidence PDF'); }
  catch (e) { log('dispute simulation unavailable (set DEMO_TOOLS=1 on the server):', e.message); }
}
log('client memory:', (await j('finance/memory')).map(m => `${m.domain}=${m.strategy}`).join(', '));

// Fabrikam: the client's agent negotiates over MCP, then a human funds the hold.
const nego = await j('finance/projects/prj_fabrikam/negotiation');
if (nego?.status !== 'agreed') {
  const { token } = await j('finance/projects/prj_fabrikam/client-token', {});
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const c = new Client({ name: 'fabrikam-procurement-agent', version: '1.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_ + 'mcp/client'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
  log('client agent tools:', (await c.listTools()).tools.map(t => t.name).join(', '));
  const q = await call('get_quote'); log(`quote: ${q.open_total} ${q.freelancer_currency}`);
  const r1 = await call('propose_terms', { discount_pct: 10, deposit_pct: 0, net_days: 30, note: 'Budget is tight this quarter' }); log('round 1:', r1.decision, JSON.stringify(r1.terms));
  const r2 = await call('propose_terms', { discount_pct: 5, deposit_pct: 100, net_days: 7, note: 'We can hold the full amount if you go to 5%' }); log('round 2:', r2.decision, JSON.stringify(r2.terms));
  const a = await call('accept_terms', { offer_id: r2.offer_id }); log('agreed:', JSON.stringify(a.terms), 'funding', a.funding?.amount, a.funding?.status);
  await c.close();
}
await fundHold('prj_fabrikam');

// Live-demo cards: Northwind milestone 2 and Fabrikam SSO delivered + approved, left pending for a human click.
await gh('demo-org/northwind-site', 44, 'CMS integration: editors can publish pages');
await mail('ap@northwind.example', 'nw-m2', 'CMS', 'Our editors published two pages today. CMS integration approved.');
await gh('demo-org/fabrikam-portal', 12, 'SSO login with Okta + Azure AD');
await mail('ops@fabrikam.example', 'fb-f1', 'Re: SSO', 'Tested SSO with our team this morning. Works great, approved.');
log('pending cards:', (await j('finance/plans')).filter(p => p.status === 'pending').map(p => p.headline).join(' | '));
const w = await j('finance/weekly'); log('week:', JSON.stringify({ collected: w.collected, ai_actions: w.ai_actions, approvals: w.human_approvals, hours_saved: w.hours_saved }));
