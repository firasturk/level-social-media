/**
 * The editor's recoverable autosave in this browser: the rules are shared/video-drafts.ts (tested);
 * this file hands them the browser's local storage. The storage can be missing or refuse a write
 * (a private window, blocked or full site data): the copy is then simply not kept, and the editor
 * works as before (Save draft is what keeps a cut).
 */
import * as drafts from "@shared/video-drafts";
import type { LocalDraft } from "@shared/video-drafts";

export { AUTOSAVE_MS, draftKey, draftTime, recoveryOffer, type LocalDraft } from "@shared/video-drafts";

const store = (): drafts.DraftStore | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export const readDraft = (key: string) => drafts.readDraft(store(), key);
export const writeDraft = (d: LocalDraft) => drafts.writeDraft(store(), d);
export const clearDraft = (key: string) => drafts.clearDraft(store(), key);
export const setDraftAside = (key: string) => drafts.setDraftAside(store(), key);
