import type { ReactNode } from "react";
import type { Task } from "@shared/types";
import type { AdjustParams, CropRect } from "@shared/photo-adjust";
import type { PostEditorTools } from "../ReviewDialog";
import type { PhotoLab } from "../photolab/usePhotoLab";

/** The six panels of the left rail, in order. */
export type PhotoPanel = "edit" | "adjust" | "lab" | "assets" | "versions" | "check";

/** What the canvas shows. */
export type StageView =
  | { kind: "picture"; src: string; label: string }
  | { kind: "compare"; before: string; after: string; beforeLabel: string; afterLabel: string }
  | { kind: "adjust" };

/** A box in fractions of the picture (the marked area of an AI edit). */
export type Area = CropRect;

/** Everything a panel needs from the studio, in one object (as the video editor's panels get theirs). */
export interface StudioCtx {
  editor: PostEditorTools;
  task: Task;
  /** The studio's owner is busy with a request (an edit being sent). */
  busy: boolean;
  /** A new picture of this post is being made: the paid tools wait. */
  inFlight: boolean;
  resultUrl: string;
  originalUrl: string;
  clientId: string | null;
  /** " · about $0.04" or "" when the price is not known. */
  cost: string;
  view: StageView;
  setView: (v: StageView) => void;
  openPanel: (p: PhotoPanel) => void;
  onTextStudio?: () => void;

  /* The AI edit */
  edit: string;
  setEdit: (next: string | ((s: string) => string)) => void;
  marking: boolean;
  setMarking: (on: boolean) => void;
  area: Area | null;
  setArea: (a: Area | null) => void;
  /** Sends the instruction (the confirm is asked here first). */
  revise: (text: string) => Promise<void>;
  /** "Make another version", with the same confirm as the post editor. */
  remake?: () => Promise<void>;

  /* Adjust */
  params: AdjustParams;
  /** A change that is one undo step; `coalesce` joins quick successive changes of one slider into one step. */
  setParams: (next: AdjustParams, coalesce?: string) => void;
  resetParams: () => void;
  /** The source picture's size, once loaded. */
  natural: { w: number; h: number } | null;
  holdBefore: boolean;
  setHoldBefore: (on: boolean) => void;
  applyAdjust: () => Promise<void>;
  applying: boolean;

  /* The Photo lab (admins only for now) */
  lab: PhotoLab;

  /* Versions: the takes picked for the compare (at most two keys) */
  comparePick: string[];
  toggleComparePick: (key: string) => void;

  /* Panels mounted by the post editor's owner, reused here */
  ocrPanel?: ReactNode;
  freepik?: ReactNode;
  drivePicker?: ReactNode;
  videoVersions?: ReactNode;
  monthVersions?: ReactNode;
}
