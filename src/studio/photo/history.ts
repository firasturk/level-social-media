/**
 * Undo and redo over the Adjust parameters: a past and a future stack, as the Text Studio keeps
 * for its design. `set` records a step; quick successive `set`s with the same `coalesce` key (one
 * slider being dragged) fold into one step, so an undo takes the whole move back.
 */
import { useCallback, useRef, useState } from "react";

const MAX_HISTORY = 80;
const COALESCE_MS = 900;

export interface ParamsHistory<T> {
  value: T;
  set: (next: T, coalesce?: string) => void;
  undo: () => void;
  redo: () => void;
  /** Back to the start, with the stacks cleared (after an apply). */
  reset: (to: T) => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useParamsHistory<T>(initial: T): ParamsHistory<T> {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const last = useRef<{ key: string; at: number } | null>(null);
  const [, tick] = useState(0);
  const bump = useCallback(() => tick((n) => n + 1), []);
  const put = useCallback((v: T) => {
    ref.current = v;
    setValue(v);
  }, []);
  const set = useCallback((next: T, coalesce?: string) => {
    const now = Date.now();
    const joined = !!coalesce && last.current?.key === coalesce && now - last.current.at < COALESCE_MS;
    if (!joined) {
      past.current = [...past.current.slice(-(MAX_HISTORY - 1)), ref.current];
      future.current = [];
    }
    last.current = coalesce ? { key: coalesce, at: now } : null;
    put(next);
    bump();
  }, [put, bump]);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(ref.current);
    last.current = null;
    put(prev);
    bump();
  }, [put, bump]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(ref.current);
    last.current = null;
    put(next);
    bump();
  }, [put, bump]);
  const reset = useCallback((to: T) => {
    past.current = [];
    future.current = [];
    last.current = null;
    put(to);
    bump();
  }, [put, bump]);
  return { value, set, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
