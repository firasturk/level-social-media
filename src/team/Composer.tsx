/**
 * The composer: an auto-growing box, Enter sends (or Shift+Enter, by choice), @mentions with a
 * list of people, attachments by button, paste or drop (uploaded as they are added, with a
 * progress ring each), a voice note, an emoji. Disabled with a reason when the studio is offline.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, Mic, Paperclip, Smile, X } from "lucide-react";
import { toast } from "sonner";
import type { Attachment, TeamUser } from "@shared/team";
import { TEAM_FILE_MAX, TEAM_FILE_TYPES, TEAM_IMAGE_MAX, TEAM_MESSAGE_MAX, TEAM_VOICE_MAX } from "@shared/team";
import { insertMention, LEVEL_AI, matchUsers, mentionQuery } from "@shared/team-ui";
import { Avatar } from "./Avatar";
import { EmojiPicker } from "./ui";
import { recordingMime, VoiceRecorder } from "./VoiceNote";
import { useTeam } from "./useTeam";

export interface Draft {
  key: string;
  file: File;
  progress: number;
  attachment?: Attachment;
  error?: string;
  preview?: string;
  duration?: number;
}

/** Files being attached: each uploads as soon as it is added; the message waits for them. */
export function useDrafts() {
  const team = useTeam();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const patch = useCallback((key: string, p: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d))), []);
  const add = useCallback(
    (files: File[], duration?: number) => {
      const fresh: Draft[] = [];
      for (const f of files) {
        const type = f.type || "application/octet-stream";
        if (!TEAM_FILE_TYPES.test(type)) {
          toast.error(`${f.name}: this kind of file is not accepted here.`);
          continue;
        }
        const max = duration ? TEAM_VOICE_MAX : type.startsWith("image/") ? TEAM_IMAGE_MAX : TEAM_FILE_MAX;
        if (f.size > max) {
          toast.error(`${f.name} is too big (${Math.round(f.size / 1024 / 1024)} MB; at most ${Math.round(max / 1024 / 1024)} MB).`);
          continue;
        }
        fresh.push({ key: crypto.randomUUID(), file: f, progress: 0, preview: type.startsWith("image/") ? URL.createObjectURL(f) : undefined, duration });
      }
      if (!fresh.length) return;
      setDrafts((ds) => [...ds, ...fresh]);
      for (const d of fresh) {
        team
          .upload(d.file, (sent, of) => patch(d.key, { progress: of ? sent / of : 0 }), d.duration)
          .then((attachment) => patch(d.key, { attachment, progress: 1 }))
          .catch((e: Error) => patch(d.key, { error: e.message || "The upload failed." }));
      }
    },
    [patch, team],
  );
  const remove = useCallback((key: string) => {
    setDrafts((ds) => {
      const d = ds.find((x) => x.key === key);
      if (d?.preview) URL.revokeObjectURL(d.preview);
      return ds.filter((x) => x.key !== key);
    });
  }, []);
  const retry = useCallback(
    (key: string) => {
      const d = drafts.find((x) => x.key === key);
      if (!d) return;
      patch(key, { error: undefined, progress: 0 });
      team
        .upload(d.file, (sent, of) => patch(key, { progress: of ? sent / of : 0 }), d.duration)
        .then((attachment) => patch(key, { attachment, progress: 1 }))
        .catch((e: Error) => patch(key, { error: e.message || "The upload failed." }));
    },
    [drafts, patch, team],
  );
  const clear = useCallback(() => {
    setDrafts((ds) => {
      ds.forEach((d) => d.preview && URL.revokeObjectURL(d.preview));
      return [];
    });
  }, []);
  return { drafts, add, remove, retry, clear };
}

