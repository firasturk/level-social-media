/**
 * The ideas chat and the Prompt Box, one box: the month changed by talking about it ("post 3 on
 * the kiwi mojito instead"), and a tool asked to act ("find a minimal background from Freepik for
 * post 3", "animate this post with Kling") turned into a card the person confirms. Making a
 * picture, a clip or a search is never the chat's own doing: a card runs only when Run is pressed.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MessageSquareText, Send } from "lucide-react";
import { Orb } from "@/components/Orb";
import VoiceInput from "@/components/VoiceInput";
import { del, post } from "@/api";
import { askConfirm } from "@/lib/confirm";
import type { Config } from "@shared/config";
import { intentRunnable, validateIntent, type IntentAsset, type ToolIntent } from "@shared/promptbox";
import IntentCard, { type Card, type ResultAsset } from "./IntentCard";

interface ChatAnswer {
  kind?: "ideas" | "intent";
  reply: string;
  changed: number[];
  removed: number;
  make: number[];
  intent?: ToolIntent;
  canRun?: boolean;
}

interface ExecuteAnswer {
  kind: "results" | "done";
  intent: ToolIntent;
  results?: ResultAsset[];
  fixture?: boolean;
  note?: string;
}

export default function IdeasChat({
  batchId,
  config,
  busy,
  engineReady,
  refresh,
  onNotes,
  onMake,
  title,
  admin = false,
  openPost = null,
  openSlide = null,
}: {
  batchId: string | null;
  config: Config | null;
  busy: boolean;
  engineReady: boolean;
  refresh: () => Promise<void>;
  onNotes: (notes: string) => void;
  /** How the pictures are made after a change asks for it (the caller confirms and shows the cost); absent: the chat asks itself. */
  onMake?: (indexes: number[]) => Promise<void>;
  title?: React.ReactNode;
  /** Admins may run provider tools; members see the card and the "Admins only for now" note. */
  admin?: boolean;
  /** The post open in the editor, when one is: "this post" means it. */
  openPost?: number | null;
  openSlide?: number | null;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  /** The asset shown or picked last: "this asset" means it. */
  const [lastAsset, setLastAsset] = useState<IntentAsset | null>(null);
  const thread = config?.chat ?? [];
  const posts = (config?.plan ?? []).map((p) => ({ index: p.index, title: p.title, group: p.group ? { kind: p.group.kind, slide: p.group.slide, of: p.group.of } : null }));
  const campaign = config?.month ?? batchId ?? "this month";
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [thread.length, sending, cards]);
  const context = () => ({ post: openPost ?? null, slide: openSlide ?? null, asset: lastAsset });
  const patch = (id: string, f: (c: Card) => Card) => setCards((cs) => cs.map((c) => (c.id === id ? f(c) : c)));
  async function send() {
    const message = text.trim();
    if (!batchId || !message || sending) return;
    setSending(true);
    setText("");
    try {
      const r = await post<ChatAnswer>("/api/studio/posts/chat", { batch: batchId, message, context: context() });
      await refresh();
      if (r.kind === "intent" && r.intent) {
        setCards((cs) => [...cs, { id: crypto.randomUUID(), at: Date.now(), intent: r.intent!, canRun: !!r.canRun }]);
        return;
      }
      if (r.make.length) {
        if (onMake) await onMake(r.make);
        else if (!engineReady) toast.error("No image engine is connected, so the pictures were not made.");
        else if (await askConfirm(`The changes are saved. Make post${r.make.length > 1 ? "s" : ""} ${r.make.join(", ")} now?`, { ok: "Generate now", cancel: "Keep the changes, generate later", danger: false })) {
          await post("/api/studio/posts/generate", { batch: batchId, indexes: r.make, regenerate: true });
          await refresh();
          toast.success(`Making post${r.make.length > 1 ? "s" : ""} ${r.make.join(", ")}.`);
        } else toast.message("The posts are changed; press Generate when you want the pictures.");
      }
    } catch (e) {
      toast.error((e as Error).message, { duration: 10000 });
      setText(message);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }
  /** Runs one card: the press is the confirmation. Browsing returns results; the rest reports what it did. */
  async function run(card: Card) {
    if (!batchId) return;
    patch(card.id, (c) => ({ ...c, intent: card.intent, estimate: card.estimate, running: true, error: undefined }));
    try {
      const r = await post<ExecuteAnswer>("/api/studio/promptbox/execute", { intent: card.intent, confirm: true, estimate: card.estimate, context: context() });
      if (r.kind === "results") {
        patch(card.id, (c) => ({ ...c, running: false, results: r.results ?? [], fixture: r.fixture, done: `${r.results?.length ?? 0} result${r.results?.length === 1 ? "" : "s"}; nothing was downloaded or made.` }));
        if (r.results?.[0]) setLastAsset(r.results[0]);
      } else {
        patch(card.id, (c) => ({ ...c, running: false, fixture: r.fixture, done: r.note || "Done." }));
        toast.success(r.note || "Done.");
        await refresh();
      }
    } catch (e) {
      patch(card.id, (c) => ({ ...c, running: false, error: (e as Error).message }));
      toast.error((e as Error).message, { duration: 10000 });
    }
  }
  /** "Use as reference" / "Add to design" on a result: its own card, through the same contract; free and ready, it runs at once (and is recorded). */
  function useAsset(from: Card, asset: ResultAsset, role: "reference" | "design") {
    if (!batchId) return;
    setLastAsset(asset);
    const target = from.intent.target.post ?? openPost ?? null;
    const intent = validateIntent({ tool: "freepik.use", post: target ?? 0, slide: from.intent.target.slide ?? openSlide ?? 0, role, settings: { role, placement: role === "design" ? "layer" : "" } }, { batch: batchId, posts, openPost: target, openSlide: openSlide ?? null, lastAsset: asset });
    if (!intent) return;
    const card: Card = { id: crypto.randomUUID(), at: Date.now(), intent, canRun: admin };
    setCards((cs) => [...cs, card]);
    if (admin && intent.estimate === 0 && intentRunnable(intent).ok) void run(card);
  }
  async function clear() {
    if (!batchId) return;
    try {
      await del(`/api/studio/posts/chat?batch=${encodeURIComponent(batchId)}`);
      setCards([]);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const items = [...thread.map((m, i) => ({ at: m.at, key: `m-${m.at}-${i}`, msg: m, card: null as Card | null })), ...cards.map((c) => ({ at: c.at, key: c.id, msg: null, card: c }))].sort((a, b) => a.at - b.at);
  return (
    <div className="journey-box ideas-chat">
      <div className="journey-box-title">
        <MessageSquareText size={15} />
        <strong>{title ?? "Talk about the ideas"}</strong>
        <span className="journey-box-actions">
          {openPost !== null ? <span className="ideas-chat-context">Post {openPost} is open</span> : null}
          {config?.notes?.trim() ? (
            <button type="button" className="text-button" onClick={() => onNotes("")} title={config.notes}>
              Forget the standing rules
            </button>
          ) : null}
          {(thread.length > 0 || cards.length > 0) && (
            <button type="button" className="text-button" onClick={() => void clear()}>
              Clear the thread
            </button>
          )}
        </span>
      </div>
      <div className="ideas-thread" ref={box}>
        {thread.length === 0 && cards.length === 0 && !sending && (
          <div className="ideas-chat-empty">
            <p>Tell me what to change, the way you would tell a colleague. I read the month and change exactly that, or lay out a card for a tool to confirm:</p>
            <ul>
              <li>“Post 3 on the kiwi mojito instead, same idea.”</li>
              <li>“Move the Christmas post to the 24th and make it a greeting.”</li>
              <li>“All the captions in Jordanian Arabic, playful, end with a question.”</li>
              <li>“Find a minimal background from Freepik for post 3.”</li>
              <li>“Add this asset behind the headline.”</li>
              <li>“Animate this post using Kling through Higgsfield.”</li>
            </ul>
          </div>
        )}
        {config?.notes?.trim() ? (
          <p className="ideas-chat-rules" dir="auto">
            <span>Standing rules for the words:</span> {config.notes.trim()}
          </p>
        ) : null}
        {items.map((it) =>
          it.msg ? (
            <div key={it.key} className={`ideas-msg ${it.msg.role === "user" ? "mine" : "theirs"}`} dir="auto">
              {it.msg.text}
            </div>
          ) : it.card ? (
            <IntentCard key={it.key} card={it.card} posts={posts} campaign={campaign} admin={admin} selectedAsset={lastAsset} onChange={(next) => patch(next.id, () => next)} onRun={(c) => void run(c)} onUseAsset={useAsset} onPickAsset={(a) => setLastAsset(a)} />
          ) : null,
        )}
        {sending && (
          <div className="ideas-msg theirs thinking">
            <Orb size={16} variant="caption" /> Reading the month…
          </div>
        )}
      </div>
      <div className="ideas-composer">
        <textarea
          ref={input}
          dir="auto"
          value={text}
          rows={2}
          disabled={!batchId || busy}
          placeholder="What should change, or what should a tool do? Enter sends, Shift+Enter for a new line."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <VoiceInput compact onText={(t) => setText((x) => (x.trim() ? `${x.trim()} ${t}` : t))} disabled={!batchId || busy || sending} />
        <button type="button" className="primary" disabled={!text.trim() || sending || busy || !batchId} onClick={() => void send()}>
          {sending ? <Orb size={13} /> : <Send size={13} />} Send
        </button>
      </div>
    </div>
  );
}
