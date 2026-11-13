// Time zones: the one check that a string names a zone. Pure (Intl only), so the server and the
// apps agree. A business's zone is resolved on the server (`tenantZone` in @hykr/core): its own,
// else the deployment's, else UTC; the server also asks Postgres (`zoneName`), which reads zones
// in SQL. docs/decisions/X2.md.

/**
 * The only shapes a zone may have: UTC, or an IANA Area/Location name. Intl also takes offsets
 * ("+05:30") and abbreviations ("IST"), which Postgres refuses ("+0530"), reads with the
 * opposite sign ("+05:30" is UTC-05:30 there) or reads as another zone ("IST" is Israel's), so
 * a business's periods computed in SQL would disagree with the ones computed in JS.
 */
const ZONE_SHAPE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * Is this UTC or an IANA Area/Location zone that this runtime's Intl knows? Offsets and
 * abbreviations are not zones here, even where Intl takes them.
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !ZONE_SHAPE.test(value)) return false;
  try {
    // Intl's own name for it must be a zone too, never an offset (an engine may give none).
    const canonical: unknown = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions()
      .timeZone;
    return typeof canonical !== 'string' || ZONE_SHAPE.test(canonical);
  } catch {
    return false;
  }
}
