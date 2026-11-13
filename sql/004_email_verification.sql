CREATE TABLE IF NOT EXISTS warranty_access_challenges (
 claim_id UUID PRIMARY KEY REFERENCES warranty_claims(id) ON DELETE CASCADE,
 otp_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 attempts INT NOT NULL DEFAULT 0, verified_at TIMESTAMPTZ
);
