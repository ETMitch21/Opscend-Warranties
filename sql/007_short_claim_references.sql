-- Public-facing, non-secret claim reference. UUID and access token remain required for secured operations.
-- A non-cycling sequence guarantees unique six-digit numbers for the first 900,000 claims.
CREATE SEQUENCE IF NOT EXISTS warranty_claim_reference_seq
  AS INTEGER START WITH 100000 INCREMENT BY 1 MINVALUE 100000 MAXVALUE 999999 NO CYCLE;
ALTER TABLE warranty_claims
  ADD COLUMN IF NOT EXISTS reference_number INTEGER;
ALTER TABLE warranty_claims
  ALTER COLUMN reference_number SET DEFAULT nextval('warranty_claim_reference_seq');
-- Backfill records created before this release.
UPDATE warranty_claims
SET reference_number = nextval('warranty_claim_reference_seq')
WHERE reference_number IS NULL;
ALTER TABLE warranty_claims
  ALTER COLUMN reference_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS warranty_claims_reference_number_unique
  ON warranty_claims(reference_number);
ALTER TABLE warranty_claims
  ADD CONSTRAINT warranty_claims_reference_number_six_digits
  CHECK (reference_number BETWEEN 100000 AND 999999);
