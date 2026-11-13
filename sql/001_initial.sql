-- Plugin-owned Postgres schema: do not merge into Opscend's Prisma schema.
CREATE TABLE IF NOT EXISTS warranty_shops (
  shop_id TEXT PRIMARY KEY, slug TEXT UNIQUE, installed BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS warranty_claims (
  id UUID PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES warranty_shops(shop_id),
  original_repair_id TEXT, customer_id TEXT, customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL, customer_phone TEXT, device_description TEXT NOT NULL,
  issue TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted',
  inspection_required BOOLEAN NOT NULL DEFAULT FALSE,
  decision TEXT, decision_reason TEXT, customer_charge_cents INT NOT NULL DEFAULT 0,
  replacement_repair_id TEXT, inspection_appointment_id TEXT, repair_appointment_id TEXT,
  payment_reference TEXT, payment_verified_at TIMESTAMPTZ,
  public_token_hash TEXT NOT NULL UNIQUE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_charge CHECK (customer_charge_cents >= 0),
  CONSTRAINT valid_status CHECK (status IN ('submitted','needs_inspection','under_review','denied','awaiting_payment','approved','ready_to_schedule','scheduled','in_repair','completed','closed'))
);
CREATE INDEX IF NOT EXISTS warranty_claims_shop_status ON warranty_claims(shop_id, status, submitted_at DESC);
CREATE TABLE IF NOT EXISTS warranty_evidence (
  id UUID PRIMARY KEY, claim_id UUID NOT NULL REFERENCES warranty_claims(id),
  object_key TEXT NOT NULL, mime_type TEXT NOT NULL, uploaded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS warranty_events (
  id UUID PRIMARY KEY, claim_id UUID NOT NULL REFERENCES warranty_claims(id),
  actor_type TEXT NOT NULL, actor_id TEXT, event TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS warranty_events_claim ON warranty_events(claim_id, created_at);
