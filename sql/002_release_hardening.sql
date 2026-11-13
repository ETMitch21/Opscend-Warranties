-- Apply after 001_initial.sql; preserves existing claim data.
ALTER TABLE warranty_evidence ADD COLUMN IF NOT EXISTS expected_bytes BIGINT;
ALTER TABLE warranty_evidence ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS inspection_completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS warranty_evidence_claim_confirmed ON warranty_evidence(claim_id, confirmed_at);
