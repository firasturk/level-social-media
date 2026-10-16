import { useState, type FormEvent } from "react";
import LevelLogo from "@/components/LevelLogo";
import { toast } from "sonner";
import { KeyRound, LoaderCircle, Moon, Sun } from "lucide-react";
import { useTheme } from "@/theme";
import { post } from "@/api";
import type { User } from "@shared/types";

export default function AuthScreen({
  registrationOpen,
  onSignedIn,
}: {
  registrationOpen: boolean;
  onSignedIn: (user: User) => void;
}) {
  const [theme, toggleTheme] = useTheme();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", name: "", invite: "" });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { user } = await post<{ user: User }>(`/api/auth/${mode}`, form);
      onSignedIn(user);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <div className="auth-screen">
      <button
        className="theme-button auth-theme"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <form className="auth-card" onSubmit={submit}>
        <LevelLogo className="auth-wordmark" />
        <h1>{mode === "login" ? "Sign in to Level Social Media" : "Create your studio account"}</h1>
        <p className="quality-note">Private workspace for the Level MENA social-media team.</p>
        {mode === "register" && (
          <>
            <label className="field-label" htmlFor="name">
              Name
            </label>
            <input id="name" required autoComplete="name" {...field("name")} />
          </>
        )}
        <label className="field-label" htmlFor="email">
          Email
        </label>
        <input id="email" type="email" required autoComplete="email" {...field("email")} />
        <label className="field-label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={10}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          {...field("password")}
        />
        {mode === "register" && (
          <>
            <label className="field-label" htmlFor="invite">
              Invite code
            </label>
            <input id="invite" required autoComplete="off" {...field("invite")} />
          </>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spinning" size={17} /> : <KeyRound size={17} />}
          {mode === "login" ? "Sign in" : "Create account"}
        </button>
        {registrationOpen && (
          <button
            type="button"
            className="text-button"
            onClick={() => setMode((m) => (m === "login" ? "register" : "login"))}
          >
            {mode === "login"
              ? "Have an invite code? Create an account"
              : "Already registered? Sign in"}
          </button>
        )}
      </form>
    </div>
  );
}
