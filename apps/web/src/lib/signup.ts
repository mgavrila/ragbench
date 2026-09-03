import { z } from "zod";
import { eq } from "drizzle-orm";
import { organizations, users } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { hashPassword, normalizeEmail } from "@/auth-core";

export const SignupInput = z.object({
  email: z.string().trim().pipe(z.email()),
  // bcrypt silently truncates at 72 bytes, so anything longer would make the ignored tail look
  // like it was protecting the account. Reject it instead.
  password: z.string().min(8).max(72),
  organizationName: z.string().trim().min(1),
});

export type SignupResult =
  | { ok: true; userId: string; organizationId: string }
  | { ok: false; reason: "invalid" | "duplicate" };

/** Postgres unique_violation — the email index lost a race with a concurrent signup. */
function isDuplicateEmail(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

/**
 * Creates an organization and its first user. Takes `unknown` so the API route and the signup
 * page's server action share one validation pass over their (differently shaped) raw inputs.
 */
export async function registerUser(input: unknown): Promise<SignupResult> {
  const parsed = SignupInput.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { password, organizationName } = parsed.data;
  const email = normalizeEmail(parsed.data.email);

  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return { ok: false, reason: "duplicate" };

  const passwordHash = await hashPassword(password);
  try {
    return await db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ name: organizationName }).returning();
      const [user] = await tx
        .insert(users)
        .values({ organizationId: org.id, email, passwordHash })
        .returning();
      return { ok: true as const, userId: user.id, organizationId: org.id };
    });
  } catch (err) {
    if (isDuplicateEmail(err)) return { ok: false, reason: "duplicate" };
    throw err;
  }
}
