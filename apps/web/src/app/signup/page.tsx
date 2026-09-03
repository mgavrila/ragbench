import { redirect } from "next/navigation";

export default function SignupPage() {
  async function doSignup(formData: FormData) {
    "use server";
    const res = await fetch(`${process.env.APP_URL ?? "http://localhost:3000"}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password"),
        organizationName: formData.get("organizationName"),
      }),
    });
    if (res.ok) redirect("/login");
    redirect("/signup?error=1");
  }
  return (
    <form action={doSignup}>
      <h1>Sign up</h1>
      <input name="email" type="email" placeholder="email" required />
      <input name="password" type="password" placeholder="password (min 8 chars)" required />
      <input name="organizationName" placeholder="organization" required />
      <button type="submit">Create account</button>
    </form>
  );
}
