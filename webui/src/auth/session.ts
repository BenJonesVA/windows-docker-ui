import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions, users, type User } from '../db/schema.js';

export const SESSION_COOKIE_NAME = 'sbx_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export async function createSession(userId: string): Promise<{ id: string; expiresAt: number }> {
  const id = nanoid(32);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await db.insert(sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

// Server-side revocable — deleting the row is instant and immediately
// invalidates the cookie on the next request, unlike a stateless JWT.
export async function resolveSession(
  sessionId: string | undefined,
): Promise<{ user: User; sessionId: string } | null> {
  if (!sessionId) return null;

  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt < Math.floor(Date.now() / 1000)) {
    await destroySession(sessionId);
    return null;
  }
  if (row.user.disabledAt) return null;

  return { user: row.user, sessionId: row.session.id };
}
