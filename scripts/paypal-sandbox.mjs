import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
dotenv.config({ quiet: true });
const file = process.env.PAYPAL_ENV_FILE || '/home/box/.secrets/paypal_sandbox.env';
if (existsSync(file)) {
  for (const [key, value] of Object.entries(dotenv.parse(readFileSync(file))))
    if (!process.env[key]) process.env[key] = value;
}
const base = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
if (!['https://api-m.sandbox.paypal.com', 'https://api.sandbox.paypal.com'].includes(base))
  throw Error('Only PayPal sandbox endpoints are allowed');
let token;
export async function request(path, method = 'GET', body) {
  if (!token) {
    const r = await fetch(base + '/v1/oauth2/token', {
      method: 'POST', headers: {
        Authorization: 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      }, body: 'grant_type=client_credentials', redirect: 'error',
    });
    if (!r.ok) throw Error(`Sandbox authentication failed (${r.status})`);
    token = (await r.json()).access_token;
  }
  const r = await fetch(base + path, { method, headers: {
    Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error' });
  if (!r.ok) throw Error(`Sandbox request failed (${r.status})`);
  const t = await r.text();
  return t ? JSON.parse(t) : {};
}
export function fail() { console.error('Sandbox operation failed; check configuration and arguments.'); process.exitCode = 1; }
