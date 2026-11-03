// Shared sandbox helper for spikes. Loads env files; never prints secrets.
import fs from 'node:fs';
export function loadEnv(...files) {
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
loadEnv(process.env.PP_ENV || '/home/box/.secrets/paypal_sandbox.env', process.env.PP_CARD_ENV || '/home/box/.secrets/paypal_sandbox_card.env');
export const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
if (!BASE.includes('sandbox')) throw new Error('Spikes run against sandbox only');
let tok;
export async function token() {
  if (tok) return tok;
  const r = await fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const j = await r.json(); if (!r.ok) throw new Error('oauth ' + r.status + ' ' + j.error);
  return (tok = j.access_token);
}
export async function api(method, path, body, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${await token()}`, 'PayPal-Request-Id': crypto.randomUUID(), ...extraHeaders };
  let payload = body;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, debugId: r.headers.get('paypal-debug-id') };
}
export function log(step, res, pick) {
  const summary = res.status < 300 ? (pick ? pick(res.json) : '') : JSON.stringify({ name: res.json?.name, issue: res.json?.details?.[0]?.issue, desc: res.json?.details?.[0]?.description || res.json?.message });
  console.log(`${step}: HTTP ${res.status} ${summary}`);
}
