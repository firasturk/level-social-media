/**
 * Undo and redo for the project document: a past and a future stack, like the Text Studio's.
 * `commit` records a step; `patch` changes the document without a step (used while a slider or a
 * handle is being dragged, with one `commit` at the end).
 */
import { useCallback, useRef, useState } from "react";
import type { VideoProject } from "@shared/video-project";

const MAX_HISTORY = 80;

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
  const past = useRef<VideoProject[]>([]);
  const future = useRef<VideoProject[]>([]);
  const savedRef = useRef<VideoProject | null>(null);
  const [, tick] = useState(0);
  const bump = () => tick((n) => n + 1);
  const set = (p: VideoProject | null) => {
    ref.current = p;
    setProject(p);
  };
  const resolve = (next: VideoProject | ((p: VideoProject) => VideoProject)): VideoProject | null => (ref.current ? (typeof next === "function" ? next(ref.current) : next) : null);
  const load = useCallback((p: VideoProject | null) => {
    past.current = [];
    future.current = [];
    savedRef.current = p;
    set(p);
    bump();
  }, []);
  const mark = useCallback(() => {
    if (!ref.current) return;
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), ref.current];
    future.current = [];
    bump();
  }, []);
  const commit = useCallback((next: VideoProject | ((p: VideoProject) => VideoProject)) => {
    const r = resolve(next);
    if (!r || !ref.current) return;
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), ref.current];
    future.current = [];
    set({ ...r, updatedAt: Date.now() });
  }, []);
  const patch = useCallback((next: VideoProject | ((p: VideoProject) => VideoProject)) => {
    const r = resolve(next);
    if (r) set(r);
  }, []);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev || !ref.current) return;
    future.current.push(ref.current);
    set(prev);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !ref.current) return;
    past.current.push(ref.current);
    set(next);
  }, []);
  const markSaved = useCallback(() => {
    savedRef.current = ref.current;
    bump();
  }, []);
  return { project, load, commit, patch, mark, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0, dirty: project !== savedRef.current, markSaved };
}
