import { z } from "zod";

const Uuid = z.uuid();

/**
 * Validates a dynamic route segment that is about to be used as a uuid.
 *
 * Every id in this app arrives as a path segment and goes straight into a drizzle `eq(uuidColumn,
 * value)`. Postgres rejects a malformed uuid with "invalid input syntax for type uuid", which is an
 * unhandled exception rather than a query returning nothing -- a 500 on an API route and an error
 * page on a server component, for a URL that a user typo or a stale bookmark can produce. A
 * well-formed id that does not exist already reads as 404, so this makes the malformed case read
 * the same way: callers turn null into a 404 response (routes) or notFound() (pages).
 *
 * Returns the value itself rather than a boolean so a caller cannot accidentally use the unchecked
 * string it was handed.
 */
export function parseUuid(value: string): string | null {
  const parsed = Uuid.safeParse(value);
  return parsed.success ? parsed.data : null;
}
