-- An immutable captured node identity is attached before sending a KSG2 job.
-- Only authenticated node-persisted completion can end these jobs; neither
-- controller EOF nor a later generation may replace the original identity.
ALTER TABLE execution_jobs ADD COLUMN node_binding jsonb;
ALTER TABLE execution_jobs ADD COLUMN node_completion jsonb;
