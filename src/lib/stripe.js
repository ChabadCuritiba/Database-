// Online payments via Stripe Checkout. Card data is entered on Stripe's hosted
// page and never touches this server, which keeps PCI scope to SAQ-A.
import Stripe from 'stripe';
import { config } from '../config.js';

let client;
export function stripeClient() {
  if (!config.stripe.secretKey) return null;
  client ||= new Stripe(config.stripe.secretKey);
  return client;
}

export function onlinePaymentsEnabled() {
  return !!config.stripe.secretKey;
}

/**
 * Creates a Checkout session. metadata identifies what is being paid:
 *   { kind: 'donation', fund_id, family_id? } | { kind: 'registration', ref_id } | { kind: 'order', ref_id }
 */
export async function createCheckout({ amount, description, email, metadata, successPath, cancelPath }) {
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: email || undefined,
    line_items: [{
      quantity: 1,
      price_data: { currency: config.currency.toLowerCase(), unit_amount: amount, product_data: { name: description } },
    }],
    metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v ?? '')])),
    success_url: `${config.baseUrl}${successPath}${successPath.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}${cancelPath}`,
  });
  return session.url;
}

export function verifyWebhook(rawBody, signature) {
  return stripeClient().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
