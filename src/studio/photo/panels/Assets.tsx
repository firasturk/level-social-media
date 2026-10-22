/**
 * Assets: Freepik stock (search and the library, admins only for now) and the client's Drive
 * photos, in two tabs. A pick becomes the post's reference for its next AI edit. "Add to design"
 * (a picture layer over the post) is made in the Text studio, where the layer lives.
 */
import { useState } from "react";
import { HardDrive, Images, Type } from "lucide-react";
import type { StudioCtx } from "../types";

export default function AssetsPanel({ ctx }: { ctx: StudioCtx }) {
  const [tab, setTab] = useState<"freepik" | "drive">(ctx.freepik ? "freepik" : "drive");
  return (
    <div className="ps-panel">
      <div className="ts-panel-head">
        <span>Assets</span>
      </div>
      <div className="ps-seg" role="tablist" aria-label="Where the pictures come from">
        <button type="button" role="tab" aria-selected={tab === "freepik"} className={tab === "freepik" ? "on" : ""} onClick={() => setTab("freepik")}>
          <Images size={13} /> Freepik stock
        </button>
        <button type="button" role="tab" aria-selected={tab === "drive"} className={tab === "drive" ? "on" : ""} onClick={() => setTab("drive")}>
          <HardDrive size={13} /> Client's Drive
        </button>
      </div>
      {tab === "freepik" && (ctx.freepik ?? <p className="ts-hint">Freepik assets are available on a saved month of a client.</p>)}
      {tab === "drive" && (
        <>
          <p className="ts-hint">The client's own photos, pinned to this post as the reference for its next AI edit.</p>
          {ctx.drivePicker ?? <p className="ts-hint">The Drive is read on a saved month of a client.</p>}
        </>
      )}
      <div className="ps-secondary">
        <span className="ts-group-title">Add to the design</span>
        <p className="ts-hint">A stock picture or a product photo as a layer over the post (free, no picture made) is added in the Text studio: Layers › Add › Picture or Freepik asset.</p>
        {ctx.onTextStudio && (
          <button type="button" className="ts-btn" onClick={ctx.onTextStudio}>
            <Type size={14} /> Open the Text studio
          </button>
        )}
      </div>
    </div>
  );
}
