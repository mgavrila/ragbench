import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";

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
    <form action={login}>
      <h1>Log in</h1>
      {error ? <p role="alert">Invalid email or password.</p> : null}
      <input name="email" type="email" placeholder="email" required />
      <input name="password" type="password" placeholder="password" required />
      <button type="submit">Log in</button>
    </form>
  );
}
