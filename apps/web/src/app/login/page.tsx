import { redirect } from "next/navigation";
import { signIn } from "@/auth";

export default function LoginPage() {
  async function login(formData: FormData) {
    "use server";
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirect: false,
    });
    redirect("/projects");
  }

  return (
    <form action={login}>
      <h1>Log in</h1>
      <input name="email" type="email" placeholder="email" required />
      <input name="password" type="password" placeholder="password" required />
      <button type="submit">Log in</button>
    </form>
  );
}
