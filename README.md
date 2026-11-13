# Opscend Warranties RC5

**Development integration candidate; NOT production approved.**

Standalone Railway-hosted Node.js/Fastify + PostgreSQL app, embedded in Opscend via its existing plugin host. See `RELEASE_GATES.md` and parent `DEPLOY_RC5.md` before making any live deployment.

## Implemented
- Customer claim, email verification OTP, photo evidence, original repair lookup
- Shop-scoped staff workspace, inspections, approval/partial/denial, audit events
- Stripe Connect Checkout via Opscend Core, with trusted payment status verification and automatic reconciliation
- Shop-branded email notification delivery via Opscend SES, with persistent retry outbox

## Not implemented
- Automated linked repair creation / conflict-aware scheduling, self-service inspection scheduling
- SMS, token recovery/resend and strong multi-instance security controls
- Production build and end-to-end regression tests

## Local setup
Install Node 22 and PostgreSQL; configure `.env` from `.env.example`, run `npm install`, `npm run build`, `npm run migrate`, then `npm start`.

**Do not assume a successful TypeScript syntax parse is a successful build.**
