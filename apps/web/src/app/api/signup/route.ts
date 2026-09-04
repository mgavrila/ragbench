import { NextResponse } from "next/server";
import { registerUser } from "@/lib/signup";

export async function POST(req: Request) {
  // Checked before any db work: an operator running a single-tenant deployment sets this once the
  // first account exists, and the point is to close the door without even touching the database.
  if (process.env.DISABLE_SIGNUP === "1") {
    return NextResponse.json({ error: "signup is disabled" }, { status: 403 });
  }
  const result = await registerUser(await req.json().catch(() => null));
  if (result.ok) {
    const { userId, organizationId } = result;
    return NextResponse.json({ userId, organizationId }, { status: 201 });
  }
  if (result.reason === "duplicate") {
    return NextResponse.json({ error: "email already registered" }, { status: 409 });
  }
  return NextResponse.json({ error: "invalid payload" }, { status: 400 });
}
