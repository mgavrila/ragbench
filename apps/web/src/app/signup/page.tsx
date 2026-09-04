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
