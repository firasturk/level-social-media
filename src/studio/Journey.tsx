import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, LoaderCircle, RefreshCw } from "lucide-react";
import { post } from "@/api";
import LevelLogo from "@/components/LevelLogo";
import type { Ambassador, Client, Theme, User } from "@shared/types";
import { BrandKit, ThemeSection } from "./BrandPanel";
import Ambassadors from "./Ambassadors";
import { KitIcon, type KitKey } from "./kit";

type ThemesReply = { themes: Theme[] };

const STEPS: { key: string; kit?: KitKey; title: string }[] = [
  { key: "client", title: "Account" },
  { key: "brand", kit: "brand", title: "Brand kit" },
  { key: "identity", kit: "identity", title: "Visual identity" },
  { key: "colours", kit: "colours", title: "Colours" },
  { key: "scene", kit: "shots", title: "Props and shots" },
];

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : "Good evening";
}

function firstName(user: User): string {
  const n = (user.name || user.email.split("@")[0] || "").trim().split(/\s+/)[0] ?? "";
  return n ? n[0].toUpperCase() + n.slice(1) : "";
}

/**
 * The start of a working session, one decision per screen: the account, its brand kit, the
 * people and theme, the colours read from the pins, then the props and shots. Everything edited
 * here is the same live data as the studio's left column; the last step opens the studio.
 */