export function Composer({
  placeholder,
  drafts,
  onAddFiles,
  onRemoveDraft,
  onRetryDraft,
  onSend,
  onEditLast,
  editing,
  onSaveEdit,
  onCancelEdit,
  disabledReason,
  autoFocus,
  users,
  compact = false,
}: {
  placeholder: string;
  drafts: Draft[];
  onAddFiles: (files: File[], duration?: number) => void;
  onRemoveDraft: (key: string) => void;
  onRetryDraft: (key: string) => void;
  onSend: (body: string, attachments: Attachment[]) => void;
  /** Up-arrow in an empty box edits your last message. */
  onEditLast?: () => void;
  editing?: { id: string; body: string } | null;
  onSaveEdit?: (body: string) => void;
  onCancelEdit?: () => void;
  disabledReason?: string | null;
  autoFocus?: boolean;
  users: TeamUser[];
  compact?: boolean;
}) {
  const { enterSends, setEnterSends } = useTeam();
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionsHidden, setMentionsHidden] = useState(false);
  const [caret, setCaret] = useState(0);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const wantCaret = useRef<number | null>(null);

  // Editing a message brings its words into the box.
  useEffect(() => {
    if (editing) {
      setText(editing.body);
      wantCaret.current = editing.body.length;
      requestAnimationFrame(() => box.current?.focus());
    } else setText((t) => (editing === null ? "" : t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  // Grows with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), 200)}px`;
    if (wantCaret.current !== null) {
      el.setSelectionRange(wantCaret.current, wantCaret.current);
      setCaret(wantCaret.current);
      wantCaret.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => box.current?.focus());
  }, [autoFocus]);

  const query = useMemo(() => mentionQuery(text, caret), [text, caret]);
  const candidates = useMemo(() => (query && !mentionsHidden ? matchUsers(users, query.q) : []), [query, users, mentionsHidden]);
  useEffect(() => {
    setMentionIdx(0);
    setMentionsHidden(false);
  }, [query?.q]);

  const pick = (u: TeamUser) => {
    const r = insertMention(text, caret, u);
    setText(r.text);
    wantCaret.current = r.caret;
    box.current?.focus();
  };

  const ready = drafts.every((d) => d.attachment) && !drafts.some((d) => d.error);
  const canSend = !disabledReason && (text.trim().length > 0 || drafts.length > 0) && ready && text.length <= TEAM_MESSAGE_MAX;

  const submit = () => {
    if (editing) {
      if (!text.trim()) return;
      onSaveEdit?.(text.trim());
      setText("");
      return;
    }
    if (!canSend) return;
    onSend(text.trim(), drafts.map((d) => d.attachment!).filter(Boolean));
    setText("");
    setEmoji(false);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (query && candidates.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(candidates[mentionIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionsHidden(true);
        return;
      }
    }
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      onCancelEdit?.();
      setText("");
      return;
    }
    if (e.key === "ArrowUp" && !text && !editing && onEditLast) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      const send = enterSends ? !e.shiftKey : e.metaKey || e.ctrlKey;
      if (send) {
        e.preventDefault();
        submit();
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      onAddFiles(files);
    }
  };

  const insertAt = (s: string) => {
    const start = box.current?.selectionStart ?? text.length;
    const end = box.current?.selectionEnd ?? start;
    const next = text.slice(0, start) + s + text.slice(end);
    setText(next);
    wantCaret.current = start + s.length;
    box.current?.focus();
  };

  const over = text.length > TEAM_MESSAGE_MAX;
  const canRecord = !!recordingMime() && !!navigator.mediaDevices?.getUserMedia;

  return (
    <div className={`tm-composer ${compact ? "compact" : ""} ${editing ? "editing" : ""} ${disabledReason ? "off" : ""}`}>
      {editing && (
        <div className="tm-composer-note">
          Editing your message · Esc to cancel
          <button type="button" className="tm-link-btn" onClick={() => { onCancelEdit?.(); setText(""); }}>
            Cancel
          </button>
        </div>
      )}
      {drafts.length > 0 && (
        <div className="tm-drafts">
          {drafts.map((d) => (
            <div key={d.key} className={`tm-draft ${d.error ? "error" : ""} ${d.attachment ? "done" : ""}`} title={d.error ?? d.file.name}>
              {d.preview ? <img src={d.preview} alt="" /> : <span className="tm-draft-file">{d.duration ? <Mic size={14} /> : <Paperclip size={14} />}<small dir="auto">{d.file.name}</small></span>}
              {!d.attachment && !d.error && (
                <svg className="tm-ring" viewBox="0 0 36 36" aria-label={`${Math.round(d.progress * 100)}%`}>
                  <circle cx="18" cy="18" r="15" />
                  <circle cx="18" cy="18" r="15" style={{ strokeDasharray: `${Math.round(d.progress * 94.2)} 94.2` }} />
                </svg>
              )}
              {d.error && (
                <button type="button" className="tm-draft-retry" onClick={() => onRetryDraft(d.key)}>
                  Retry
                </button>
              )}
              <button type="button" className="tm-draft-x" onClick={() => onRemoveDraft(d.key)} aria-label="Remove">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {recording ? (
        <VoiceRecorder
          onDone={(file, seconds) => {
            setRecording(false);
            onAddFiles([file], seconds);
          }}
          onCancel={() => setRecording(false)}
        />
      ) : (
        <div className="tm-composer-row">
          {query && candidates.length > 0 && (
            <div className="tm-mentions" role="listbox">
              {candidates.map((u, i) => (
                <button key={u.id} type="button" role="option" aria-selected={i === mentionIdx} className={i === mentionIdx ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(u)}>
                  <Avatar user={u} size={22} />
                  <span>{u.name}</span>
                  {u.id === LEVEL_AI.id && <small>read-only assistant</small>}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={box}
            rows={1}
            value={text}
            dir="auto"
            placeholder={disabledReason ?? placeholder}
            disabled={!!disabledReason}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={onKey}
            onPaste={onPaste}
            aria-label={placeholder}
            maxLength={TEAM_MESSAGE_MAX + 200}
          />
          <div className="tm-composer-tools">
            {!editing && (
              <>
                <button type="button" className="tm-icon" title="Attach a file" aria-label="Attach a file" disabled={!!disabledReason} onClick={() => fileInput.current?.click()}>
                  <Paperclip size={17} />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  accept="image/*,application/pdf,audio/*,video/mp4,text/plain,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                  onChange={(e) => {
                    onAddFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
              </>
            )}
            <button type="button" className="tm-icon" title="Mention someone" aria-label="Mention someone" disabled={!!disabledReason} onClick={() => insertAt("@")}>
              <AtSign size={17} />
            </button>
            <span className="tm-emoji-anchor">
              <button type="button" className={`tm-icon ${emoji ? "on" : ""}`} title="Emoji" aria-label="Emoji" disabled={!!disabledReason} onClick={() => setEmoji((v) => !v)}>
                <Smile size={17} />
              </button>
              {emoji && (
                <EmojiPicker
                  up
                  onClose={() => setEmoji(false)}
                  onPick={(e) => {
                    insertAt(e);
                    setEmoji(false);
                  }}
                />
              )}
            </span>
            {!editing && canRecord && !text && drafts.length === 0 ? (
              <button type="button" className="tm-icon" title="Record a voice note (up to 3 minutes)" aria-label="Record a voice note" disabled={!!disabledReason} onClick={() => setRecording(true)}>
                <Mic size={17} />
              </button>
            ) : null}
            <button type="button" className="tm-send" onClick={submit} disabled={editing ? !text.trim() || over : !canSend} aria-label={editing ? "Save" : "Send"} title={editing ? "Save" : enterSends ? "Send (Enter)" : "Send (Cmd/Ctrl+Enter)"}>
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      )}
      <div className="tm-composer-foot">
        {over ? (
          <span className="tm-warn">{text.length - TEAM_MESSAGE_MAX} characters too many</span>
        ) : (
          <button type="button" className="tm-link-btn quiet" onClick={() => setEnterSends(!enterSends)} title="Change which key sends">
            {enterSends ? "Enter sends · Shift+Enter for a new line" : "Cmd/Ctrl+Enter sends · Enter for a new line"}
          </button>
        )}
      </div>
    </div>
  );
}
