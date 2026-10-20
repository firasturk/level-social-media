import { useEffect, useState } from "react";
import { BadgeCheck, FolderOpen, Images, KeyRound, LayoutGrid, LogOut, Moon, PanelLeftClose, PanelLeftOpen, ShieldCheck, Sun } from "lucide-react";
import LevelLogo from "@/components/LevelLogo";
import ClientCards from "./ClientCards";
import { initials } from "@shared/clients";
import type { Client, EngineModel, User } from "@shared/types";
import type { EngineInfo } from "./ConnectionDialog";

export type Page = "studio" | "batches" | "styles" | "approvals" | "admin";

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
  pendingStyles = 0,
}: {
  /** Styles waiting for the admin's approval. */
  pendingStyles?: number;
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
  // The menu is a narrow rail of icons until it is opened, so the work has the width.
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("lsm-menu") === "open";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("lsm-menu", open ? "open" : "closed");
    } catch {
      /* private mode */
    }
  }, [open]);
  return (
    <aside className={`sidebar ${open ? "" : "collapsed"}`}>
      <div className="sidebar-top">
        <a href="/" className="sidebar-brand" aria-label="Level Social Media">
          <span className="sidebar-brand-text">
            <LevelLogo className="sidebar-wordmark" />
            <small>Social Media</small>
          </span>
          <span className="sidebar-mark" aria-hidden>
            L
          </span>
        </a>
        <button type="button" className="icon-button sidebar-toggle" onClick={() => setOpen((v) => !v)} title={open ? "Hide the menu" : "Open the menu"} aria-label={open ? "Hide the menu" : "Open the menu"} aria-expanded={open}>
          {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>
      <nav className="sidebar-nav" aria-label="Pages">
        {user.role === "admin" && (
          <button className={`sidebar-approvals ${page === "approvals" ? "active" : ""}`} onClick={() => onPage("approvals")}>
            <BadgeCheck size={17} />
            <span className="sb-text">Approvals</span>
            {pendingStyles > 0 && (
              <span className="count waiting" title={`${pendingStyles} styles and grids waiting for your approval, and lessons learned in the last day`}>
                {pendingStyles}
              </span>
            )}
          </button>
        )}
        <button className={page === "studio" ? "active" : ""} onClick={() => onPage("studio")}>
          <LayoutGrid size={17} />
          <span className="sb-text">Studio</span>
        </button>
        <button className={page === "batches" ? "active" : ""} onClick={() => onPage("batches")}>
          <FolderOpen size={17} />
          <span className="sb-text">Months</span>
          <span className="count">{batches}</span>
        </button>
        <button className={page === "styles" ? "active" : ""} onClick={() => onPage("styles")}>
          <Images size={17} />
          <span className="sb-text">Styles</span>
        </button>
        {user.role === "admin" && (
          <button className={page === "admin" ? "active" : ""} onClick={() => onPage("admin")}>
            <ShieldCheck size={17} />
            <span className="sb-text">Admin</span>
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
