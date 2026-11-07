// Opening a connection's sealed credentials. Nothing here reads the configuration when it loads:
// `@hykr/api` exports it.
import { SecretBoxError } from '@hykr/connectors';
import { type Database, integrationConnections } from '@hykr/db';
import { and, eq } from 'drizzle-orm';
import { connectionAad, secretBox } from './settings.js';

/**
 * A connection's credentials, opened, for server code that calls the outside system (a
 * connector handler's `ctx.credentials()`, a later sync job). Another business's connection, a
 * missing one or a value that does not open here: null.
 */
export async function openConnection<C = unknown>(
  db: Database,
  tenantId: string,
  connectionId: string,
): Promise<{ row: typeof integrationConnections.$inferSelect; credentials: C } | null> {
  const [row] = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        eq(integrationConnections.tenantId, tenantId),
      ),
    );
  if (!row) return null;
  const box = secretBox();
  if (!box) return null;
  try {
    const plain = box.open(row.credentialsSealed, connectionAad(row.tenantId, row.id));
    return { row, credentials: JSON.parse(plain) as C };
  } catch (e) {
    if (e instanceof SecretBoxError || e instanceof SyntaxError) return null;
    throw e;
  }
}
