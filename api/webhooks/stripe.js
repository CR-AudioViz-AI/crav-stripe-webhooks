// CR AudioViz AI - Stripe Webhook Handler
// Processes payment events and manages credits automatically
// Deployed as Vercel Serverless Function

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Product to credits mapping
const PRODUCT_CREDITS = {
  'prod_TI6896ICKs0DEL': 100, // Basic Monthly Plan
  'prod_TI63IMdxRSMGKt': 100, // 100 Credits Pack
  'prod_TI6861Obu8vfg7': 500, // 500 Credits Pack
};

export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function getOrCreateCustomer(stripeCustomerId, email, name) {
  // Check if customer exists
  let { data: customer, error } = await supabase
    .from('customers')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (error || !customer) {
    // Create new customer
    const { data: newCustomer, error: insertError } = await supabase
      .from('customers')
      .insert({
        stripe_customer_id: stripeCustomerId,
        email: email,
        name: name,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating customer:', insertError);
      throw insertError;
    }
    customer = newCustomer;
  }

  return customer;
}

async function addCreditsToCustomer(customerId, credits, transactionId, description) {
  const { error } = await supabase.rpc('add_credits', {
    p_customer_id: customerId,
    p_credits: credits,
    p_transaction_id: transactionId,
    p_description: description,
  });

  if (error) {
    console.error('Error adding credits:', error);
    throw error;
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('Processing payment_intent.succeeded:', paymentIntent.id);

  // Get customer info
  const stripeCustomer = await stripe.customers.retrieve(paymentIntent.customer);
  const customer = await getOrCreateCustomer(
    paymentIntent.customer,
    stripeCustomer.email,
    stripeCustomer.name
  );

  // Get product info from metadata or line items
  const checkoutSession = await stripe.checkout.sessions.list({
    payment_intent: paymentIntent.id,
    limit: 1,
  });

  let productId = null;
  let credits = 0;

  if (checkoutSession.data.length > 0) {
    const lineItems = await stripe.checkout.sessions.listLineItems(
      checkoutSession.data[0].id
    );

    if (lineItems.data.length > 0) {
      const priceId = lineItems.data[0].price.id;
      const price = await stripe.prices.retrieve(priceId);
      productId = price.product;
      credits = PRODUCT_CREDITS[productId] || 0;
    }
  }

  // Record transaction
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .insert({
      customer_id: customer.id,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_charge_id: paymentIntent.latest_charge,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: 'succeeded',
      product_type: credits > 0 ? 'credits' : 'subscription',
      credits_purchased: credits,
      metadata: paymentIntent.metadata,
    })
    .select()
    .single();

  if (txError) {
    console.error('Error recording transaction:', txError);
    throw txError;
  }

  // Add credits if applicable
  if (credits > 0) {
    await addCreditsToCustomer(
      customer.id,
      credits,
      transaction.id,
      `Purchased ${credits} credits`
    );
    console.log(`Added ${credits} credits to customer ${customer.email}`);
  }
}

async function handleCheckoutSessionCompleted(session) {
  console.log('Processing checkout.session.completed:', session.id);

  // Get customer
  const stripeCustomer = await stripe.customers.retrieve(session.customer);
  const customer = await getOrCreateCustomer(
    session.customer,
    stripeCustomer.email,
    stripeCustomer.name
  );

  // Get line items to determine product
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id);

  for (const item of lineItems.data) {
    const price = await stripe.prices.retrieve(item.price.id);
    const productId = price.product;
    const credits = PRODUCT_CREDITS[productId] || 0;

    // Handle subscription
    if (price.type === 'recurring') {
      const { error: subError } = await supabase
        .from('subscriptions')
        .insert({
          customer_id: customer.id,
          stripe_subscription_id: session.subscription,
          stripe_product_id: productId,
          status: 'active',
          current_period_start: new Date(session.created * 1000).toISOString(),
        })
        .select()
        .single();

      if (subError && subError.code !== '23505') {
        // Ignore duplicate key errors
        console.error('Error creating subscription:', subError);
      }

      // Add monthly credits for subscription
      if (credits > 0) {
        const { data: transaction } = await supabase
          .from('transactions')
          .insert({
            customer_id: customer.id,
            stripe_payment_intent_id: session.payment_intent,
            amount: session.amount_total,
            currency: session.currency,
            status: 'succeeded',
            product_type: 'subscription',
            credits_purchased: credits,
          })
          .select()
          .single();

        await addCreditsToCustomer(
          customer.id,
          credits,
          transaction.id,
          `Subscription: ${credits} monthly credits`
        );
      }
    }
    // Handle one-time purchase (already handled in payment_intent.succeeded)
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('Processing customer.subscription.updated:', subscription.id);

  // Update subscription status
  const { error } = await supabase
    .from('subscriptions')
    .update({
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id);

  if (error) {
    console.error('Error updating subscription:', error);
  }
}

async function handleSubscriptionDeleted(subscription) {
  console.log('Processing customer.subscription.deleted:', subscription.id);

  // Mark subscription as canceled
  const { error } = await supabase
    .from('subscriptions')
    .update({
      status: 'canceled',
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id);

  if (error) {
    console.error('Error canceling subscription:', error);
  }
}

async function handleInvoicePaymentSucceeded(invoice) {
  console.log('Processing invoice.payment_succeeded:', invoice.id);

  // This handles recurring subscription renewals
  if (invoice.subscription) {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const productId = subscription.items.data[0].price.product;
    const credits = PRODUCT_CREDITS[productId] || 0;

    if (credits > 0) {
      // Get customer
      const { data: customer } = await supabase
        .from('customers')
        .select('*')
        .eq('stripe_customer_id', invoice.customer)
        .single();

      if (customer) {
        // Record transaction
        const { data: transaction } = await supabase
          .from('transactions')
          .insert({
            customer_id: customer.id,
            stripe_payment_intent_id: invoice.payment_intent,
            stripe_charge_id: invoice.charge,
            amount: invoice.amount_paid,
            currency: invoice.currency,
            status: 'succeeded',
            product_type: 'subscription',
            credits_purchased: credits,
          })
          .select()
          .single();

        // Add renewal credits
        await addCreditsToCustomer(
          customer.id,
          credits,
          transaction.id,
          `Subscription renewal: ${credits} credits`
        );
        console.log(`Added ${credits} renewal credits to customer ${customer.email}`);
      }
    }
  }
}

async function logWebhookEvent(eventId, eventType, processed, error, payload) {
  await supabase.from('webhook_events').insert({
    stripe_event_id: eventId,
    event_type: eventType,
    processed: processed,
    error_message: error,
    payload: payload,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log('Received event:', event.type);

  try {
    // Process the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object);
        break;

      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Log successful processing
    await logWebhookEvent(event.id, event.type, true, null, event.data.object);

    res.json({ received: true, processed: true });
  } catch (error) {
    console.error('Error processing webhook:', error);

    // Log failed processing
    await logWebhookEvent(event.id, event.type, false, error.message, event.data.object);

    res.status(500).json({ error: 'Webhook processing failed', message: error.message });
  }
}
