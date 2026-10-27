import { useEffect, useMemo, useState, useRef } from "react";
import { Check, ChevronLeft, ChevronRight, GalleryHorizontalEnd, MessageSquare, Play } from "lucide-react";
import { Orb } from "@/components/Orb";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import { applyTheme } from "@/theme";
import { loadFont } from "@/lib/overlay";
import LevelLogo from "@/components/LevelLogo";
import OverlayPreview from "@/studio/OverlayPreview";
import { resolveOverlay, type OverlaySpec, type PostOverlayPatch } from "@shared/overlay";
import { monthLabel } from "@shared/posts";
import { shortDate } from "@shared/occasions";
import { carouselEntries, carouselStatus } from "@shared/carousel";
import "./share-carousel.css";
import type { ReviewAnswer as Approval, ReviewVersion } from "@shared/config";

/** The clip the team selected for the client: served through this link, never the provider's URL. */
interface SharedVideo {
  id: string;
  url: string;
  poster: string | null;
  duration: number | null;
  version: ReviewVersion;
}

interface SharedPost {
  /** The version the client reviews when it is a clip. */
  video: SharedVideo | null;
  /** What is shown on this post right now (the clip, or the picture by its stamp): every answer is pinned to it. */
  version: ReviewVersion | null;
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
  group?: { id: string; kind: "carousel" | "series"; slide: number; of: number } | null;
  image: number | null;
  approval: Approval | null;
}

interface Shared {
  client: { name: string; overlay: Partial<OverlaySpec> | null; logo: boolean; badge: boolean; fonts: { id: string; name: string }[]; updated: number; instagram?: { username: string; followers: number | null } | null };
  month: string;
  /** A grid month: no dark fade behind the words. */
  grid?: boolean;
  /** The posts in feed order (the newest first, or by grid tile). */
  order?: number[];
  monthFonts?: { headline: string; body: string } | null;
  posts: SharedPost[];
}

/** A follower count the way Instagram shows it: 84,429 → 84.4K, 1,250,000 → 1.3M. */
function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en");
}

