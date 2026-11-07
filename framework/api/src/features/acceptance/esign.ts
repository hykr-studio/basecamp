// The e-sign provider interface (decisions B8, 20). No provider ships: an application or a
// connector contributes one (`contributes: { esignProviders }`), and its verified webhook calls
// `AcceptanceService.completeESign` with what the provider reported.
import { createHookRegistry } from '@hykr/contracts';
import type { Labels, Lang } from '@hykr/i18n';

declare module '@hykr/contracts' {
  interface Contributions {
    esignProviders: readonly ESignProvider[];
  }
}

/** What a provider is asked to have signed: one PDF, by one person, with the words they agree to. */
export interface ESignStart {
  tenantId: string;
  /** The pending signing's id (ours): give it back as metadata if the provider keeps any. */
  requestId: string;
  acceptance: string;
  document: {
    id: string;
    name: string;
    version: number;
    sha256: string;
    fileName: string;
    /** The PDF's bytes, read when asked for. */
    bytes(): Promise<Buffer>;
  };
  signer: { name: string | null; phone: string | null; email: string | null };
  statement: string;
  lang: Lang;
}

/** Where the signer goes to sign, and the provider's reference for the signing. */
export interface ESignStarted {
  ref: string;
  url?: string;
  expiresAt?: Date;
}

/**
 * What a provider reported about a signing, from its verified webhook (or a poll): signed,
 * declined, expired or failed. `certificate` is the provider's own evidence (its transaction id,
 * the signer's certificate subject), kept in the evidence row as given.
 */
export interface ESignResult {
  provider: string;
  ref: string;
  status: 'signed' | 'declined' | 'expired' | 'failed';
  signedAt?: Date;
  signerName?: string;
  /** The signed PDF's SHA-256, when the provider returns a signed copy. */
  signedSha256?: string;
  certificate?: Record<string, unknown>;
}

/** An e-sign provider: starts signings; their results come back through `completeESign`. */
export interface ESignProvider {
  /** Lower case: 'example-esign'. An acceptance names it in `esign`. */
  name: string;
  label?: Labels;
  start(request: ESignStart): Promise<ESignStarted>;
}

const NAME = /^[a-z][a-z0-9-]*$/;

/** A provider, checked: its name. */
export function defineESignProvider(def: ESignProvider): ESignProvider {
  if (!NAME.test(def.name))
    throw new Error(`E-sign provider "${def.name}": lower case letters, digits and "-"`);
  return def;
}

/** Every registered e-sign provider, by name. Collects `contributes.esignProviders`. */
export const esignProviders = createHookRegistry<ESignProvider>(
  'e-sign provider',
  (p) => defineESignProvider(p).name,
  { collects: 'esignProviders' },
);
