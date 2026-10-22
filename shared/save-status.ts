/**
 * The state of the plan's autosave, shown wherever edits save themselves: saving, saved a moment
 * ago, or failed with the edit kept so it can be sent again. A reducer over events, so every board
 * reads the same words. Pure; nothing here reads storage.
 */
export type SaveStatus =
  | { state: "idle" }
  | { state: "saving"; started: number; pending: number }
  | { state: "saved"; at: number }
  | { state: "failed"; at: number; error: string; pending: number };

export type SaveEvent = { type: "start"; at: number } | { type: "done"; at: number } | { type: "fail"; at: number; error: string } | { type: "reset" };

export const SAVE_IDLE: SaveStatus = { state: "idle" };

/** Saves can overlap (two fields left in a row): the status stays "saving" until the last one lands. */
export function saveReducer(s: SaveStatus, e: SaveEvent): SaveStatus {
  switch (e.type) {
    case "start": {
      const pending = (s.state === "saving" || s.state === "failed" ? s.pending : 0) + 1;
      return { state: "saving", started: s.state === "saving" ? s.started : e.at, pending };
    }
    case "done": {
      const pending = (s.state === "saving" ? s.pending : 1) - 1;
      if (pending > 0 && s.state === "saving") return { ...s, pending };
      // A save that lands after a failure does not clear the failure: the failed edit is still unsent.
      if (s.state === "failed") return { ...s, pending: Math.max(0, s.pending - 1) };
      return { state: "saved", at: e.at };
    }
    case "fail": {
      const pending = (s.state === "saving" ? s.pending : s.state === "failed" ? s.pending + 1 : 1) - 1;
      return { state: "failed", at: e.at, error: e.error, pending: Math.max(0, pending) };
    }
    case "reset":
      return SAVE_IDLE;
  }
}

/** The words on the indicator: "Saving…", "Saved", "Saved 2 min ago", "Save failed". */
export function saveLabel(s: SaveStatus, now: number): string {
  switch (s.state) {
    case "idle":
      return "";
    case "saving":
      return "Saving…";
    case "saved": {
      const sec = Math.max(0, Math.round((now - s.at) / 1000));
      if (sec < 45) return "Saved";
      const min = Math.round(sec / 60);
      return `Saved ${min} min ago`;
    }
    case "failed":
      return "Save failed";
  }
}
