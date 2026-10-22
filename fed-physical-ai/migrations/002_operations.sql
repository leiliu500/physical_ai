-- Existing checkpoints must be archived and migrated explicitly; never adopt generated state.
ALTER TABLE platform_state ADD CONSTRAINT platform_state_version_2
CHECK (document->>'schemaVersion' = '2') NOT VALID;
