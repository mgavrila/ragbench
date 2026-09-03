import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { users } from "@ragbench/db";
import { getDb } from "@/lib/db";

/** Emails are stored lowercased so lookups are case-insensitive. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const BCRYPT_COST = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Auth.js-free so it stays unit-testable; `auth.ts` wraps it in a Credentials provider.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<{ id: string; organizationId: string } | null> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? { id: user.id, organizationId: user.organizationId } : null;
}
