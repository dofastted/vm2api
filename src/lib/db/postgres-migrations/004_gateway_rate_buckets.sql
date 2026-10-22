CREATE TABLE gateway_rate_buckets (
  bucket_hash text COLLATE "C" PRIMARY KEY,
  tokens double precision NOT NULL CHECK (tokens >= 0),
  updated_at bigint NOT NULL
);
