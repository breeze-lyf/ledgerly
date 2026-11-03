import { request, fail } from './paypal-sandbox.mjs';
try {
  const url = process.argv[2];
  if (!url || !['http:', 'https:'].includes(new URL(url).protocol)) throw Error('URL required');
  const existing = await request('/v1/notifications/webhooks');
  const names = [
    'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.REFUNDED', 'INVOICING.INVOICE.UPDATED',
    'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.DENIED', 'CHECKOUT.ORDER.APPROVED',
    // Retainers (Subscriptions API)
    'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED',
    'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'PAYMENT.SALE.COMPLETED',
  ];
  let webhook = existing.webhooks?.find(w => w.url === url);
  if (!webhook) webhook = await request('/v1/notifications/webhooks', 'POST', { url, event_types: names.map(name => ({ name })) });
  else if (names.some(n => !webhook.event_types?.some(e => e.name === n)))
    webhook = await request(`/v1/notifications/webhooks/${webhook.id}`, 'PATCH',
      [{ op: 'replace', path: '/event_types', value: names.map(name => ({ name })) }]);
  if (!webhook.id) throw Error('Missing webhook id');
  console.log(webhook.id);
} catch { fail(); }
