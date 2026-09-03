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
        return { id: user.id, email, organizationId: user.organizationId };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.organizationId = user.organizationId;
      }
      return token;
    },
    session({ session, token }) {
      if (token.userId) session.user.id = token.userId;
      if (token.organizationId) session.user.organizationId = token.organizationId;
      return session;
    },
  },
});
