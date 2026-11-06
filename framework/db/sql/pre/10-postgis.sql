-- PostGIS, for geography columns (`geoPoint` in @hykr/db) and the `geo` list filters.
-- Created only when missing: where an administrator installed it, no privilege is needed. Where it
-- is missing and this role may not create it, the migrate stops here with Postgres's message.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    CREATE EXTENSION postgis;
  END IF;
END
$$;
