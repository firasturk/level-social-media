/**
 * Assets: Freepik stock (search and the library, admins only for now) and the client's Drive
 * photos, in two tabs, each with its source badge. For the selected Freepik asset: Add as layer
 * and Set as background (composed in the Text studio, which opens on this post with the asset
 * already placed: one search, one import), Use as reference (this post's next AI edit) and Save to
 * library. The actions stay in view while the results scroll. Layers and backgrounds are free: the
 * photo is never made again.
 */
import { useState } from "react";
import { toast } from "sonner";
import FreepikPanel, { type DesignHow, type FreepikLayer } from "../../FreepikPanel";
import SourceBadge from "../../SourceBadge";
import { queueAssetForDesign } from "../../assetHandoff";
import type { StudioCtx } from "../types";

export default function AssetsPanel({ ctx }: { ctx: StudioCtx }) {
  const batchId = ctx.editor.batchId ?? null;
  const index = ctx.editor.post.index;
  const canFreepik = !!ctx.clientId && !!batchId;
  const [tab, setTab] = useState<"freepik" | "drive">(canFreepik ? "freepik" : "drive");

  /** The asset is in the library and its use recorded: the Text studio places it on this post. */
  const toDesign = (layer: FreepikLayer, how: DesignHow) => {
    if (!batchId) return;
    queueAssetForDesign({ batch: batchId, post: index, how, layer });
    if (ctx.onTextStudio) {
      toast.success(how === "background" ? "Opening the Text studio with the background behind the photo." : how === "pieces" ? "Opening the Text studio with the vector as separate layers." : "Opening the Text studio with the asset as a layer.");
      ctx.onTextStudio();
    } else toast.success("Saved for this post's design: it appears when the Text studio opens.");
  };

  return (
    <div className="ps-panel ps-assets">
      <div className="ts-panel-head">
        <span>Assets</span>
      </div>
      <div className="ps-seg ps-asset-tabs" role="tablist" aria-label="Where the pictures come from">
        <button type="button" role="tab" aria-selected={tab === "freepik"} className={tab === "freepik" ? "on" : ""} onClick={() => setTab("freepik")}>
          <SourceBadge source="freepik" compact /> Stock
        </button>
        <button type="button" role="tab" aria-selected={tab === "drive"} className={tab === "drive" ? "on" : ""} onClick={() => setTab("drive")}>
          <SourceBadge source="drive" compact /> Client's Drive
        </button>
      </div>
      {tab === "freepik" &&
        (canFreepik ? (
          <FreepikPanel
            fill
            clientId={ctx.clientId!}
            batchId={batchId}
            post={index}
            mode="all"
            onReference={() => ctx.editor.onMonthChanged?.()}
            onDesign={toDesign}
            layerHint="Opens the Text studio on this post with the asset as an image layer: move, resize, turn and stack it there. Free: no picture is made."
          />
        ) : (
          <p className="ts-hint">Freepik assets are available on a saved month of a client.</p>
        ))}
      {tab === "drive" && (
        <div className="ps-drive">
          <p className="ts-hint">
            <SourceBadge source="drive" /> The client's own photos, pinned to this post as the reference for its next AI edit.
          </p>
          {ctx.drivePicker ?? <p className="ts-hint">The Drive is read on a saved month of a client.</p>}
        </div>
      )}
    </div>
  );
}
