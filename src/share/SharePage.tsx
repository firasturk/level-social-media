import { useEffect, useMemo, useState, useRef } from "react";
import { Check, MessageSquare } from "lucide-react";
import { Orb } from "@/components/Orb";
import { applyTheme } from "@/theme";
import { loadFont } from "@/lib/overlay";
import LevelLogo from "@/components/LevelLogo";
import OverlayPreview from "@/studio/OverlayPreview";
import { resolveOverlay, type OverlaySpec, type PostOverlayPatch } from "@shared/overlay";
import { monthLabel } from "@shared/posts";
import { shortDate } from "@shared/occasions";
import type { Approval } from "@shared/config";

interface SharedPost {
  index: number;
  date: string | null;
  headline: string;
  subline: string;
  overlay: boolean;
  ov: PostOverlayPatch | null;
  caption: string;
  hashtags: string;
  /** Faces in the picture as [x, y, w, h] fractions: the words keep off them. */
  faces?: number[][];
  /** A carousel's slide or a series' post. */
  group?: { kind: "carousel" | "series"; slide: number; of: number } | null;
  image: number | null;
  approval: Approval | null;
}

interface Shared {
  client: { name: string; overlay: Partial<OverlaySpec> | null; logo: boolean; badge: boolean; fonts: { id: string; name: string }[]; updated: number };
  month: string;
  /** A grid month: no dark fade behind the words. */
  grid?: boolean;
  /** The posts in feed order (the newest first, or by grid tile). */
  order?: number[];
  monthFonts?: { headline: string; body: string } | null;
  posts: SharedPost[];
}

