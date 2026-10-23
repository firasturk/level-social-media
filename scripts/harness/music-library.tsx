/**
 * The music library panel mounted alone, the way the editor's right panel would hold it, for the
 * browser smoke (scripts/music-library-smoke.mjs). Its API answers come from the smoke's mock; the
 * last pick is shown under the panel and kept on window.__musicPick for the smoke to read.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { MusicLibrary, type MusicPick } from "@/video-editor/ui/MusicLibrary";

declare global {
  interface Window {
    __musicPick?: MusicPick;
  }
}

function Harness() {
  const [pick, setPick] = useState<MusicPick | null>(null);
  return (
    <div className="ts" style={{ flexDirection: "row" }}>
      <div style={{ flex: 1, padding: 16 }}>
        <p style={{ fontWeight: 600 }}>Picked</p>
        <pre data-testid="picked" style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
          {pick ? JSON.stringify({ id: pick.track.id, title: pick.track.title, licence: pick.track.licence, contentId: pick.track.contentId.status, credit: pick.credit, fileUrl: pick.fileUrl }, null, 2) : "Nothing yet"}
        </pre>
      </div>
      <aside style={{ width: 340, flex: "none", overflow: "auto", padding: 12, background: "#fff", borderLeft: "1px solid rgba(0,0,0,0.08)" }}>
        <MusicLibrary
          client="c1"
          clientName="حبيبة Habibah"
          selectedId={pick?.track.id ?? null}
          onPick={(p) => {
            window.__musicPick = p;
            setPick(p);
          }}
        />
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
