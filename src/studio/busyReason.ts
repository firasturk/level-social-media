/**
 * Why a button is closed while the studio works, in a person's words: a closed button always says
 * what it waits for. The keys are the Workspace's `busy` values.
 */
const DOING: Record<string, string> = {
  ideas: "ideas are being written",
  grid: "the month is being planned from the reference grid",
  reidea: "a post's idea is being written again",
  upload: "product photos are being uploaded",
  generate: "pictures are being started",
  resume: "the pictures are being started again",
  client: "the client's comments are being worked on",
  continue: "the new month is being set up",
};

/** "Wait: …" for what is running now, or "" when nothing holds the button. */
export function busyReason(busy: string, running = false): string {
  if (busy) return `Wait: ${DOING[busy] ?? "something else is still running"}`;
  return running ? "Wait: pictures are being made" : "";
}

/** Why a card's fix button waits: one picture is fixed at a time. "" when it is free, or is the one being fixed. */
export function fixWaitReason(fixing: number | null, index: number, running = false): string {
  if (fixing !== null && fixing !== index) return "Another picture is being fixed; this one can start when it finishes";
  return fixing === null && running ? "Wait: pictures are being made" : "";
}
