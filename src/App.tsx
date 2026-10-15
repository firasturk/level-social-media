import { useEffect, useState } from "react";
import { get, setNewBuildHandler } from "./api";
import { toast } from "sonner";
import type { User } from "@shared/types";
import AuthScreen from "./auth/AuthScreen";
import Workspace from "./studio/Workspace";
import BootScreen from "./studio/BootScreen";

type Session = { user: User | null; registrationOpen: boolean };

export default function App() {
  useEffect(() => {
    setNewBuildHandler(() =>
      toast.info("The app was updated. Reload when convenient to keep everything working.", {
        duration: Infinity,
        action: { label: "Reload", onClick: () => window.location.reload() },
      }),
    );
  }, []);
  const [session, setSession] = useState<Session | null | "loading">("loading");

  useEffect(() => {
    get<Session>("/api/auth/me")
      .then(setSession)
      .catch(() => setSession({ user: null, registrationOpen: false }));
  }, []);

  if (session === "loading") return <BootScreen />;
  if (!session?.user) {
    return (
      <AuthScreen
        registrationOpen={session?.registrationOpen ?? false}
        onSignedIn={(user) =>
          setSession({ user, registrationOpen: session?.registrationOpen ?? false })
        }
      />
    );
  }
  return (
    <Workspace
      user={session.user}
      onSignedOut={() => setSession({ user: null, registrationOpen: session.registrationOpen })}
    />
  );
}
