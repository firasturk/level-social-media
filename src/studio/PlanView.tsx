import { useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  ImagePlus,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import type { Client, Source, Task } from "@shared/types";
import {
  POST_TYPE_INFO,
  POST_TYPES,
  monthLabel,
  type Post,
  type PostType,
  type Format,
} from "@shared/posts";
import { STATUS_LABEL } from "./constants";

/** The month of a client: its products, the plan of posts and their images. */
export default function PlanView({
  client,
  month,
  onMonth,
  plan,
  postCount,
  format,
  tasks,
  sources,
  running,
  busy,
  exporting,
  sourceUrl,
  outputUrl,
  onUploadProducts,
  onRemoveProduct,
  onGenerateIdeas,
  onSavePlan,
  onGeneratePosts,
  onOpen,
  onExport,
  onDeletePlan,
}: {
  client: Client;
  month: string;
  onMonth: (m: string) => void;
  plan: Post[];
  postCount: number;
  format: Format;
  tasks: Task[];
  sources: Source[];
  running: boolean;
  /** An action is in flight (ideas, upload, generate). */
  busy: string;
  exporting: boolean;
  sourceUrl: (id: string) => string;
  outputUrl: (t: Task) => string;
  onUploadProducts: (files: File[]) => void;
  onRemoveProduct: (id: string) => void;
  onGenerateIdeas: (notes: string) => void;
  onSavePlan: (plan: Post[]) => void;
  onGeneratePosts: (indexes?: number[], regenerate?: boolean) => void;
  onOpen: (t: Task) => void;
  onExport: () => void;
  onDeletePlan: () => void;
}) {
  const products = sources.filter((s) => (s.kind ?? "product") === "product");
  const fileInput = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<Post[]>(plan);
  const [dragging, setDragging] = useState(false);
  useEffect(() => setDraft(plan), [plan]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(plan);
  const taskOf = (index: number) => tasks.find((t) => t.post === index) ?? null;
  const generated = plan.filter((p) => !!taskOf(p.index)?.output).length;
  const pending = plan.filter((p) => {
    const t = taskOf(p.index);
    return !t || t.status === "failed";
  }).length;

  function patch(index: number, p: Partial<Post>) {
    setDraft((d) => d.map((x) => (x.index === index ? { ...x, ...p } : x)));
  }
  function removePost(index: number) {
    const next = draft.filter((x) => x.index !== index).map((x, i) => ({ ...x, index: i + 1 }));
    setDraft(next);
    onSavePlan(next);
  }
  function addPost() {
    const next: Post = {
      index: draft.length + 1,
      type: "lifestyle",
      title: `Post ${draft.length + 1}`,
      brief: "",
      caption: "",
      hashtags: "",
    };
    setDraft((d) => [...d, next]);
  }

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
      if (files.length) onUploadProducts(files);
    },
  };

  return (
    <section className={`plan ${dragging ? "dragging" : ""}`} {...dropProps}>
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onUploadProducts(files);
          e.target.value = "";
        }}
      />

      <div className="plan-toolbar">
        <div className="plan-month">
          <label htmlFor="month">Month</label>
          <input
            id="month"
            type="month"
            value={month}
            onChange={(e) => e.target.value && onMonth(e.target.value)}
          />
          <span className="plan-count">
            {plan.length ? `${generated}/${plan.length} posts generated` : `${postCount} posts planned`}
          </span>
        </div>
        <div className="plan-actions">
          <button
            className="secondary"
            onClick={() => fileInput.current?.click()}
            disabled={busy === "upload"}
          >
            {busy === "upload" ? <LoaderCircle className="spinning" size={15} /> : <ImagePlus size={15} />}
            Upload products
          </button>
          <button
            className="secondary"
            onClick={() => onGenerateIdeas(notes)}
            disabled={!!busy || running}
            title="The text model plans the month from the brand kit, the theme and the products"
          >
            {busy === "ideas" ? <LoaderCircle className="spinning" size={15} /> : <Lightbulb size={15} />}
            {plan.length ? "Regenerate ideas" : "Generate ideas"}
          </button>
          <button
            className="primary"
            onClick={() => onGeneratePosts()}
            disabled={!!busy || running || !plan.length || !pending}
            title={plan.length ? "" : "Generate ideas first"}
          >
            {running ? <LoaderCircle className="spinning" size={15} /> : <Wand2 size={15} />}
            {running ? "Generating…" : pending ? `Generate ${pending} posts` : "All posts generated"}
          </button>
          <button className="secondary" onClick={onExport} disabled={!generated || exporting}>
            {exporting ? <LoaderCircle className="spinning" size={15} /> : <Download size={15} />}
            Export
          </button>
          <button
            className="icon-button"
            onClick={onDeletePlan}
            title="Delete this month"
            aria-label="Delete this month"
            disabled={running}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="plan-notes">
        <input
          value={notes}
          placeholder="Notes for this month's ideas: occasions, launches, offers, what to push…"
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="products">
        <div className="products-head">
          <strong>Products</strong>
          <span>
            {products.length
              ? `${products.length} photo${products.length > 1 ? "s" : ""} · drop more anywhere`
              : "Drop the client's product photos here, or use Upload products"}
          </span>
        </div>
        {products.length > 0 && (
          <div className="products-strip">
            {products.map((s) => (
              <figure key={s.id} title={s.name}>
                <img src={sourceUrl(s.id)} alt={s.name} loading="lazy" />
                <figcaption>{displayName(s.name)}</figcaption>
                <button
                  type="button"
                  className="mood-remove"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => onRemoveProduct(s.id)}
                >
                  <X size={12} />
                </button>
              </figure>
            ))}
          </div>
        )}
      </div>

      {!plan.length ? (
        <div className="plan-empty">
          <img src="/guide/plan-empty.jpg" alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
          <h3>{monthLabel(month)} for {client.name}</h3>
          <ol>
            <li>
              <strong>Upload products</strong>
              <span>The product photos the posts can use (optional for lifestyle, tip and quote posts).</span>
            </li>
            <li>
              <strong>Generate ideas</strong>
              <span>{postCount} post ideas in the client's tone: type, visual brief, caption and hashtags. Edit anything.</span>
            </li>
            <li>
              <strong>Generate posts</strong>
              <span>One image per idea in the client's palette and theme. Review, revise, export with captions.</span>
            </li>
          </ol>
        </div>
      ) : (
        <>
          <div className="posts-head">
            <strong>Posts</strong>
            <span>Edit the brief and the caption of any post before generating; a post can be regenerated alone.</span>
            {dirty && (
              <span className="posts-save">
                <button className="primary" onClick={() => onSavePlan(draft)}>
                  Save changes
                </button>
                <button className="text-button" onClick={() => setDraft(plan)}>
                  Discard
                </button>
              </span>
            )}
          </div>
          <div className={`post-grid f-${format.replace(":", "x")}`}>
            {draft.map((p) => {
              const t = taskOf(p.index);
              const img = t?.output ? outputUrl(t) : null;
              const inFlight = !!t && (t.status === "queued" || t.status === "processing");
              const product = products.find(
                (s) => displayName(s.name).toLowerCase() === (p.product ?? "").toLowerCase(),
              );
              return (
                <article key={p.index} className={`post-card ${t?.status ?? "idea"}`}>
                  <div className="post-media" onClick={() => t?.output && onOpen(t)}>
                    {img ? (
                      <img src={img} alt={p.title} loading="lazy" />
                    ) : (
                      <img
                        className="post-placeholder"
                        src={`/guide/${p.type}.jpg`}
                        alt=""
                        onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                      />
                    )}
                    {inFlight && (
                      <span className="post-progress">
                        <LoaderCircle className="spinning" size={18} />
                        {t?.status === "processing" ? "Generating…" : "Queued"}
                      </span>
                    )}
                    {t?.status === "failed" && <span className="post-failed">Failed · {t.error}</span>}
                    {product && !img && (
                      <img className="post-product-chip" src={sourceUrl(product.id)} alt="" />
                    )}
                    <span className="post-index">{String(p.index).padStart(2, "0")}</span>
                    {t?.output && (
                      <span className="post-open">
                        <Eye size={14} /> Open
                      </span>
                    )}
                  </div>
                  <div className="post-fields">
                    <div className="post-row">
                      <select
                        value={p.type}
                        onChange={(e) => patch(p.index, { type: e.target.value as PostType })}
                        aria-label="Post type"
                      >
                        {POST_TYPES.map((k) => (
                          <option key={k} value={k}>
                            {POST_TYPE_INFO[k].label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={product ? displayName(product.name) : ""}
                        onChange={(e) => patch(p.index, { product: e.target.value || undefined })}
                        aria-label="Product"
                      >
                        <option value="">No product</option>
                        {products.map((s) => (
                          <option key={s.id} value={displayName(s.name)}>
                            {displayName(s.name)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      className="post-title"
                      value={p.title}
                      onChange={(e) => patch(p.index, { title: e.target.value })}
                      placeholder="Title"
                      aria-label="Title"
                    />
                    <textarea
                      rows={3}
                      value={p.brief}
                      onChange={(e) => patch(p.index, { brief: e.target.value })}
                      placeholder="What the photograph shows: place, subject, light, mood, where the product is."
                      aria-label="Visual brief"
                    />
                    <details>
                      <summary>Caption</summary>
                      <textarea
                        rows={4}
                        value={p.caption}
                        dir="auto"
                        onChange={(e) => patch(p.index, { caption: e.target.value })}
                        aria-label="Caption"
                      />
                      <input
                        value={p.hashtags}
                        onChange={(e) => patch(p.index, { hashtags: e.target.value })}
                        placeholder="#hashtags"
                        aria-label="Hashtags"
                      />
                    </details>
                    <div className="post-actions">
                      <span className={`pill ${t?.status ?? "idea"}`}>
                        {t ? STATUS_LABEL[t.status] ?? t.status : "Idea"}
                      </span>
                      <span className="spacer" />
                      {t?.output ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => onGeneratePosts([p.index], true)}
                          disabled={inFlight || running || dirty}
                          title={dirty ? "Save changes first" : "Generate this post again"}
                        >
                          <RefreshCw size={13} /> Regenerate
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => onGeneratePosts([p.index], t?.status === "failed")}
                          disabled={inFlight || running || dirty || !p.brief.trim()}
                          title={dirty ? "Save changes first" : "Generate only this post"}
                        >
                          <Sparkles size={13} /> Generate
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Remove post"
                        onClick={() => removePost(p.index)}
                        disabled={inFlight}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
            <button type="button" className="post-add" onClick={addPost}>
              <ImagePlus size={18} />
              Add a post
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Upload name without folder and extension: "Denim/cream-mug_01.jpg" -> "cream-mug_01". */
export function displayName(name: string): string {
  return (name.split("/").pop() ?? name).replace(/\.[^./]+$/, "");
}
