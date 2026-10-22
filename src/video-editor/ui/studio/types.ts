import type { Approval } from "@shared/config";
import type { PresetCard } from "@shared/video-presets";
import type { VideoItem } from "@/studio/videoApi";

/** The seven panels of the rail, in order. */
export type StudioPanel = "presets" | "generate" | "edit" | "enhance" | "audio" | "versions" | "check";

/** What "Use this preset" hands the Generate panel. */
export interface GeneratePrefill {
  prompt: string;
  /** An engine the preset names, matched to the subscription catalog by name when it can be. */
  engine: string | null;
  presetTitle: string;
  presetCommand: string | null;
  at: number;
}

/** Everything a studio panel needs from the shell, in one object (as the Photo studio's panels get theirs). */
export interface StudioShared {
  post: { batch: string; index: number; title: string } | null;
  /** The post's picture (the first frame of a clip made here), when the post has one. */
  pictureUrl: string | null;
  fileBase: string;
  /** The post as it will be published, words and logo drawn by the browser, as a data URL. */
  composeArtwork?: () => Promise<string>;
  /** The client's answers on the approval link for this post, when any. */
  approval: Approval | null;
  videos: VideoItem[];
  videosLoaded: boolean;
  /** The month's versions read again (after a run, a select, a change). */
  reloadVideos: () => Promise<void>;
  /** The version shown on the stage and worked on by Enhance, Audio and Check; null shows the picture. */
  shownId: string | null;
  setShownId: (id: string | null) => void;
  /** A second version put beside the shown one on the stage. */
  compareId: string | null;
  setCompareId: (id: string | null) => void;
  openPanel: (p: StudioPanel) => void;
  /** "Use this preset": the Generate panel opens prefilled. */
  usePreset: (card: PresetCard) => void;
  prefill: GeneratePrefill | null;
  /** The post's versions changed: the cards read them again. */
  onChanged?: () => void;
  admin: boolean;
}