/** The client's view of a month: every post as it will go out, to approve or to send back. */
export default function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState("");
  const base = `/api/share/${token}`;
  // Who is answering: typed once, kept on this device, sent with every approval or change request.
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem("lsm-share-name") ?? "";
    } catch {
      return "";
    }
  });
  const [needName, setNeedName] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const askName = () => {
    setNeedName(true);
    setEditingName(true);
    nameRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => nameRef.current?.focus(), 350);
  };
  const rename = (n: string) => {
    setName(n);
    try {
      localStorage.setItem("lsm-share-name", n);
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    applyTheme("light", false);
    fetch(base)
      .then(async (r) => {
        const d = (await r.json()) as Shared & { error?: string };
        if (!r.ok) throw new Error(d.error || "This link is not valid.");
        for (const f of d.client.fonts) void loadFont(f.name, `${base}/font/${f.id}`);
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
  }, [base]);

  const spec = useMemo(() => {
    if (!data) return null;
    const s = resolveOverlay(data.client.overlay);
    const fonts = data.monthFonts;
    return {
      ...s,
      ...(fonts ? { headline: { ...s.headline, font: fonts.headline }, subline: { ...s.subline, font: fonts.body } } : {}),
      ...(data.grid ? { scrim: 0 } : {}),
      badge: { ...s.badge, src: data.client.badge ? `${base}/badge?v=${data.client.updated}` : null },
    };
  }, [data, base]);

  if (error)
    return (
      <div className="share-page">
        <div className="share-empty">{error}</div>
      </div>
    );
  if (!data || !spec)
    return (
      <div className="share-page">
        <div className="share-empty">
          <Orb size={20} />
        </div>
      </div>
    );
  const ready = data.posts.filter((p) => p.image);
  const approved = data.posts.filter((p) => p.approval?.status === "approved").length;
  const changes = data.posts.filter((p) => p.approval?.status === "changes").length;
  const allDone = ready.length > 0 && approved === ready.length;
  return (
    <div className="share-page">
      {allDone && (
        <div className="share-thanks text-finding ok" role="status">
          <span className="text-finding-icon" aria-hidden>
            <Check size={15} />
          </span>
          <span className="text-finding-text">
            <b>Everything is approved. Thank you!</b>
            <span>The team schedules the posts now; you will see them on {data.client.name}'s page on their days.</span>
          </span>
        </div>
      )}
      {!allDone && approved + changes > 0 && approved + changes === ready.length && (
        <div className="share-thanks text-finding warn" role="status">
          <span className="text-finding-icon" aria-hidden>
            <MessageSquare size={15} />
          </span>
          <span className="text-finding-text">
            <b>Thank you! {changes} post{changes > 1 ? "s" : ""} will be changed.</b>
            <span>The team makes the changes and sends you this link again.</span>
          </span>
        </div>
      )}
      <header className="share-head">
        {data.client.logo ? <img className="share-logo" src={`${base}/logo?v=${data.client.updated}`} alt="" /> : null}
        <div>
          <h1>
            {data.client.name} · {monthLabel(data.month)}
          </h1>
          <p>
            {ready.length} posts ready · {approved} approved. Approve each post, or ask for a change and say what you would like.
          </p>
        </div>
      </header>
      <section className={`share-who ${needName && !name.trim() ? "need" : ""}`} aria-label="Who is reviewing">
        {name.trim() && !editingName ? (
          <p>
            Reviewing as <b dir="auto">{name.trim()}</b> ·{" "}
            <button type="button" className="text-button" onClick={() => setEditingName(true)}>
              change
            </button>
          </p>
        ) : (
          <label>
            <span>{needName && !name.trim() ? "Write your name first, so the team knows who answered" : "Your name, once: it goes with every answer so the team knows who approved or asked"}</span>
            <input
              ref={nameRef}
              type="text"
              dir="auto"
              autoComplete="name"
              placeholder="e.g. Nada"
              value={name}
              onChange={(e) => rename(e.target.value)}
              onBlur={() => name.trim() && setEditingName(false)}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && setEditingName(false)}
            />
          </label>
        )}
      </section>
      <section className="share-feed" aria-label="The month's feed">
        <h2>The feed</h2>
        <p>How the profile will look at the end of the month. Tap a post to approve it or ask for a change.</p>
        <div className="share-feed-grid">
          {(data.order ?? data.posts.map((p) => p.index)).map((i) => {
            const p = data.posts.find((x) => x.index === i);
            if (!p) return null;
            const src = p.image ? `${base}/image/${p.index}?v=${p.image}&w=1080` : null;
            return (
              <a key={i} href={`#post-${i}`} className={`share-feed-cell ${p.approval?.status ?? ""}`} title={`Post ${i}`}>
                {src ? (
                  p.overlay && spec.template !== "none" ? (
                    <OverlayPreview src={src} spec={spec} text={{ headline: p.headline, subline: p.subline }} logoSrc={data.client.logo ? `${base}/logo?v=${data.client.updated}` : null} patch={p.ov ?? undefined} faces={p.faces} width={420} />
                  ) : (
                    <img src={src} alt="" loading="lazy" />
                  )
                ) : (
                  <span className="share-pending">Being prepared</span>
                )}
                {p.approval && <span className={`share-feed-mark ${p.approval.status}`}>{p.approval.status === "approved" ? <Check size={13} /> : <MessageSquare size={13} />}</span>}
              </a>
            );
          })}
        </div>
      </section>
      <main className="share-grid">
        {data.posts.map((p) => (
          <SharedCard
            key={p.index}
            post={p}
            base={base}
            spec={spec}
            logo={data.client.logo ? `${base}/logo?v=${data.client.updated}` : null}
            name={name}
            onNeedName={askName}
            onAnswered={(approval) =>
              setData((d) => (d ? { ...d, posts: d.posts.map((x) => (x.index === p.index ? { ...x, approval } : x)) } : d))
            }
          />
        ))}
      </main>
      <footer className="share-foot">
        Made with <LevelLogo className="share-level" />
      </footer>
    </div>
  );
}

