/**
 * "Ask Firas": a button on every studio screen that opens the assistant, named Firas after the
 * studio's owner (who receives the requests it cannot answer). A member asks how to do something
 * ("how do I make a carousel?") and gets the steps, with the studio's own labels, from the guide
 * (server/help.ts). When the assistant cannot answer, it says so and drafts a message to Firas,
 * sent with "Send to Firas" (editable first). Admins get the inbox of those requests and mark them
 * done with a reply the sender sees under "My requests". The conversation is kept for the tab only.
 */
import { useEffect, useRef, useState } from "react";
import { Inbox, Send, X } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "@/api";
import { Orb } from "@/components/Orb";
import VoiceInput, { appendDictation } from "@/components/VoiceInput";
import type { User } from "@shared/types";

interface Turn {
  role: "user" | "assistant";
  text: string;
  steps?: string[];
  known?: boolean;
  request?: string;
  /** The question this answer is for (the request quotes it). */
  question?: string;
  sent?: boolean;
}

interface HelpItem {
  id: string;
  user: string;
  kind: string;
  question: string;
  answer: string;
  message: string;
  known: boolean;
  screen: string | null;
  status: string;
  reply: string | null;
  mailed: boolean;
  created: number;
}

const STORE = "lsm-help-chat";
/** What Firas is doing while he answers (the character: grumpy, but on it). */
const THINKING = ["Firas is sighing…", "Firas is finishing his coffee first…", "Firas is looking it up, grudgingly…", "Firas is rolling his eyes…", "Firas is muttering something…", "Firas is opening the guide (again)…"];
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const screenNow = () => `${window.location.pathname}${window.location.search}`.slice(0, 200);

function loadTurns(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Turn[]).slice(-30) : [];
  } catch {
    return [];
  }
}

