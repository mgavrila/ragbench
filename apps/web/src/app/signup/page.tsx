import { redirect } from "next/navigation";
import { registerUser } from "@/lib/signup";

export default function SignupPage() {
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
    <form action={doSignup}>
      <h1>Sign up</h1>
      <input name="email" type="email" placeholder="email" required />
      <input name="password" type="password" placeholder="password (8-72 chars)" required />
      <input name="organizationName" placeholder="organization" required />
      <button type="submit">Create account</button>
    </form>
  );
}
