import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { organizations, users } from "@ragbench/db";
import { getDb } from "@/lib/db";
import { hashPassword, normalizeEmail } from "@/auth-core";

const Body = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(8),
  organizationName: z.string().trim().min(1),
});

/** Postgres unique_violation — the email index lost a race with a concurrent signup. */
function isDuplicateEmail(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { password, organizationName } = parsed.data;
  const email = normalizeEmail(parsed.data.email);

  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return NextResponse.json({ error: "email already registered" }, { status: 409 });

  const passwordHash = await hashPassword(password);
  try {
    const result = await db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ name: organizationName }).returning();
      const [user] = await tx
        .insert(users)
        .values({ organizationId: org.id, email, passwordHash })
        .returning();
      return { userId: user.id, organizationId: org.id };
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (isDuplicateEmail(err)) {
      return NextResponse.json({ error: "email already registered" }, { status: 409 });
    }
    throw err;
  }
}
