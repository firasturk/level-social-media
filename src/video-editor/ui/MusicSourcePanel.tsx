/**
 * The music source (phase 3) at the top of the Music tab: the music library (MusicLibrary.tsx: the
 * studio's catalog and the client's own tracks, docs/music-library.md) as the place to pick a
 * track, and for a library or catalog track the rights kept with the project: the licence and its
 * link, the author, the credit line the post's caption must carry for CC BY tracks (with a copy
 * button), and what is known about Content ID. Picking a track is an edit of the cut;
 * browsing and previewing are open to everyone. Importing a client's track stays in the library
 * (with the licence form). The whole team does all of this (24 Oct).
 */
import { useState } from "react";
import { Check, Copy, ExternalLink, Library } from "lucide-react";
import { MUSIC_MOODS } from "@shared/music";
import type { MusicRights } from "@shared/video-project";
import { templateOf } from "@shared/video-templates";
import MusicLibrary from "./MusicLibrary";
import type { PanelCtx } from "./Panels";
import "./video-looks.css";

function CopyCredit({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ts-mini"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined);
      }}
      title="Copy the credit line"
    >
      {done ? <Check size={12} /> : <Copy size={12} />} {done ? "Copied" : "Copy the credit"}
    </button>
  );
}

/** What the track's licence asks of the published video. */
export function RightsBlock({ name, rights }: { name: string; rights: MusicRights }) {
  const l = rights.licence;
  return (
    <div className="vl-rights" data-testid="music-rights">
      <b>{name}</b>
      <span>
        {l.name}
        {l.version && !l.name.includes(l.version) ? ` ${l.version}` : ""}
        {l.url && (
          <>
            {" · "}
            <a href={l.url} target="_blank" rel="noreferrer">
              licence <ExternalLink size={10} />
            </a>
          </>
        )}
        {rights.author ? ` · ${rights.author}` : ""}
        {rights.sourcePage && (
          <>
            {" · "}
            <a href={rights.sourcePage} target="_blank" rel="noreferrer">
              source <ExternalLink size={10} />
            </a>
          </>
        )}
      </span>
      {rights.test && <span className="warn">Generated test audio: for trying the editor only, never for a client's video.</span>}
      {rights.credit && (
        <>
          <span className={rights.attributionRequired ? "warn" : ""}>{rights.attributionRequired ? "Required: put this credit in the post's caption (and the description wherever the video is published)." : "No credit required; this courtesy line is good practice."}</span>
          <pre>{rights.credit}</pre>
          <span>
            <CopyCredit text={rights.credit} />
          </span>
        </>
      )}
      {rights.contentId.status !== "not_registered" && (
        <span className={rights.contentId.status === "registered" ? "warn" : ""}>
          {rights.contentId.status === "registered" ? "Content ID: registered. A claim can still appear on YouTube or Facebook; the credit in the description is the answer. " : "Content ID: unknown. "}
          {rights.contentId.note}
          {rights.contentId.url && (
            <>
              {" "}
              <a href={rights.contentId.url} target="_blank" rel="noreferrer">
                More <ExternalLink size={10} />
              </a>
            </>
          )}
        </span>
      )}
    </div>
  );
}

export default function MusicSourcePanel({ ctx }: { ctx: PanelCtx }) {
  const m = ctx.project.music;
  const src = m?.source ?? null;
  const fromLibrary = src && (src.kind === "catalog" || src.kind === "library") ? src : null;
  const [browse, setBrowse] = useState(!m);
  const tpl = templateOf(ctx.project.template?.id);
  return (
    <div className="ve-fields vl-library">
      {fromLibrary && <RightsBlock name={fromLibrary.name} rights={fromLibrary.rights} />}
      {tpl && (
        <p className="ts-hint">
          “{tpl.name}” suggests {tpl.music.moods.map((id) => MUSIC_MOODS.find((x) => x.id === id)?.label ?? id).join(" or ")}
          {tpl.music.bpm ? `, ${tpl.music.bpm[0]}–${tpl.music.bpm[1]} BPM` : ""}. {tpl.music.note}
        </p>
      )}
      <button type="button" className="ts-btn" onClick={() => setBrowse((b) => !b)} aria-expanded={browse}>
        <Library size={14} /> {browse ? "Hide the music library" : m ? "Change track from the music library" : "Browse the music library"}
      </button>
      {browse && (
        <MusicLibrary
          client={ctx.looks.client?.id ?? null}
          clientName={ctx.looks.client?.name}
          selectedId={fromLibrary?.trackId ?? null}
          pickLabel={ctx.readOnly ? "Admins only" : "Use in this video"}
          onPick={(pick) => {
            if (ctx.readOnly) return;
            void ctx.looks.pickLibrary(pick).then(() => setBrowse(false));
          }}
        />
      )}
    </div>
  );
}
