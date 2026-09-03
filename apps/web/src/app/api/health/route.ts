import { NextResponse } from "next/server";
import { organizations } from "@ragbench/db";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    // Probe a table this app owns rather than `select 1`: a reachable but unmigrated database
    // answers `select 1` happily, and reporting that as healthy is the failure mode this
    // endpoint exists to catch.
    await getDb().select({ id: organizations.id }).from(organizations).limit(1);
    return NextResponse.json({ ok: true, db: true });
  } catch (err) {
    console.error("health check failed", err);
    return NextResponse.json({ ok: false, db: false }, { status: 503 });
  }
}
