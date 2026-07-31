CREATE TABLE IF NOT EXISTS subvid_runtime_config (
    config_key text PRIMARY KEY,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS subvid_rate_limits (
    identity_hash text PRIMARY KEY,
    count integer NOT NULL,
    first_at timestamptz NOT NULL,
    blocked_until timestamptz
);

CREATE INDEX IF NOT EXISTS subvid_rate_limits_expiry_idx
    ON subvid_rate_limits (blocked_until, first_at);
