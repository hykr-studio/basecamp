-- Memory recall (A8): cosine similarity of two vectors stored as real[], for servers without
-- pgvector. Vectors of different lengths (two models) are never similar.
CREATE OR REPLACE FUNCTION app.memory_cosine(a real[], b real[])
RETURNS double precision
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN cardinality(a) <> cardinality(b) OR s.na = 0 OR s.nb = 0 THEN 0
    ELSE s.dot / (sqrt(s.na) * sqrt(s.nb))
  END
  FROM (
    SELECT coalesce(sum(x::double precision * y), 0) AS dot,
           coalesce(sum(x::double precision * x), 0) AS na,
           coalesce(sum(y::double precision * y), 0) AS nb
    FROM unnest(a, b) AS t(x, y)
  ) s
$$;
