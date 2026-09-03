import { NextResponse } from "next/server";
import { registerUser } from "@/lib/signup";

export async function POST(req: Request) {
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
