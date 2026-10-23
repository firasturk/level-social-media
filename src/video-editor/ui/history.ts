/**
 * Undo and redo for the project document: a past and a future stack, like the Text Studio's.
 * Every change to the cut goes through here, so every operation can be undone: trims, splits,
 * moves, deletes (ripple or not), speed, sound, locks, transitions, keyframes, layers, music,
 * voice-over, colour, frame, an automatic cut, a beat alignment and a recovered autosave.
 *
 * `commit` records a step; `patch` changes the document without a step (used while a slider or a
 * handle is being dragged): `mark` before the drag records the state it started from, and the
 * `commit` that ends it closes that one step (a drag is one undo, never two). A commit that
 * changes nothing records nothing. The stacks' rules live in shared/video-history.ts (tested).
 */
import { useCallback, useRef, useState } from "react";
import type { VideoProject } from "@shared/video-project";
import { HistoryStacks } from "@shared/video-history";

export interface History {
  project: VideoProject | null;
  /** Replaces the document (a load): the stacks are cleared. */
  load: (p: VideoProject | null) => void;
  /** A change that is one undo step. */
  commit: (next: VideoProject | ((p: VideoProject) => VideoProject)) => void;
  /** A change without a step (a drag in progress); the next `commit` records the whole move. */
  patch: (next: VideoProject | ((p: VideoProject) => VideoProject)) => void;
  /** Records the state before a drag so `patch` calls can be undone as one step. */
  mark: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  markSaved: () => void;
}

export function useHistory(): History {
  const [project, setProject] = useState<VideoProject | null>(null);
  const ref = useRef<VideoProject | null>(null);
  const stacks = useRef(new HistoryStacks<VideoProject>());
  const savedRef = useRef<VideoProject | null>(null);
  const [, tick] = useState(0);
  const bump = () => tick((n) => n + 1);
  const set = (p: VideoProject | null) => {
    ref.current = p;
    setProject(p);
  };
  const resolve = (next: VideoProject | ((p: VideoProject) => VideoProject)): VideoProject | null => (ref.current ? (typeof next === "function" ? next(ref.current) : next) : null);
  const load = useCallback((p: VideoProject | null) => {
    stacks.current.reset();
    savedRef.current = p;
    set(p);
    bump();
  }, []);
  const mark = useCallback(() => {
    if (!ref.current) return;
    stacks.current.mark(ref.current);
    bump();
  }, []);
  const commit = useCallback((next: VideoProject | ((p: VideoProject) => VideoProject)) => {
    const r = resolve(next);
    if (!r || !ref.current) return;
    const changed = r !== ref.current;
    if (!stacks.current.commit(ref.current, r)) return;
    if (changed) set({ ...r, updatedAt: Date.now() });
    bump();
  }, []);
  const patch = useCallback((next: VideoProject | ((p: VideoProject) => VideoProject)) => {
    const r = resolve(next);
    if (r) set(r);
  }, []);
  const undo = useCallback(() => {
    if (!ref.current) return;
    const prev = stacks.current.undo(ref.current);
    if (prev) set(prev);
    bump();
  }, []);
  const redo = useCallback(() => {
    if (!ref.current) return;
    const next = stacks.current.redo(ref.current);
    if (next) set(next);
    bump();
  }, []);
  const markSaved = useCallback(() => {
    savedRef.current = ref.current;
    bump();
  }, []);
  return { project, load, commit, patch, mark, undo, redo, canUndo: stacks.current.past.length > 0, canRedo: stacks.current.future.length > 0, dirty: project !== savedRef.current, markSaved };
}
