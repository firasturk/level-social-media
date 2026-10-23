/**
 * Whether the client holds a post's current version: they ANSWERED it on the review link (approved
 * it, or asked for a change). An editor's save on such a post never replaces what the client sees:
 * it is kept as a new version beside it, and the team makes it the client's version with an
 * explicit "Send it for review" (which also clears the answer, so the client answers again).
 *
 * A post the client has not answered yet is edited directly, even while the month's review link is
 * out: the link shows the latest version at once. (Until 23 Oct 2026 a review link alone held every
 * post of the month; `shared` is that older reason, never returned now, kept only so a version held
 * under it still reads and can still be sent.)
 *
 * Shared by the server (the picture upload, the AI tools' "Use as the post's picture", the video
 * renders and the first finished clip) and the page (the editors' notes and the card's action), so
 * both say the same thing.
 */

export type HoldReason = "approved" | "changes" | "shared";

export interface HoldConfig {
  approvals?: Record<string, { status: "approved" | "changes" } | undefined>;
}

/** Why the client holds post `index`'s current version, or null when an edit may replace it. */
export function clientHold(config: HoldConfig | null | undefined, index: number): HoldReason | null {
  const status = config?.approvals?.[String(index)]?.status;
  if (status === "approved") return "approved";
  if (status === "changes") return "changes";
  return null;
}

/** "The client approved the current picture", and so on: the start of every sentence about a hold. */
export function holdSubject(reason: HoldReason, what: "version" | "picture" = "version"): string {
  if (reason === "approved") return `The client approved the current ${what}`;
  if (reason === "changes") return `The client asked for a change on the current ${what}`;
  return `The client's review link shows the current ${what}`;
}

/** The plain sentence the editors and the card show after a held save. */
export function heldMessage(reason: HoldReason): string {
  return `${holdSubject(reason)}; your edit is saved as a new version. Send it for review to replace it.`;
}

/** The short note an editor's top bar carries while it works on a held post. */
export function holdNote(reason: HoldReason): string {
  if (reason === "approved") return "Client approved: saving makes a new version";
  if (reason === "changes") return "Client asked for a change: saving makes a new version";
  return "On the client's link: saving makes a new version";
}

/** One reviewer's answer as the hold reads it: its status and, when the review page sent it, the exact version it was about. */
interface AnswerLike {
  status: "approved" | "changes";
  version?: { kind: "video" | "image"; id: string };
}

/**
 * Whether the client's answer on a post is about the version they see now (a clip by id, or the
 * picture when no clip is the client's): a clip made later or sent since is not covered by it. An
 * answer recorded before versions were sent is taken as about the current version, the safe
 * reading. Used for the clips, whose client version can change without the answer being cleared.
 */
export function answeredCurrent(approval: { status: "approved" | "changes"; answers?: AnswerLike[] } | null | undefined, clientVideoId: string | null): boolean {
  if (!approval || (approval.status !== "approved" && approval.status !== "changes")) return false;
  const said = (approval.answers ?? []).filter((a) => a.status === approval.status && a.version);
  if (!said.length) return true;
  return said.some((a) => (clientVideoId ? a.version!.kind === "video" && a.version!.id === clientVideoId : a.version!.kind === "image"));
}
