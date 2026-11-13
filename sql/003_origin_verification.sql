ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS original_repair_verified_at TIMESTAMPTZ;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS original_repair_verified_by TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS original_repair_verification_note TEXT;