export default function HelpAssistant({ user }: { user: User }) {
  const admin = user.role === "admin";
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get("help") === "inbox" && admin);
  const [tab, setTab] = useState<"ask" | "requests">(() => (new URLSearchParams(window.location.search).get("help") === "inbox" && admin ? "requests" : "ask"));
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ at: number; message: string; question: string; answer: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [items, setItems] = useState<HelpItem[] | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const end = useRef<HTMLDivElement | null>(null);
  const [thinking, setThinking] = useState(THINKING[0]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(turns.slice(-30)));
    } catch {
      /* the chat is kept for the tab only when storage allows */
    }
    end.current?.scrollIntoView({ block: "end" });
  }, [turns, busy, draft]);

  const loadItems = async () => {
    try {
      if (admin) {
        const r = await get<{ items: HelpItem[]; open: number }>("/api/studio/help/requests?kind=request");
        setItems(r.items);
        setOpenCount(r.open);
      } else {
        const r = await get<{ requests: HelpItem[] }>("/api/studio/help/requests/mine");
        setItems(r.requests);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  useEffect(() => {
    if (admin) void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (open && tab === "requests") void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  async function ask() {
    const message = text.trim();
    if (!message || busy) return;
    const history = turns.slice(-10).map((t) => ({ role: t.role, text: [t.text, ...(t.steps ?? []).map((s, i) => `${i + 1}. ${s}`)].join("\n").slice(0, 3000) }));
    setTurns((t) => [...t, { role: "user", text: message }]);
    setText("");
    setDraft(null);
    setThinking(THINKING[Math.floor(Math.random() * THINKING.length)]);
    setBusy(true);
    try {
      const r = await post<{ answer: string; steps: string[]; known: boolean; request: string }>("/api/studio/help/ask", { message, history, screen: screenNow(), local: { hour: new Date().getHours(), weekday: new Date().getDay() } });
      setTurns((t) => [...t, { role: "assistant", text: r.answer, steps: r.steps, known: r.known, request: r.request, question: message }]);
      if (!r.known && r.request) setDraft({ at: Date.now(), message: r.request, question: message, answer: r.answer });
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", text: (e as Error).message, known: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!draft?.message.trim()) return;
    setSending(true);
    try {
      const r = await post<{ mailed: boolean }>("/api/studio/help/requests", { question: draft.question, message: draft.message, answer: draft.answer, screen: screenNow() });
      setTurns((t) => [...t, { role: "assistant", text: r.mailed ? "Sent to Firas himself: he has it in his e-mail and in the Help inbox. You will see his answer under My requests." : "Sent to Firas himself: he has it in the Help inbox. You will see his answer under My requests.", known: true, sent: true }]);
      setDraft(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function mark(item: HelpItem, status: "open" | "done", reply?: string) {
    try {
      await post(`/api/studio/help/requests/${item.id}`, { status, reply });
      await loadItems();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const lastQuestion = [...turns].reverse().find((t) => t.role === "user")?.text ?? "";
  return (
    <>
      {!open && (
        <button type="button" className="help-fab" onClick={() => setOpen(true)} aria-label="Ask Firas" title="Ask Firas, the studio's assistant, how to do something">
          <img src="/firas-face.png" className="help-face" alt="" width={34} height={34} />
          <span>Ask Firas</span>
          {admin && openCount > 0 && <em className="help-fab-n">{openCount}</em>}
        </button>
      )}
      {open && (
        <aside className="help-panel" aria-label="Firas, the studio's assistant">
          <header className="help-head">
            <b>
              <img src="/firas-face.png" className="help-face small" alt="" width={26} height={26} /> Firas
              <small>the studio's assistant</small>
            </b>
            <nav className="help-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "ask"} className={tab === "ask" ? "on" : ""} onClick={() => setTab("ask")}>
                Ask
              </button>
              <button type="button" role="tab" aria-selected={tab === "requests"} className={tab === "requests" ? "on" : ""} onClick={() => setTab("requests")}>
                {admin ? <Inbox size={13} /> : null} {admin ? `Inbox${openCount ? ` (${openCount})` : ""}` : "My requests"}
              </button>
            </nav>
            <button type="button" className="help-icon" onClick={() => setOpen(false)} aria-label="Close">
              <X size={15} />
            </button>
          </header>

          {tab === "ask" ? (
            <>
              <div className="help-thread">
                {!turns.length && (
                  <div className="help-empty">
                    <p>I'm Firas, the studio's assistant 😠 Grumpy, but I answer. Ask me how to do anything in the studio, in Arabic or English. If it isn't in the studio yet, I pass it to Firas himself.</p>
                    <div className="help-examples">
                      {["How do I make a carousel?", "How do I change the words on a post?", "How do I send the month to the client?"].map((q) => (
                        <button key={q} type="button" onClick={() => setText(q)}>
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {turns.map((t, i) => (
                  <div key={i} className={`help-msg ${t.role} ${t.known === false ? "unknown" : ""}`}>
                    <p dir="auto">{t.text}</p>
                    {!!t.steps?.length && (
                      <ol dir="auto">
                        {t.steps.map((s, j) => (
                          <li key={j}>{s}</li>
                        ))}
                      </ol>
                    )}
                    {t.role === "assistant" && t.known !== false && !t.sent && t.question && (
                      <button type="button" className="help-link help-stuck" onClick={() => setDraft({ at: Date.now(), message: t.question!, question: t.question!, answer: t.text })}>
                        Still stuck? Send it to Firas himself
                      </button>
                    )}
                  </div>
                ))}
                {busy && (
                  <div className="help-msg assistant">
                    <p>
                      <Orb size={14} /> {thinking}
                    </p>
                  </div>
                )}
                {draft && (
                  <div className="help-draft">
                    <b>Send this to Firas himself?</b>
                    <small>He adds or fixes it and answers you under My requests. Change the words if you like.</small>
                    <textarea dir="auto" rows={4} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
                    <div className="help-row">
                      <button type="button" className="help-btn primary" disabled={sending || !draft.message.trim()} onClick={() => void send()}>
                        {sending ? <Orb size={14} /> : <Send size={14} />} Send to Firas himself
                      </button>
                      <button type="button" className="help-btn" onClick={() => setDraft(null)}>
                        Not now
                      </button>
                    </div>
                  </div>
                )}
                <div ref={end} />
              </div>
              <form
                className="help-compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask();
                }}
              >
                <textarea
                  dir="auto"
                  rows={2}
                  value={text}
                  placeholder="Ask Firas: how do I…"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void ask();
                    }
                  }}
                />
                <div className="help-row">
                  <VoiceInput compact onText={(w) => setText((x) => appendDictation(x, w))} disabled={busy} />
                  {turns.length > 0 && (
                    <button type="button" className="help-link" onClick={() => (setTurns([]), setDraft(null))}>
                      New conversation
                    </button>
                  )}
                  <button type="submit" className="help-btn primary" disabled={busy || !text.trim()}>
                    <Send size={14} /> Ask
                  </button>
                </div>
                {!draft && lastQuestion && turns.length > 0 && <small className="help-note">Answers come from the studio's guide. Each question is one short text call.</small>}
              </form>
            </>
          ) : (
            <div className="help-thread">
              {items === null && (
                <p className="help-note">
                  <Orb size={14} /> Reading…
                </p>
              )}
              {items?.length === 0 && <p className="help-note">{admin ? "No requests yet." : "You have not sent Firas anything yet."}</p>}
              {items?.map((r) => (
                <RequestCard key={r.id} item={r} admin={admin} onMark={mark} />
              ))}
            </div>
          )}
        </aside>
      )}
    </>
  );
}

function RequestCard({ item, admin, onMark }: { item: HelpItem; admin: boolean; onMark: (r: HelpItem, status: "open" | "done", reply?: string) => Promise<void> }) {
  const [reply, setReply] = useState(item.reply ?? "");
  const [busy, setBusy] = useState(false);
  const act = async (status: "open" | "done") => {
    setBusy(true);
    await onMark(item, status, reply.trim() || undefined);
    setBusy(false);
  };
  return (
    <article className={`help-req ${item.status}`}>
      <header>
        <b>{admin ? item.user : item.status === "done" ? "Done" : "Waiting for Firas"}</b>
        <small>
          {when(item.created)}
          {admin && item.screen ? ` · ${item.screen}` : ""}
        </small>
      </header>
      <p dir="auto">{item.message}</p>
      {item.question && item.question !== item.message && (
        <small className="help-q" dir="auto">
          Asked: {item.question}
        </small>
      )}
      {admin ? (
        <>
          <textarea dir="auto" rows={2} value={reply} placeholder="A reply they will see (optional)" onChange={(e) => setReply(e.target.value)} />
          <div className="help-row">
            {item.status === "open" ? (
              <button type="button" className="help-btn primary" disabled={busy} onClick={() => void act("done")}>
                Mark done
              </button>
            ) : (
              <button type="button" className="help-btn" disabled={busy} onClick={() => void act("open")}>
                Open again
              </button>
            )}
            {item.reply !== (reply.trim() || null) && item.status === "done" && (
              <button type="button" className="help-btn" disabled={busy} onClick={() => void act("done")}>
                Save the reply
              </button>
            )}
          </div>
        </>
      ) : (
        item.reply && (
          <p className="help-reply" dir="auto">
            <b>Firas:</b> {item.reply}
          </p>
        )
      )}
    </article>
  );
}