export default function Journey({
  user,
  clients,
  clientId,
  onClient,
  onClientsChanged,
  themes,
  themeId,
  onTheme,
  onThemesChanged,
  ambassadors,
  onAmbassadorsChanged,
  cast,
  onCast,
  onDone,
}: {
  user: User;
  clients: Client[];
  clientId: string;
  onClient: (id: string) => void;
  onClientsChanged: (clients: Client[]) => void;
  themes: Theme[];
  themeId: string;
  onTheme: (id: string) => void;
  onThemesChanged: (themes: Theme[]) => void;
  ambassadors: Ambassador[];
  onAmbassadorsChanged: (list: Ambassador[]) => void;
  cast: string[];
  onCast: (ids: string[]) => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [reading, setReading] = useState(false);
  const active = clients.filter((c) => c.status === "active");
  const client = active.find((c) => c.id === clientId) ?? null;
  const theme = themes.find((t) => t.id === themeId) ?? null;
  const last = step === STEPS.length - 1;
  const name = firstName(user);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  /** The theme's pins are read: colours, visual language and one shot per picture. */
  async function readReferences(force = false) {
    if (!theme || !theme.references) return;
    if (!force && theme.shots.length && theme.palette.length) return;
    setReading(true);
    try {
      const r = await post<ThemesReply>(`/api/studio/posts/themes/${theme.id}/analyze`);
      onThemesChanged(r.themes);
      if (force) toast.success("References read again: shots and visual language rewritten.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReading(false);
    }
  }

  async function next() {
    if (step === 0 && !client) {
      toast.error("Pick the account you are working on first.");
      return;
    }
    if (STEPS[step].key === "identity") await readReferences();
    if (last) onDone();
    else setStep((s) => s + 1);
  }

  const key = STEPS[step].key;
  return (
    <div className="journey" role="dialog" aria-modal="true" aria-label="Start your session">
      <header className="journey-top">
        <LevelLogo className="journey-logo" />
        <button type="button" className="text-button" onClick={onDone}>
          Skip to the studio
        </button>
      </header>

      <div className="journey-body">
        <div className="journey-step" key={key}>
          {key === "client" && (
            <>
              <h1 className="journey-hello">
                <span className="journey-hello-text">
                  {greeting()}
                  {name ? ` ${name}` : ""}
                </span>{" "}
                <span className="journey-emoji" aria-hidden>
                  😍
                </span>
              </h1>
              <p className="journey-lead">Which account would you like to work on today?</p>
              <div className="journey-clients">
                {active.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`journey-client ${c.id === clientId ? "active" : ""}`}
                    onClick={() => onClient(c.id)}
                    onDoubleClick={() => {
                      onClient(c.id);
                      setStep(1);
                    }}
                  >
                    <span className="journey-client-logo">
                      {c.logo ? (
                        <img src={`/api/studio/clients/${c.id}/logo?v=${c.updated}`} alt="" />
                      ) : (
                        <strong>{c.name.slice(0, 1)}</strong>
                      )}
                    </span>
                    <span>{c.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {key === "brand" && client && (
            <>
              <StepHead kit="brand" title={`Confirm ${client.name}'s brand kit`}>
                Check the colours, fonts, tone of voice and rules. Every change saves itself.
              </StepHead>
              <div className="journey-card">
                <BrandKit client={client} onClientsChanged={onClientsChanged} bare />
              </div>
            </>
          )}

          {key === "identity" && client && (
            <>
              <StepHead kit="identity" title="Visual identity">
                Pick the brand ambassadors for this month, then choose a theme and its Pinterest pins.
              </StepHead>
              <div className="journey-card">
                <h3 className="journey-sub">
                  <KitIcon kit="ambassadors" /> Brand ambassadors
                </h3>
                <Ambassadors
                  client={client}
                  ambassadors={ambassadors}
                  onChanged={onAmbassadorsChanged}
                  cast={cast}
                  onCast={onCast}
                  locked={false}
                />
              </div>
              <div className="journey-card">
                <ThemeSection
                  client={client}
                  themes={themes}
                  theme={themeId}
                  onTheme={onTheme}
                  onThemesChanged={onThemesChanged}
                  parts={["pick", "references"]}
                  bare
                />
              </div>
            </>
          )}

          {key === "colours" && client && (
            <>
              <StepHead kit="colours" title="The colours of this month">
                {theme?.palette.length
                  ? "These colours come from the pins you chose. Would you like to change the colours? The first one is the background of every post."
                  : "Add the month's colours. The first one is the background of every post."}
              </StepHead>
              <div className="journey-card">
                {reading ? (
                  <Reading />
                ) : theme ? (
                  <ThemeSection
                    client={client}
                    themes={themes}
                    theme={themeId}
                    onTheme={onTheme}
                    onThemesChanged={onThemesChanged}
                    parts={["colours"]}
                    bare
                  />
                ) : (
                  <p className="field-hint">No theme this month: the posts use the brand colours.</p>
                )}
              </div>
            </>
          )}

          {key === "scene" && client && (
            <>
              <StepHead kit="shots" title="Props and shots">
                Written from your pins, your products and your colours. Edit anything; the ideas and
                the images follow these.
              </StepHead>
              <div className="journey-card">
                {reading ? (
                  <Reading />
                ) : theme ? (
                  <>
                    <ThemeSection
                      client={client}
                      themes={themes}
                      theme={themeId}
                      onTheme={onTheme}
                      onThemesChanged={onThemesChanged}
                      parts={["props", "shots"]}
                      bare
                    />
                    {theme.references > 0 && (
                      <button type="button" className="text-button" onClick={() => void readReferences(true)}>
                        <RefreshCw size={13} /> Read the pins again
                      </button>
                    )}
                  </>
                ) : (
                  <p className="field-hint">No theme this month: the posts follow the brand identity.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="journey-foot">
        <div className="journey-progress" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <span key={s.key} className={`journey-seg ${i < step ? "done" : i === step ? "now" : ""}`}>
              <i />
              <small>{s.title}</small>
            </span>
          ))}
        </div>
        <div className="journey-actions">
          <span className="journey-left">
            {last ? "Last step" : `${STEPS.length - step - 1} step${STEPS.length - step - 1 > 1 ? "s" : ""} left`}
          </span>
          {step > 0 && (
            <button type="button" className="secondary" onClick={() => setStep((s) => s - 1)} disabled={reading}>
              <ArrowLeft size={15} /> Back
            </button>
          )}
          <button type="button" className="primary" onClick={() => void next()} disabled={reading}>
            {reading ? <LoaderCircle className="spinning" size={15} /> : null}
            {last ? "Open the studio" : "Next"}
            {!reading && <ArrowRight size={15} />}
          </button>
        </div>
      </footer>
    </div>
  );
}

function StepHead({ kit, title, children }: { kit: KitKey; title: string; children: React.ReactNode }) {
  return (
    <div className="journey-head">
      <KitIcon kit={kit} size={18} />
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </div>
  );
}

function Reading() {
  return (
    <div className="journey-reading">
      <LoaderCircle className="spinning" size={18} />
      Reading your pins: colours, visual language and one shot per picture…
    </div>
  );
}
