import { request, fail } from './paypal-sandbox.mjs';
try {
  const [webhook_id, event_type] = process.argv.slice(2);
  if (!webhook_id || !event_type) throw Error('webhook_id and event_type required');
  await request('/v1/notifications/simulate-event', 'POST', { webhook_id, event_type });
  console.log('Sandbox webhook simulation requested.');
} catch { fail(); }
