import { FolderOpen, KeyRound, LayoutGrid, LogOut, Moon, ShieldCheck, Sun } from "lucide-react";
import LevelLogo from "@/components/LevelLogo";
import ClientCards from "./ClientCards";
import { initials } from "@shared/clients";
import type { Client, EngineModel, User } from "@shared/types";
import type { EngineInfo } from "./ConnectionDialog";

export type Page = "studio" | "batches" | "admin";

/** Left rail: brand, pages, the client list and the connection/user footer. */
export default function Sidebar({
  page,
  onPage,
  user,
  batches,
  engine,
  models,
  onConnection,
  theme,
  onToggleTheme,
  onSignOut,
  clients,
  client,
  locked,
  onClient,
  onClientsChanged,
}: {
  page: Page;
  onPage: (p: Page) => void;
  user: User;
  batches: number;
  engine: EngineInfo;
  models: EngineModel[];
  onConnection: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSignOut: () => void;
  clients: Client[];
  client: string;
  locked: boolean;
  onClient: (id: string) => void;
  onClientsChanged: (clients: Client[]) => void;
}) {
  const connected =
    engine.configured ||
    !!engine.vertex ||
    engine.openai !== "none" ||
    engine.google !== "none" ||
    engine.fal !== "none";
  const modelName = models.find((m) => m.slug === engine.model)?.name ?? engine.model ?? "";
  return (
    <aside className="sidebar">
      <a href="/" className="sidebar-brand" aria-label="Level Social Media">
        <span className="sidebar-brand-text">
          <LevelLogo className="sidebar-wordmark" />
          <small>Social Media</small>
        </span>
      </a>
      <nav className="sidebar-nav" aria-label="Pages">
        <button className={page === "studio" ? "active" : ""} onClick={() => onPage("studio")}>
          <LayoutGrid size={17} />
          Studio
        </button>
        <button className={page === "batches" ? "active" : ""} onClick={() => onPage("batches")}>
          <FolderOpen size={17} />
          Months
          <span className="count">{batches}</span>
        </button>
        {user.role === "admin" && (
          <button className={page === "admin" ? "active" : ""} onClick={() => onPage("admin")}>
            <ShieldCheck size={17} />
            Admin
          </button>
        )}
      </nav>
      <div className="sidebar-clients">
        <ClientCards
          layout="list"
          clients={clients}
          value={client}
          disabled={locked}
          canEdit={user.role === "admin"}
          onChange={(id) => {
            onClient(id);
            onPage("studio");
          }}
          onClientsChanged={onClientsChanged}
        />
      </div>
      <div className="sidebar-foot">
        <button
          className={`sidebar-connection ${connected ? "connected" : ""}`}
          onClick={onConnection}
        >
          <KeyRound size={15} />
          <span>
            {connected ? "Connected" : "Not connected"}
            <small>{modelName || "Choose an engine"}</small>
          </span>
        </button>
        <div className="sidebar-user">
          <span className="sidebar-avatar" aria-hidden="true">
            {initials(user.name)}
          </span>
          <span className="sidebar-name" title={user.email}>
            {user.name}
          </span>
          <button
            className="icon-button"
            onClick={onToggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className="icon-button" onClick={onSignOut} title="Sign out" aria-label="Sign out">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
