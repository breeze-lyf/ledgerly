import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1200, height: 1000 } }); const p = await ctx.newPage();
await p.goto('http://localhost:3500/hold/prj_probe'); await p.waitForTimeout(5000);
const f = p.frames().find(f => f.url().includes('smart/buttons'));
const [pop] = await Promise.all([ctx.waitForEvent('page'), f.locator('text=Debit or Credit Card').click()]);
await pop.waitForLoadState('domcontentloaded'); await pop.waitForTimeout(9000);
console.log(pop.url().slice(0, 100));
for (const fr of pop.frames()) { try { const ins = await fr.locator('input,select,button').evaluateAll(es => es.map(e => (e.name || e.id || e.innerText?.slice(0,20)) + ':' + e.type)); console.log(fr.url().slice(0, 60), ins.join(' ')); } catch {} }
await pop.screenshot({ path: '/tmp/probe3.png', fullPage: true });
await b.close();
