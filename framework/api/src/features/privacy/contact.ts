// Who answers for a business's personal data: its own contact, else the deployment's
// (DEFAULT_GRIEVANCE_CONTACT, checked by assertConfig), else nobody is named. The framework has
// no contact of its own. docs/decisions/X2.md.

/**
 * The deployment's contact; null until first read. The environment is read on first use, not
 * when this module loads: the server's configuration is read once it starts (a test sets the
 * environment before it boots).
 */
let deployment: string | undefined | null = null;

/** The deployment's contact for businesses that named none (tests change it; empty: none). */
export function setDefaultGrievanceContact(contact: string | undefined): void {
  deployment = contact?.trim() || undefined;
}

/** The deployment's contact for businesses that named none, if it set one. */
export function defaultGrievanceContact(): string | undefined {
  if (deployment === null) setDefaultGrievanceContact(process.env.DEFAULT_GRIEVANCE_CONTACT);
  return deployment ?? undefined;
}

/**
 * Who to contact about personal data in this business: its own `grievanceContact`, else the
 * deployment's, else null (none is named).
 */
export function grievanceContactOf(settings: { grievanceContact?: unknown }): string | null {
  const own = settings.grievanceContact;
  if (typeof own === 'string' && own.trim()) return own;
  return defaultGrievanceContact() ?? null;
}
