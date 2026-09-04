import { redirect } from "next/navigation";
import Link from "next/link";
import { registerUser } from "@/lib/signup";
import { Notice } from "@/components/notice";
import { cls } from "@/lib/ui";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  // Read directly rather than routed through the server action below: this decides what the page
  // renders, not just what the submit does, so a disabled deployment never shows the form at all --
  // matching the API route's own check in apps/web/src/app/api/signup/route.ts.
  if (process.env.DISABLE_SIGNUP === "1") {
    return (
      <main className="rb-auth">
        <div className="rb-auth__card">
          <span className={cls.eyebrow}>RAGBench</span>
          <h1>Create an account</h1>
          <Notice tone="neutral" role="status">Signups are disabled on this deployment.</Notice>
          <p className="rb-auth__foot">
            Already have one? <Link href="/login">Log in</Link>
          </p>
        </div>
      </main>
    );
  }

  async function doSignup(formData: FormData) {
    "use server";
    const result = await registerUser({
      email: formData.get("email"),
      password: formData.get("password"),
      organizationName: formData.get("organizationName"),
    });
    if (result.ok) redirect("/login");
    redirect("/signup?error=1");
  }

  return (
    <main className="rb-auth">
      <div className="rb-auth__card">
        <span className={cls.eyebrow}>RAGBench</span>
        <h1>Create an account</h1>
        {error ? (
          <Notice>
            Could not create that account. The email may already be registered, or the password is
            outside 8-72 characters.
          </Notice>
        ) : null}
        <form action={doSignup} className="rb-auth__form">
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
              autoComplete="new-password"
              placeholder="8-72 characters"
              required
            />
          </label>
          <label className={cls.field}>
            <span className={cls.fieldLabel}>Organization</span>
            <input className={cls.input} name="organizationName" required />
          </label>
          <button type="submit" className={cls.btnPrimary}>
            Create account
          </button>
        </form>
        <p className="rb-auth__foot">
          Already have one? <Link href="/login">Log in</Link>
        </p>
      </div>
    </main>
  );
}
