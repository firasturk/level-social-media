import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, MessageSquare } from "lucide-react";
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
  image: number | null;
  approval: Approval | null;
}

interface Shared {
  client: { name: string; overlay: Partial<OverlaySpec> | null; logo: boolean; badge: boolean; fonts: { id: string; name: string }[]; updated: number };
  month: string;
  posts: SharedPost[];
}

/** The client's view of a month: every post as it will go out, to approve or to send back. */
export default function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState("");
  const base = `/api/share/${token}`;

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
    return { ...s, badge: { ...s.badge, src: data.client.badge ? `${base}/badge?v=${data.client.updated}` : null } };
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
          <LoaderCircle className="spinning" size={20} />
        </div>
      </div>
    );
  const ready = data.posts.filter((p) => p.image);
  const approved = data.posts.filter((p) => p.approval?.status === "approved").length;
  return (
    <div className="share-page">
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
      <main className="share-grid">
        {data.posts.map((p) => (
          <SharedCard
            key={p.index}
            post={p}
            base={base}
            spec={spec}
            logo={data.client.logo ? `${base}/logo?v=${data.client.updated}` : null}
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
  onAnswered,
}: {
  post: SharedPost;
  base: string;
  spec: ReturnType<typeof resolveOverlay>;
  logo: string | null;
  onAnswered: (a: Approval) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState(post.approval?.note ?? "");
  const [sending, setSending] = useState(false);
  const src = post.image ? `${base}/image/${post.index}?v=${post.image}` : null;

  async function answer(status: Approval["status"]) {
    setSending(true);
    try {
      const r = await fetch(`${base}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: post.index, status, note: status === "changes" ? note : undefined }),
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
    <article className={`share-card ${post.approval?.status ?? ""}`}>
      <div className="share-media">
        {src ? (
          post.overlay && spec.template !== "none" ? (
            <OverlayPreview src={src} spec={spec} text={{ headline: post.headline, subline: post.subline }} logoSrc={logo} patch={post.ov ?? undefined} width={720} />
          ) : (
            <img src={src} alt="" loading="lazy" />
          )
        ) : (
          <div className="share-pending">Being prepared</div>
        )}
        <span className="share-index">{String(post.index).padStart(2, "0")}</span>
      </div>
      <div className="share-body">
        {post.date && <span className="share-date">{shortDate(post.date)}</span>}
        <p className="share-caption" dir="auto">
          {post.caption}
        </p>
        <p className="share-tags" dir="auto">
          {post.hashtags}
        </p>
        {asking ? (
          <div className="share-ask">
            <textarea dir="auto" rows={3} value={note} placeholder="What would you like changed?" onChange={(e) => setNote(e.target.value)} />
            <div className="share-actions">
              <button type="button" className="secondary" onClick={() => setAsking(false)} disabled={sending}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void answer("changes")} disabled={sending || !note.trim()}>
                Send
              </button>
            </div>
          </div>
        ) : (
          <div className="share-actions">
            <button
              type="button"
              className={post.approval?.status === "approved" ? "primary" : "secondary"}
              onClick={() => void answer("approved")}
              disabled={sending || !src}
            >
              <Check size={15} /> {post.approval?.status === "approved" ? "Approved" : "Approve"}
            </button>
            <button type="button" className={post.approval?.status === "changes" ? "primary warn" : "secondary"} onClick={() => setAsking(true)} disabled={sending || !src}>
              <MessageSquare size={15} /> {post.approval?.status === "changes" ? "Change asked" : "Ask for a change"}
            </button>
          </div>
        )}
        {post.approval?.status === "changes" && post.approval.note && !asking && (
          <p className="share-note" dir="auto">
            “{post.approval.note}”
          </p>
        )}
      </div>
    </article>
  );
}
