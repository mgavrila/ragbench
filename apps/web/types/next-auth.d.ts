import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  /** Set by the `session` callback in `src/auth.ts` from the JWT below. */
  interface Session {
    user: {
      id: string;
      organizationId: string;
    } & DefaultSession["user"];
  }

  /** What `authorize()` returns and what the `jwt` callback reads off `user`. */
  interface User {
    organizationId: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    organizationId?: string;
  }
}
