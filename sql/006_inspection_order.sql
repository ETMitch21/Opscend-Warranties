ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS inspection_repair_id TEXT;
CREATE INDEX IF NOT EXISTS warranty_claim_inspection_repair ON warranty_claims(inspection_repair_id);
