/**
 * AI tools: provider tools on the post's picture, in two groups (Higgsfield, Magnific), each tool
 * with its few options, the estimate ("About N credits · balance M" or "cost not known"), the
 * confirm, the run, the result before / after on the canvas, then "Use as the post's picture",
 * "Save as a product photo" or Download. Members see the list and "Admins only for now". The logic
 * is `usePhotoTools`; the Photo lab (Freepik's API, in dollars) stays its own panel.
 */
import { useEffect } from "react";
import { Check, Download, ImagePlus, Lock, Play, RefreshCw, Sparkles, TriangleAlert, Wallet } from "lucide-react";
import { Orb } from "@/components/Orb";
import VoiceInput from "@/components/VoiceInput";
import { TOOL_PROVIDER_LABELS, type ToolProvider } from "@shared/photo-tools";
import { PanelSwitch } from "./Presets";
import type { StudioCtx } from "../types";

const PROVIDERS: ToolProvider[] = ["higgsfield", "magnific"];
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function ToolsPanel({ ctx }: { ctx: StudioCtx }) {
  const t = ctx.tools;
  const { setView } = ctx;
  const job = t.job;
  const state = t.providerState;

  // A finished result goes on the canvas, before and after.
  useEffect(() => {
    if (job?.status === "done" && job.output) setView({ kind: "compare", before: job.input, after: job.output, beforeLabel: "Before", afterLabel: job.label });
  }, [job, setView]);

  const estimateLine = t.estimate ? (t.estimate.credits !== null ? `About ${t.estimate.credits} credits${t.estimate.balance !== null ? ` · balance ${t.estimate.balance}` : ""}` : "Cost not known") : null;
  const styleName = t.options.styleId ? t.styleNames[t.options.styleId] : "";

  return (
    <div className="ps-panel">
      <div className="ts-panel-head">
        <span>
          <Sparkles size={13} /> AI tools
        </span>
        {t.catalog && (
          <button type="button" className="ts-icon" onClick={() => void t.reloadCatalog()} disabled={t.loadingCatalog} title="Ask the providers again what they offer (kept an hour)" aria-label="Refresh the tools">
            <RefreshCw size={12} />
          </button>
        )}
      </div>
      <PanelSwitch ctx={ctx} current="tools" />
      <p className="ts-hint">Tools from the providers' own servers, paid in their credits. The estimate comes first, you confirm, the result is shown before it replaces anything.</p>
      {t.catalogError && (
        <p className="ts-hint warn">
          <TriangleAlert size={12} /> {t.catalogError}
        </p>
      )}
      {!t.catalog && !t.catalogError && (
        <p className="ts-hint">
          <Orb size={14} /> Reading the tools…
        </p>
      )}

      <div className="ps-seg" role="tablist" aria-label="Provider">
        {PROVIDERS.map((p) => (
          <button key={p} type="button" role="tab" aria-selected={t.provider === p} className={t.provider === p ? "on" : ""} onClick={() => t.pickProvider(p)}>
            {TOOL_PROVIDER_LABELS[p]}
            {t.catalog && t.lockedFor(p) && <Lock size={10} aria-label="Admins only for now" />}
          </button>
        ))}
      </div>
      {state && (
        <p className={`ts-hint ps-provider-line ${state.connected && !state.reason ? "ps-ok" : ""}`}>
          {state.connected ? (state.reason ? state.reason : `${TOOL_PROVIDER_LABELS[t.provider]} connected`) : state.reason}
          {state.balance !== null && (
            <>
              {" "}
              · <Wallet size={11} /> balance {state.balance} credits
            </>
          )}
        </p>
      )}
      {t.catalog && t.locked && state && (
        <div className="ps-locked" role="note">
          <Lock size={14} />
          <div>
            <b>{t.admin ? "Switched off" : "Admins only for now"}</b>
            <p>{state.reason || "These tools spend the providers' credits; an admin opens them for the team once approved."}</p>
          </div>
        </div>
      )}

      <span className="ts-group-title">Tool</span>
      <div className="ps-cards ps-tool-cards" role="radiogroup" aria-label="Tool">
        {t.tools.map((tool) => {
          const avail = state ? state.available[tool.id] : null;
          return (
            <button key={tool.id} type="button" role="radio" aria-checked={t.toolId === tool.id} className={`ps-card ${t.toolId === tool.id ? "on" : ""} ${avail === false ? "off" : ""}`} onClick={() => t.pickTool(tool.id)} title={avail === false ? `${TOOL_PROVIDER_LABELS[tool.provider]} does not list this tool today` : tool.hint}>
              <Sparkles size={16} />
              <span>
                <b>{tool.label}</b>
                <small>{tool.hint}</small>
              </span>
              <em>{avail === false ? "not listed" : avail === true ? "listed" : ""}</em>
            </button>
          );
        })}
      </div>

      {!t.locked && (
        <>
          {t.tool.options.length > 0 && <span className="ts-group-title">Options</span>}
          {t.tool.options.map((o) => {
            if (o.kind === "text")
              return (
                <label key={o.id} className="ps-field">
                  <span>
                    {o.label}
                    {o.required ? "" : ""}
                  </span>
                  <div className="ps-prompt">
                    <textarea rows={2} value={t.options[o.id] ?? ""} onChange={(e) => t.setOption(o.id, e.target.value)} placeholder={o.placeholder} aria-label={o.label} maxLength={2000} data-option={o.id} />
                    <VoiceInput compact onText={(words) => t.setOption(o.id, t.options[o.id] ? `${t.options[o.id]} ${words}` : words)} />
                  </div>
                </label>
              );
            const choices = t.choicesOf(o);
            return (
              <label key={o.id} className="ps-field">
                <span>{o.label}</span>
                <select value={t.options[o.id] ?? ""} onChange={(e) => t.setOption(o.id, e.target.value)} aria-label={o.label} data-option={o.id}>
                  <option value="">{o.required ? "Pick one" : choices.length ? "Provider's default" : "No list from the provider"}</option>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                  {t.options[o.id] && !choices.some((c) => c.id === t.options[o.id]) && <option value={t.options[o.id]}>{o.id === "styleId" && styleName ? styleName : t.options[o.id]}</option>}
                </select>
              </label>
            );
          })}
          {t.available === false && <p className="ts-hint warn">{TOOL_PROVIDER_LABELS[t.provider]} does not list this tool today; the run will be refused before anything is sent.</p>}
          {!ctx.task.output && <p className="ts-hint warn">This post has no picture yet; the tools need one. Make it first, or start from a preset.</p>}
          <div className="ps-row ps-wrap">
            <button type="button" className="ts-btn" disabled={!t.canAsk} onClick={() => void t.getEstimate()} title="Ask the provider what this would cost; nothing is made">
              {t.estimating ? <Orb size={14} status={null} /> : <Wallet size={14} />} Get the cost
            </button>
            <button type="button" className="ts-btn primary" disabled={!t.canAsk} onClick={() => void t.runTool()} title="The cost is shown and confirmed first; the result is shown before it replaces anything">
              {t.running ? <Orb size={14} status={null} /> : <Play size={14} />} Run {t.tool.label.toLowerCase()}
              {t.estimate?.credits != null ? ` · ${t.estimate.credits} credits` : ""}
            </button>
          </div>
          {estimateLine && <p className={`ts-hint ps-estimate ${t.estimate?.credits === null ? "warn" : ""}`}>{estimateLine}</p>}
          {t.missing.length > 0 && <p className="ts-hint">Needed first: {t.missing.join(", ").toLowerCase()}.</p>}
          <p className="ts-hint">The cost is asked of the provider and you confirm it; the same request then runs once. Nothing is sent before you confirm.</p>
        </>
      )}

      {job && (
        <div className="ps-result">
          <span className="ts-group-title">
            Result · {job.label}
            {job.estimate !== null ? ` · about ${job.estimate} credits` : " · cost not known"}
          </span>
          {(job.status === "running" || job.status === "queued") && (
            <p className="ts-hint">
              <Orb size={14} /> {TOOL_PROVIDER_LABELS[job.provider]} is working on it… a few seconds to a minute.
            </p>
          )}
          {job.status === "failed" && (
            <>
              <p className="ts-hint warn">{job.error || "The tool failed."}</p>
              {t.admin && (
                <>
                  <div className="ps-row ps-wrap">
                    <button type="button" className="ts-btn" disabled={t.checking === job.id} onClick={() => void t.checkAgain(job)} title="Ask the provider whether this run finished after all: a status read, free. Nothing is run again.">
                      {t.checking === job.id ? <Orb size={14} /> : <RefreshCw size={14} />} Check again
                    </button>
                  </div>
                  <p className="ts-hint">If {TOOL_PROVIDER_LABELS[job.provider]} charged for this run, it may have finished there. Check again asks it (free; nothing is run again) and collects the result if it is ready.</p>
                </>
              )}
            </>
          )}
          {job.status === "done" && job.output && (
            <>
              <p className="ts-hint">
                Before and after are on the canvas: drag the slider.{job.reported !== null ? ` ${job.reported} credits reported.` : ""}
              </p>
              <div className="ps-row ps-wrap">
                {t.canUseAsPicture && (
                  <button type="button" className="ts-btn primary" disabled={!!t.using} onClick={() => void t.applyResult("picture")}>
                    {t.using === "picture" ? <Orb size={14} /> : <Check size={14} />} Use as the post's picture
                  </button>
                )}
                {t.admin && (
                  <button type="button" className="ts-btn" disabled={!!t.using} onClick={() => void t.applyResult("product")}>
                    {t.using === "product" ? <Orb size={14} /> : <ImagePlus size={14} />} Save as a product photo
                  </button>
                )}
                <a className="ts-btn" href={job.output} download={`ai-tools-${job.tool}.png`}>
                  <Download size={14} /> Download
                </a>
              </div>
            </>
          )}
        </div>
      )}

      {t.jobs.length > 0 && (
        <details className="ps-details" open={!job}>
          <summary>Earlier results ({t.jobs.length})</summary>
          <div className="ps-thumbs">
            {t.jobs.map((j) => (
              <button key={j.id} type="button" className={`ps-thumb ${job?.id === j.id ? "on" : ""} ${j.status}`} onClick={() => t.setJob(j)} title={`${j.label} · ${when(j.created)} · ${j.status}`}>
                <img src={j.output ?? j.input} alt={j.label} loading="lazy" />
                <span>
                  {j.label}
                  {j.status === "failed" ? " · failed" : j.status !== "done" ? " · working" : ""}
                </span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
