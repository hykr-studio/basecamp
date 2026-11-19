-- Memory recall (A8): pgvector, when this Postgres server offers it, so recall measures distance
-- in C (`<=>` on the stored real[] vectors cast to vector). Without it recall uses
-- app.memory_cosine (sql/post/memory.sql). The API logs which one it found.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'pgvector is available but this role cannot create it: %', SQLERRM;
    END;
  END IF;
END
$$;
