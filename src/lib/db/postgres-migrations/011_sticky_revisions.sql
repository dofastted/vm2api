ALTER TABLE sticky_sessions ADD COLUMN deleted_at bigint;
CREATE SEQUENCE sticky_generation_seq AS bigint OWNED BY sticky_sessions.generation;
SELECT setval('sticky_generation_seq', GREATEST(COALESCE((SELECT max(generation) FROM sticky_sessions), 0) + 1, 1), false);
ALTER TABLE sticky_sessions ALTER COLUMN generation SET DEFAULT nextval('sticky_generation_seq');
