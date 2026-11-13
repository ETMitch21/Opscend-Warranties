CREATE TABLE IF NOT EXISTS warranty_notifications (
 id UUID PRIMARY KEY, claim_id UUID NOT NULL REFERENCES warranty_claims(id),
 kind TEXT NOT NULL, attempts INT NOT NULL DEFAULT 0,
 locked_until TIMESTAMPTZ, delivered_at TIMESTAMPTZ,
 last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(claim_id,kind)
);
CREATE INDEX IF NOT EXISTS warranty_notifications_pending ON warranty_notifications(delivered_at,locked_until) WHERE delivered_at IS NULL;
