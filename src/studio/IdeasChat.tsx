/**
 * The ideas chat: the month changed by talking about it ("post 3 on the kiwi mojito instead").
 * Making a picture after a change is a separate step the person confirms, never the chat's own doing.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MessageSquareText, Send } from "lucide-react";
import { Orb } from "@/components/Orb";
import VoiceInput from "@/components/VoiceInput";
import { del, post } from "@/api";
import { askConfirm } from "@/lib/confirm";
import type { Config } from "@shared/config";

export default function IdeasChat({
  batchId,
  config,
  busy,
  engineReady,
  refresh,
  onNotes,
  onMake,
  title,
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
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const thread = config?.chat ?? [];
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [thread.length, sending]);
  async function send() {
    const message = text.trim();
    if (!batchId || !message || sending) return;
    setSending(true);
    setText("");
    try {
      const r = await post<{ reply: string; changed: number[]; removed: number; make: number[] }>("/api/studio/posts/chat", { batch: batchId, message });
      await refresh();
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
  async function clear() {
    if (!batchId) return;
    try {
      await del(`/api/studio/posts/chat?batch=${encodeURIComponent(batchId)}`);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <div className="journey-box ideas-chat">
      <div className="journey-box-title">
        <MessageSquareText size={15} />
        <strong>{title ?? "Talk about the ideas"}</strong>
        <span className="journey-box-actions">
          {config?.notes?.trim() ? (
            <button type="button" className="text-button" onClick={() => onNotes("")} title={config.notes}>
              Forget the standing rules
            </button>
          ) : null}
          {thread.length > 0 && (
            <button type="button" className="text-button" onClick={() => void clear()}>
              Clear the thread
            </button>
          )}
        </span>
      </div>
      <div className="ideas-thread" ref={box}>
        {thread.length === 0 && !sending && (
          <div className="ideas-chat-empty">
            <p>Tell me what to change, the way you would tell a colleague. I read the month and change exactly that:</p>
            <ul>
              <li>“Post 3 on the kiwi mojito instead, same idea.”</li>
              <li>“Move the Christmas post to the 24th and make it a greeting.”</li>
              <li>“All the captions in Jordanian Arabic, playful, end with a question.”</li>
              <li>“Add a Mother’s Day post with the cheesecake milkshake.”</li>
              <li>“Make posts 2 and 5 again.”</li>
            </ul>
          </div>
        )}
        {config?.notes?.trim() ? (
          <p className="ideas-chat-rules" dir="auto">
            <span>Standing rules for the words:</span> {config.notes.trim()}
          </p>
        ) : null}
        {thread.map((t, i) => (
          <div key={`${t.at}-${i}`} className={`ideas-msg ${t.role === "user" ? "mine" : "theirs"}`} dir="auto">
            {t.text}
          </div>
        ))}
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
          placeholder="What should change? Enter sends, Shift+Enter for a new line."
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
