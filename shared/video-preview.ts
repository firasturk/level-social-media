/**
 * The rules of a video preview in Level Studio, shared by every surface (Studio cards, versions,
 * presets, galleries, asset previews, the "Create or edit video" card, editor and dialog previews,
 * the client review link): a visible preview plays by itself, muted, inline and looping, the way
 * Higgsfield's pages do. Pure functions only, so the browser component (src/components/AutoplayVideo.tsx)
 * and the tests read the same decisions.
 *
 * - It plays while it is on screen, its dialog is open, the tab is visible, nothing failed, and the
 *   person has not paused it. It pauses when any of those stops being true.
 * - A person's own pause wins: autoplay never resumes a video the person paused, and never moves
 *   its playhead.
 * - Reduced motion: no autoplay; the poster stays and a Play button starts it by hand.
 * - Sound starts only from a person's action, and only one video is audible at a time.
 * - At most `MAX_PLAYING` previews play at once (the ones most on screen), so a long page of
 *   cards does not decode every clip together.
 */

export interface PlaybackState {
  /** On screen (at least the visibility threshold). */
  visible: boolean;
  /** The surface that holds it is open (a dialog, a panel); false pauses it. */
  active: boolean;
  /** The browser tab is in the background. */
  tabHidden: boolean;
  /** The person paused it (or has not started it, under reduced motion). */
  userPaused: boolean;
  /** The person asked for reduced motion. */
  reducedMotion: boolean;
  /** Autoplay is wanted on this surface (false for an editor's working preview the timeline drives). */
  autoplay: boolean;
  /** The browser refused to start it, or the media failed: a Play button is shown instead. */
  blocked: boolean;
  /** The person started it by hand (a Play click): reduced motion no longer holds it back. */
  userStarted: boolean;
}

export type PlaybackDecision = "play" | "pause" | "hold";

/**
 * What a preview should do now. "hold" leaves it as it is (a person's pause, a refused autoplay,
 * an editor's preview the timeline drives).
 */
export function decidePlayback(s: PlaybackState): PlaybackDecision {
  if (!s.active || s.tabHidden || !s.visible) return "pause";
  if (s.userPaused) return "hold";
  if (s.blocked) return "hold";
  if (s.userStarted) return "play";
  if (!s.autoplay || s.reducedMotion) return "hold";
  return "play";
}

/** How many previews may play at once on one page. */
export const MAX_PLAYING = 6;

/** The share of a preview that must be on screen before it plays. */
export const VISIBLE_RATIO = 0.35;

/** How far outside the screen a preview starts loading its media (so it is ready when it arrives). */
export const PRELOAD_MARGIN = "300px";

export interface Candidate {
  id: string;
  /** How much of it is on screen, 0–1. */
  ratio: number;
  /** It is audible or the person started it: it keeps playing first. */
  priority: boolean;
}

/**
 * Which of the previews that want to play may play: the person's own choices first, then the most
 * visible, at most `max`. The rest pause until a place frees up.
 */
export function allowedToPlay(candidates: Candidate[], max = MAX_PLAYING): Set<string> {
  const sorted = [...candidates].sort((a, b) => Number(b.priority) - Number(a.priority) || b.ratio - a.ratio || a.id.localeCompare(b.id));
  return new Set(sorted.slice(0, Math.max(0, max)).map((c) => c.id));
}

/** The one audible preview: claiming sound for a new one mutes the one before. */
export function nextAudible(current: string | null, claimant: string, wantsSound: boolean): { audible: string | null; mute: string | null } {
  if (!wantsSound) return { audible: current === claimant ? null : current, mute: null };
  return { audible: claimant, mute: current && current !== claimant ? current : null };
}
