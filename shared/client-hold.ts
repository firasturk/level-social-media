/**
 * Whether the client holds a post's current version: they approved it on the review link, or the
 * month's review link is out and shows it. An editor's save on such a post never replaces what the
 * client sees: it is kept as a new version beside it, and the team makes it the client's version
 * with an explicit "Send it for review" (which also asks the client to answer again).
 *
 * Shared by the server (the picture upload and the video renders) and the page (the editors' notes
 * and the card's action), so both say the same thing.
 */

export type HoldReason = "approved" | "shared";

export interface HoldConfig {
  approvals?: Record<string, { status: "approved" | "changes" } | undefined>;
  shareToken?: string;
}

/** Why the client holds post `index`'s current version, or null when an edit may replace it. */
export function clientHold(config: HoldConfig | null | undefined, index: number): HoldReason | null {
  if (!config) return null;
  if (config.approvals?.[String(index)]?.status === "approved") return "approved";
  if (config.shareToken) return "shared";
  return null;
}

/** The plain sentence the editors and the card show after a held save. */
export function heldMessage(reason: HoldReason): string {
  return reason === "approved"
    ? "The client approved the current version; your edit is saved as a new version. Send it for review to replace it."
    : "The client's review link shows the current version; your edit is saved as a new version. Send it for review to replace it.";
}

/** The short note an editor's top bar carries while it works on a held post. */
export function holdNote(reason: HoldReason): string {
  return reason === "approved" ? "Client approved: saving makes a new version" : "On the client's link: saving makes a new version";
}
