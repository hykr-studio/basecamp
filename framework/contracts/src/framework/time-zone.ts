// Time zones: the one check that a string names a zone this runtime knows. Pure (Intl only),
// so the server and the apps agree. A business's zone is resolved on the server (`tenantZone`
// in @hykr/core): its own, else the deployment's, else UTC. docs/decisions/X2.md.

/** Is this an IANA time zone (or UTC) that this runtime's Intl knows? */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
