// Other ways a person may stand in a business than its team or its parties (B19): a platform
// operator's support access, consented by the business, or an operator at platform scope. The
// resolver asks these providers only when the person names a business (x-tenant-id) where they
// are neither a member nor a participant; a membership or participation always wins.
import type { BusinessStanding, Channel, OnBehalfOf } from '@hykr/contracts';
import { createHookRegistry } from '@hykr/contracts';
import type { Database } from '@hykr/db';

declare module '@hykr/contracts' {
  interface Contributions {
    standingProviders: readonly StandingProvider[];
  }
}

/** What a provider grants a person in one business. Server facts only. */
export interface OtherStanding {
  /** The business's roles whose access applies (unknown ones grant nothing). */
  roles: readonly string[];
  /** The only capabilities held there. */
  capabilities: readonly string[];
  standing: Exclude<BusinessStanding, 'member' | 'participant'>;
  onBehalfOf: OnBehalfOf;
}

export interface StandingProvider {
  /** Unique: 'support'. */
  name: string;
  /**
   * This person, asking for this business (where they are no member and no participant), on
   * this channel: their standing there, or null (the next provider decides; none: 403).
   */
  forUser(a: {
    db: Database;
    userId: string;
    tenantId: string;
    channel?: Channel;
  }): Promise<OtherStanding | null>;
}

/** Standing providers, asked in order; the first answer wins. */
export const standingProviders = createHookRegistry<StandingProvider>(
  'standing provider',
  (p) => p.name,
  { collects: 'standingProviders' },
);
