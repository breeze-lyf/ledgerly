// Funds a /hold page through the real PayPal JS SDK: clicks "Debit or Credit Card", fills the sandbox guest card
// form in PayPal's popup with the sandbox card, and waits until the page shows the funds as held. Never prints secrets.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
export async function fundViaBrowser(holdUrl, { screenshot } = {}) {
  const card = Object.fromEntries(readFileSync('/home/box/.secrets/paypal_sandbox_card.env', 'utf8').split('\n').map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
  const [mm, yy] = card.SANDBOX_CARD_EXP.split('/');
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 1000 } }); const page = await ctx.newPage();
    await page.goto(holdUrl);
    const btn = page.frameLocator('iframe[name^="__zoid__paypal_buttons"]').locator('text=Debit or Credit Card');
    await btn.waitFor({ timeout: 30000 });
    const [pop] = await Promise.all([ctx.waitForEvent('page'), btn.click()]);
    await pop.waitForLoadState('domcontentloaded');
    const num = pop.locator('input[name=cardnumber]'); await num.waitFor({ timeout: 45000 });
    await num.fill(card.SANDBOX_CARD_NUMBER);
    await pop.locator('input[name="exp-date"]').fill(`${mm.padStart(2, '0')}/${yy.slice(-2)}`);
    await pop.locator('input[name=cvv]').fill(card.SANDBOX_CARD_CVV);
    await pop.locator('input[name=fname]').fill('Demo'); await pop.locator('input[name=lname]').fill('Client');
    await pop.locator('input[name=billingLine1]').fill('1 Demo Street'); await pop.locator('input[name=billingCity]').fill('San Jose');
    await pop.locator('select[name=billingState]').selectOption('CA').catch(() => {});
    await pop.locator('input[name=billingPostalCode]').fill('95131');
    const opt = async (sel, v) => { const l = pop.locator(sel + ':visible').first(); if (await l.count()) await l.fill(v); };
    const ph = pop.getByLabel('Phone number').first(); await ph.click(); await ph.press('End'); await ph.pressSequentially('4085550100', { delay: 30 }); await opt('input[name=email]', `demo-client-${Date.now()}@example.com`);
    // Some PayPal layouts default "Save info & create your PayPal account" to on; turn it off to pay as a guest.
    const save = pop.locator('input[type=checkbox]:checked').filter({ visible: true });
    for (const c of await save.all()) await c.uncheck({ force: true }).catch(() => {});
    if (await pop.getByText(/create your paypal account/i).count()) { const sw = pop.getByRole('switch'); if (await sw.count() && (await sw.first().getAttribute('aria-checked')) === 'true') await sw.first().click(); }
    const submit = pop.locator('button:visible').filter({ hasText: /as guest|^\s*continue\s*$|pay now/i }).filter({ hasNotText: /create account/i }).last();
    await submit.waitFor({ timeout: 15000 }).catch(async (e) => { console.error('buttons:', await pop.locator('button:visible').allInnerTexts()); throw e; });
    await submit.click();
    await page.locator('.paid').waitFor({ timeout: 90000 }).catch(async (e) => { if (!pop.isClosed()) await pop.screenshot({ path: '/tmp/fund-popup-fail.png', fullPage: true }); throw e; });
    if (screenshot) await page.screenshot({ path: screenshot });
    return (await page.locator('.paid').innerText()).trim();
  } finally { await b.close(); }
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(await fundViaBrowser(process.argv[2], { screenshot: process.argv[3] }));
