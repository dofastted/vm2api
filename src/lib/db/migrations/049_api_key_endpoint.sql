-- Keep deleted channel IDs on keys so a missing channel never widens their scope.
ALTER TABLE api_keys ADD COLUMN api_endpoint_id TEXT;
