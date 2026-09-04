import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { signIn } from "@/auth";
import { Notice } from "@/components/notice";
import { cls } from "@/lib/ui";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  async function login(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirect: false,
      });
    } catch (err) {
      // In the server-action path Auth.js runs in `raw` mode and rethrows
      // CredentialsSignin instead of redirecting, so bad passwords land here.
      if (err instanceof AuthError) redirect(`/login?error=${err.type}`);
      throw err;
    }
    // Outside the try: redirect() signals via a thrown NEXT_REDIRECT.
    redirect("/projects");
  }

  return (
    <main className="rb-auth">
      <div className="rb-auth__card">
        <span className={cls.eyebrow}>RAGBench</span>
        <h1>Log in</h1>
        {error ? <Notice>Invalid email or password.</Notice> : null}
        <form action={login} className="rb-auth__form">
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Email</span>
            <input className={cls.input} name="email" type="email" autoComplete="email" required />
          </label>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Password</span>
            <input
              className={cls.input}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" className={cls.btnPrimary}>
            Log in
          </button>
        </form>
        <p className="rb-auth__foot">
          No account? <Link href="/signup">Sign up</Link>
        </p>
      </div>
    </main>
  );
}
