import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyCredentials } from "@/auth-core";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "");
        const password = String(credentials?.password ?? "");
        const user = await verifyCredentials(email, password);
        if (!user) return null;
        return { id: user.id, email, organizationId: user.organizationId } as any;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.userId = (user as any).id;
        token.organizationId = (user as any).organizationId;
      }
      return token;
    },
    session({ session, token }) {
      (session.user as any).id = token.userId;
      (session.user as any).organizationId = token.organizationId;
      return session;
    },
  },
});