/** The client's view of a month: every post as it will go out, to approve or to send back. */
export default function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState("");
  const base = `/api/share/${token}`;
  // This device's reviewer id: the page shows only this reviewer's own answers, and an answer sent again replaces only theirs.
  const rid = useMemo(() => {
    try {
      const had = localStorage.getItem("lsm-share-rid");
      if (had) return had;
      const fresh = crypto.randomUUID();
      localStorage.setItem("lsm-share-rid", fresh);
      return fresh;
    } catch {
      return `tab-${Math.random().toString(36).slice(2, 14)}`;
    }
  }, []);
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
    fetch(`${base}?rid=${encodeURIComponent(rid)}`)
      .then(async (r) => {
        const d = (await r.json()) as Shared & { error?: string };
        if (!r.ok) throw new Error(d.error || "This link is not valid.");
        for (const f of d.client.fonts) void loadFont(f.name, `${base}/font/${f.id}`);
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
  }, [base, rid]);

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
  // A carousel is one post here, as on Instagram: ready when every slide is, answered as one.
  const cards = carouselEntries(data.posts).map((e) => e.slides ?? [e.post]);
  const ready = cards.filter((list) => list.every((p) => p.image));
  const statusOf = (list: SharedPost[]) => carouselStatus(list.map((p) => p.approval?.status));
  const approved = cards.filter((list) => statusOf(list) === "approved").length;
  const changes = cards.filter((list) => statusOf(list) === "changes").length;
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
        <div className="share-phone">
          <div className="share-phone-top">
            <b dir="auto">{data.client.instagram?.username || data.client.name.toLowerCase().replace(/\s+/g, ".")}</b>
            <span aria-hidden>+ ≡</span>
          </div>
          <div className="share-profile">
            <span className="share-avatar">{data.client.logo ? <img src={`${base}/logo?v=${data.client.updated}`} alt="" /> : data.client.name.slice(0, 1)}</span>
            <dl className="share-stats">
              <div>
                <dt>{ready.length}</dt>
                <dd>posts</dd>
              </div>
              <div>
                <dt>{data.client.instagram?.followers ? compactCount(data.client.instagram.followers) : "—"}</dt>
                <dd>followers</dd>
              </div>
              <div>
                <dt>—</dt>
                <dd>following</dd>
              </div>
            </dl>
          </div>
          <div className="share-bio">
            <b dir="auto">{data.client.name}</b>
            <span>{monthLabel(data.month)} · content calendar</span>
          </div>
          <div className="share-profile-buttons" aria-hidden>
            <span className="follow">Follow</span>
            <span>Message</span>
          </div>
          <div className="share-grid-tab" aria-hidden>
            <span />
          </div>
        <div className="share-feed-grid">
          {carouselEntries((data.order ?? data.posts.map((p) => p.index)).map((i) => data.posts.find((x) => x.index === i)).filter((x): x is SharedPost => !!x)).map(({ post: p, slides }) => {
            const i = p.index;
            const mark = slides ? carouselStatus(slides.map((x) => x.approval?.status)) : (p.approval?.status ?? null);
            const src = p.image ? `${base}/image/${p.index}?v=${p.image}&w=1080` : null;
            return (
              <a key={i} href={`#post-${i}`} className={`share-feed-cell ${mark ?? ""}`} title={`Post ${i}`}>
                {p.video ? (
                  <>
                    <img src={p.video.poster ?? src ?? undefined} alt="" loading="lazy" />
                    <span className="share-play-mark" aria-hidden>
                      <Play size={14} />
                    </span>
                  </>
                ) : src ? (
                  p.overlay && spec.template !== "none" ? (
                    <OverlayPreview src={src} spec={spec} text={{ headline: p.headline, subline: p.subline }} logoSrc={data.client.logo ? `${base}/logo?v=${data.client.updated}` : null} patch={p.ov ?? undefined} faces={p.faces} width={420} />
                  ) : (
                    <img src={src} alt="" loading="lazy" />
                  )
                ) : (
                  <span className="share-pending">Being prepared</span>
                )}
                {slides && (
                  <span className="share-feed-carousel" aria-label="Carousel">
                    <GalleryHorizontalEnd size={14} />
                  </span>
                )}
                {mark && <span className={`share-feed-mark ${mark}`}>{mark === "approved" ? <Check size={13} /> : <MessageSquare size={13} />}</span>}
              </a>
            );
          })}
        </div>
        </div>
      </section>
      <main className="share-grid">
        {carouselEntries(data.posts).map(({ post: p, slides }) => (
          <SharedCard
            key={p.index}
            post={p}
            slides={slides}
            base={base}
            spec={spec}
            logo={data.client.logo ? `${base}/logo?v=${data.client.updated}` : null}
            name={name}
            rid={rid}
            onNeedName={askName}
            onAnswered={(index, approval) =>
              setData((d) => (d ? { ...d, posts: d.posts.map((x) => (x.index === index ? { ...x, approval } : x)) } : d))
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

/** One slide's or one post's picture or clip, as it will go out. */
function SharedMedia({ post, base, spec, logo }: { post: SharedPost; base: string; spec: ReturnType<typeof resolveOverlay>; logo: string | null }) {
  const src = post.image ? `${base}/image/${post.index}?v=${post.image}&w=1440` : null;
  if (post.video) {
    // The clip plays by itself while on screen, muted and inline on iPhone too, with the browser's controls and a sound button; the words are already in it (or not): nothing is drawn over it.
    return <AutoplayVideo key={post.video.id} src={post.video.url} poster={post.video.poster ?? src} mode="player" label={`Post ${post.index} video`} />;
  }
  if (src) return post.overlay && spec.template !== "none" ? <OverlayPreview src={src} spec={spec} text={{ headline: post.headline, subline: post.subline }} logoSrc={logo} patch={post.ov ?? undefined} faces={post.faces} width={720} /> : <img src={src} alt="" loading="lazy" />;
  return (
    <span className="design-card-empty">
      <Orb size={28} status={null} /> Being prepared
    </span>
  );
}

/**
 * One post on the client's link. A carousel (27 Oct) is one post as on Instagram: its slides swipe
 * (or step with the arrows and dots), one caption under them, Approve answers every slide, and a
 * change is asked on the slide on screen.
 */
function SharedCard({
  post,
  slides,
  base,
  spec,
  logo,
  name,
  rid,
  onNeedName,
  onAnswered,
}: {
  post: SharedPost;
  /** A carousel's slides in order (the first is `post`). */
  slides?: SharedPost[];
  base: string;
  spec: ReturnType<typeof resolveOverlay>;
  logo: string | null;
  /** The reviewer's name, so the team knows who answered. */
  name: string;
  rid: string;
  /** No name yet: the page asks for it (once) before the answer goes. */
  onNeedName: () => void;
  onAnswered: (index: number, a: Approval) => void;
}) {
  const list = slides ?? [post];
  const [at, setAt] = useState(0);
  const cur = list[Math.min(at, list.length - 1)];
  const track = useRef<HTMLDivElement>(null);
  const carousel = list.length > 1 || !!slides;
  const status = carousel ? carouselStatus(list.map((x) => x.approval?.status)) : post.approval?.status ?? null;
  const asked = list.filter((x) => x.approval?.status === "changes" && x.approval.note);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState(cur.approval?.note ?? "");
  const reasons = ["Change the words", "Change the picture", "The colours", "The product looks wrong", "Another date"];
  const toggleReason = (r: string) => setNote((n) => (n.includes(r) ? n.replace(new RegExp(`${r}\\.?\\s*`), "").trim() : `${r}. ${n}`.trim()));
  const [sending, setSending] = useState(false);
  const ready = list.every((x) => x.image || x.video);

  function go(i: number) {
    const next = Math.max(0, Math.min(list.length - 1, i));
    setAt(next);
    const el = track.current;
    if (el) el.scrollTo({ left: next * el.clientWidth * (getComputedStyle(el).direction === "rtl" ? -1 : 1), behavior: "smooth" });
  }

  async function send(p: SharedPost, status: Approval["status"]) {
    const r = await fetch(`${base}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The answer is pinned to the exact version on screen: the clip by id, or the picture by its stamp.
      body: JSON.stringify({ index: p.index, status, note: status === "changes" ? note : undefined, by: name.trim(), rid, version: p.version ?? undefined }),
    });
    const d = (await r.json()) as { approval?: Approval; error?: string };
    if (!r.ok || !d.approval) throw new Error(d.error || "Could not send.");
    onAnswered(p.index, d.approval);
  }

  async function answer(status: Approval["status"]) {
    if (!name.trim()) {
      onNeedName();
      return;
    }
    setSending(true);
    try {
      // Approving a carousel approves every slide; a change is asked on the slide on screen.
      for (const p of status === "approved" ? list : [cur]) await send(p, status);
      setAsking(false);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <article id={`post-${post.index}`} className={`design-card share-card ${status === "approved" ? "text-ok" : status === "changes" ? "text-warn" : ""} ${carousel ? "share-carousel" : ""}`}>
      <div className="design-card-picture share-media">
        {carousel ? (
          <div
            ref={track}
            className="share-slides"
            onScroll={(e) => {
              const el = e.currentTarget;
              const i = Math.round(Math.abs(el.scrollLeft) / Math.max(1, el.clientWidth));
              if (i !== at) setAt(i);
            }}
          >
            {list.map((x) => (
              <div key={x.index} id={x.index !== post.index ? `post-${x.index}` : undefined} className="share-slide">
                <SharedMedia post={x} base={base} spec={spec} logo={logo} />
              </div>
            ))}
          </div>
        ) : (
          <SharedMedia post={post} base={base} spec={spec} logo={logo} />
        )}
        {carousel && (
          <>
            {at > 0 && (
              <button type="button" className="share-arrow prev" aria-label="Previous" onClick={() => go(at - 1)}>
                <ChevronLeft size={18} />
              </button>
            )}
            {at < list.length - 1 && (
              <button type="button" className="share-arrow next" aria-label="Next" onClick={() => go(at + 1)}>
                <ChevronRight size={18} />
              </button>
            )}
            <span className="share-count">
              {at + 1}/{list.length}
            </span>
          </>
        )}
        <span className="design-card-badges">
          <span className="design-card-index">{String(post.index).padStart(2, "0")}</span>
          {post.date && <span className="design-card-date">{shortDate(post.date)}</span>}
          {post.group?.kind === "series" && (
            <span className="design-card-type">
              Series {post.group.slide}/{post.group.of}
            </span>
          )}
          {carousel && (
            <span className="design-card-type">
              <GalleryHorizontalEnd size={12} /> Carousel
            </span>
          )}
        </span>
        {status && (
          <span className={`design-card-mark ${status === "approved" ? "ok" : "warn"}`} title={status === "approved" ? "Approved" : "A change was asked"}>
            {status === "approved" ? <Check size={14} /> : <MessageSquare size={14} />}
          </span>
        )}
      </div>
      {carousel && (
        <div className="share-dots" aria-label="Slides">
          {list.map((x, i) => (
            <button key={x.index} type="button" className={`share-dot ${i === at ? "on" : ""} ${x.approval?.status ?? ""}`} aria-label={`Slide ${i + 1}`} aria-current={i === at} onClick={() => go(i)} />
          ))}
        </div>
      )}
      <div className="design-card-body">
        {cur.version && (
          <small className="share-version">
            {carousel ? `Slide ${at + 1}: ` : ""}Version currently shown: <b>{cur.version.label ?? (cur.version.kind === "video" ? "Video" : "Picture")}</b>
            {cur.approval?.version && cur.approval.version.id !== cur.version.id ? <> · you answered on {cur.approval.version.label ?? "an earlier version"}; this one is newer.</> : null}
          </small>
        )}
        {(cur.headline || cur.subline) && (
          <div className="design-card-title">
            <strong dir="auto">{cur.headline || cur.subline}</strong>
            {cur.headline && cur.subline && (
              <small dir="auto" className="design-card-subline">
                {cur.subline}
              </small>
            )}
          </div>
        )}
        <div className="design-card-caption">
          <span className="design-card-label">
            <MessageSquare size={12} /> Caption
          </span>
          {/* A carousel goes out with one caption: its first slide's. */}
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
              <MessageSquare size={12} /> {carousel ? `What would you like changed on slide ${at + 1}?` : "What would you like changed?"}
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
            <button type="button" className={`${status === "approved" ? "primary" : "secondary"} btn-pill`} onClick={() => void answer("approved")} disabled={sending || !ready}>
              {sending ? <Orb size={13} /> : <Check size={13} />} {status === "approved" ? "Approved" : carousel ? "Approve the carousel" : "Approve"}
            </button>
            <button
              type="button"
              className={`${cur.approval?.status === "changes" ? "primary warn" : "secondary"} btn-pill`}
              onClick={() => {
                setNote(cur.approval?.note ?? "");
                setAsking(true);
              }}
              disabled={sending || !(cur.image || cur.video)}
            >
              <MessageSquare size={13} /> {cur.approval?.status === "changes" ? "Change asked" : carousel ? "Ask for a change on this slide" : "Ask for a change"}
            </button>
          </div>
        )}
        {asked.length > 0 && !asking && (
          <div className="text-finding warn">
            <span className="text-finding-icon" aria-hidden>
              <MessageSquare size={15} />
            </span>
            <span className="text-finding-text">
              <b>You asked for a change</b>
              {asked.map((x) => (
                <span key={x.index} dir="auto">
                  {carousel ? `Slide ${list.indexOf(x) + 1}: ` : ""}“{x.approval!.note}”
                </span>
              ))}
            </span>
          </div>
        )}
        {status === "approved" && !asking && (
          <div className="text-finding ok">
            <span className="text-finding-icon" aria-hidden>
              <Check size={15} />
            </span>
            <span className="text-finding-text">
              <b>Approved</b>
              <span>Thank you. This post goes out on its day.</span>
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
