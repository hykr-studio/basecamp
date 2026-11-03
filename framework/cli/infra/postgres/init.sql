CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Default search_path is "$user", public. The role is "app" and so is a schema, so
-- unqualified tables (Better Auth's user/session/...) would land in app, not public.
ALTER ROLE app SET search_path = public;
