CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_state (
  id integer PRIMARY KEY CHECK (id = 1),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_audit (
  sequence bigint PRIMARY KEY,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_created_at ON platform_audit(created_at);
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are append-only'; END;
$$;
DROP TRIGGER IF EXISTS platform_audit_immutable ON platform_audit;
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_audit
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
