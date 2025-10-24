# CR AudioViz AI - Stripe Webhook Handler

Automated payment processing and credit delivery system for JavariAI.

## Features

- ✅ Automatic credit delivery on purchase
- ✅ Subscription management (monthly renewals)
- ✅ Customer creation and tracking
- ✅ Transaction logging
- ✅ Webhook event logging for debugging
- ✅ Supabase integration for data persistence

## Endpoints

- `POST /api/webhooks/stripe` - Stripe webhook receiver

## Events Handled

- `payment_intent.succeeded` - One-time credit purchases
- `checkout.session.completed` - Initial subscription setup
- `customer.subscription.updated` - Subscription changes
- `customer.subscription.deleted` - Subscription cancellations
- `invoice.payment_succeeded` - Monthly subscription renewals

## Environment Variables

Required in Vercel:
- `STRIPE_SECRET_KEY` - Stripe secret key
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing secret
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key

## Deployment

Deployed automatically to Vercel on push to main branch.

Webhook URL: `https://your-domain.vercel.app/api/webhooks/stripe`

## Database Schema

See `supabase-schema.sql` for complete database setup.

## Credit Mapping

- Basic Monthly Plan: 100 credits/month
- 100 Credits Pack: 100 credits (one-time)
- 500 Credits Pack: 500 credits (one-time)

## Created

2025-10-23 - Full automation integration
