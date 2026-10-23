/**
 * The editor's undo and redo stacks (phase 2), without React, so the rules are tested as they are
 * used (src/video-editor/ui/history.ts wraps them in a hook):
 * - a commit records the state before it as one step; a commit that changes nothing records none;
 * - `mark` before a drag records the state it starts from; the commit that ends the drag closes
 *   that one step (a drag is one undo, never two), and a drag that changed nothing records none;
 * - a new change after an undo drops what could be redone; at most `MAX_HISTORY` steps are kept.
 */
export const MAX_HISTORY = 80;

export class HistoryStacks<T> {
  past: T[] = [];
  future: T[] = [];
  /** A `mark` is waiting for the commit that ends its drag. */
  private pending = false;

  reset(): void {
    this.past = [];
    this.future = [];
    this.pending = false;
  }

  mark(current: T): void {
    this.past = [...this.past.slice(-(MAX_HISTORY - 1)), current];
    this.future = [];
    this.pending = true;
  }

  /** Records `current` as the step before `next`; returns whether the document should change. */
  commit(current: T, next: T): boolean {
    if (this.pending) {
      this.pending = false;
      // The drag changed nothing: its mark is taken back.
      if (next === this.past[this.past.length - 1]) this.past.pop();
      return true;
    }
    if (next === current) return false;
    this.past = [...this.past.slice(-(MAX_HISTORY - 1)), current];
    this.future = [];
    return true;
  }

  undo(current: T): T | null {
    this.pending = false;
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: T): T | null {
    this.pending = false;
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }
}
