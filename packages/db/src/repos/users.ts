import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../database.js';
import { user } from '../schema/auth.js';

export async function userExists(db: DbOrTx, id: string): Promise<boolean> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, id)).limit(1);
  return row !== undefined;
}
