import { request, fail } from './paypal-sandbox.mjs';
try {
  const url = process.argv[2];
  if (!url || !['http:', 'https:'].includes(new URL(url).protocol)) throw Error('URL required');
  const existing = await request('/v1/notifications/webhooks');
  let webhook = existing.webhooks?.find(w => w.url === url);
  if (!webhook) webhook = await request('/v1/notifications/webhooks', 'POST', {
    url, event_types: [
      'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.REFUNDED', 'INVOICING.INVOICE.UPDATED',
      'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.DENIED', 'CHECKOUT.ORDER.APPROVED',
    ].map(name => ({ name })),
  });
  if (!webhook.id) throw Error('Missing webhook id');
  console.log(webhook.id);
} catch { fail(); }