function SharedCard({
  post,
  base,
  spec,
  logo,
  name,
  onNeedName,
  onAnswered,
}: {
  post: SharedPost;
  base: string;
  spec: ReturnType<typeof resolveOverlay>;
  logo: string | null;
  /** The reviewer's name, so the team knows who answered. */
  name: string;
  /** No name yet: the page asks for it (once) before the answer goes. */
  onNeedName: () => void;
  onAnswered: (a: Approval) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState(post.approval?.note ?? "");
  const reasons = ["Change the words", "Change the picture", "The colours", "The product looks wrong", "Another date"];
  const toggleReason = (r: string) => setNote((n) => (n.includes(r) ? n.replace(new RegExp(`${r}\\.?\\s*`), "").trim() : `${r}. ${n}`.trim()));
  const [sending, setSending] = useState(false);
  const src = post.image ? `${base}/image/${post.index}?v=${post.image}&w=1440` : null;

  async function answer(status: Approval["status"]) {
    if (!name.trim()) {
      onNeedName();
      return;
    }
    setSending(true);
    try {
      const r = await fetch(`${base}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: post.index, status, note: status === "changes" ? note : undefined, by: name.trim() }),
      });
      const d = (await r.json()) as { approval?: Approval; error?: string };
      if (!r.ok || !d.approval) throw new Error(d.error || "Could not send.");
      onAnswered(d.approval);
      setAsking(false);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <article id={`post-${post.index}`} className={`design-card share-card ${post.approval?.status === "approved" ? "text-ok" : post.approval?.status === "changes" ? "text-warn" : ""}`}>
      <div className="design-card-picture share-media">
        {src ? (
          post.overlay && spec.template !== "none" ? (
            <OverlayPreview src={src} spec={spec} text={{ headline: post.headline, subline: post.subline }} logoSrc={logo} patch={post.ov ?? undefined} faces={post.faces} width={720} />
          ) : (
            <img src={src} alt="" loading="lazy" />
          )
        ) : (
          <span className="design-card-empty">
            <Orb size={28} status={null} /> Being prepared
          </span>
        )}
        <span className="design-card-badges">
          <span className="design-card-index">{String(post.index).padStart(2, "0")}</span>
          {post.date && <span className="design-card-date">{shortDate(post.date)}</span>}
          {post.group && (
            <span className="design-card-type">
              {post.group.kind === "carousel" ? "Carousel" : "Series"} {post.group.slide}/{post.group.of}
            </span>
          )}
        </span>
        {post.approval && (
          <span className={`design-card-mark ${post.approval.status === "approved" ? "ok" : "warn"}`} title={post.approval.status === "approved" ? "Approved" : "A change was asked"}>
            {post.approval.status === "approved" ? <Check size={14} /> : <MessageSquare size={14} />}
          </span>
        )}
      </div>
      <div className="design-card-body">
        {(post.headline || post.subline) && (
          <div className="design-card-title">
            <strong dir="auto">{post.headline || post.subline}</strong>
            {post.headline && post.subline && (
              <small dir="auto" className="design-card-subline">
                {post.subline}
              </small>
            )}
          </div>
        )}
        <div className="design-card-caption">
          <span className="design-card-label">
            <MessageSquare size={12} /> Caption
          </span>
          <p className="share-caption" dir="auto">
            {post.caption}
          </p>
          <p className="share-tags" dir="auto">
            {post.hashtags}
          </p>
        </div>
        {asking ? (
          <div className="design-card-caption share-ask">
            <span className="design-card-label">
              <MessageSquare size={12} /> What would you like changed?
            </span>
            <div className="share-reasons" aria-label="What to change">
              {reasons.map((r) => (
                <button key={r} type="button" className={`share-reason ${note.includes(r) ? "on" : ""}`} onClick={() => toggleReason(r)}>
                  {r}
                </button>
              ))}
            </div>
            <textarea className="design-card-text" dir="auto" rows={3} value={note} placeholder="Tap a reason above, or write what you would like changed" onChange={(e) => setNote(e.target.value)} />
            <div className="design-card-actions">
              <button type="button" className="primary btn-pill" onClick={() => void answer("changes")} disabled={sending || !note.trim()}>
                {sending ? <Orb size={13} /> : <MessageSquare size={13} />} Send
              </button>
              <button type="button" className="secondary btn-pill" onClick={() => setAsking(false)} disabled={sending}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="design-card-actions">
            <button
              type="button"
              className={`${post.approval?.status === "approved" ? "primary" : "secondary"} btn-pill`}
              onClick={() => void answer("approved")}
              disabled={sending || !src}
            >
              {sending ? <Orb size={13} /> : <Check size={13} />} {post.approval?.status === "approved" ? "Approved" : "Approve"}
            </button>
            <button type="button" className={`${post.approval?.status === "changes" ? "primary warn" : "secondary"} btn-pill`} onClick={() => setAsking(true)} disabled={sending || !src}>
              <MessageSquare size={13} /> {post.approval?.status === "changes" ? "Change asked" : "Ask for a change"}
            </button>
          </div>
        )}
        {post.approval?.status === "changes" && post.approval.note && !asking && (
          <div className="text-finding warn">
            <span className="text-finding-icon" aria-hidden>
              <MessageSquare size={15} />
            </span>
            <span className="text-finding-text">
              <b>{post.approval.by ? `${post.approval.by} asked for a change` : "You asked for a change"}</b>
              <span dir="auto">“{post.approval.note}”</span>
            </span>
          </div>
        )}
        {post.approval?.status === "approved" && !asking && (
          <div className="text-finding ok">
            <span className="text-finding-icon" aria-hidden>
              <Check size={15} />
            </span>
            <span className="text-finding-text">
              <b>{post.approval.by ? `Approved by ${post.approval.by}` : "Approved"}</b>
              <span>Thank you. This post goes out on its day.</span>
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
