import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, get, post, del } from "@/api";
import type { Batch, BatchResponse, Source, Task } from "@shared/types";

const TICK_MS = 4000;
/** One notice for a lost connection, however many polls fail. */
const POLL_LOST = "poll-lost";

export interface BatchView {
  batch: Batch | null;
  sources: Source[];
  tasks: Task[];
}

/** Holds the open batch and keeps it moving: while it runs, the client ticks the server every few seconds. */
export function useBatch() {
  const [view, setView] = useState<BatchView>({ batch: null, sources: [], tasks: [] });
  const current = useRef<string | null>(null);
  const ticking = useRef(false);

  // Answers are numbered by how fresh their data is, so an older one never lands over a newer one.
  // A read's data is as old as its request, so it takes its number when it is sent; a tick or an
  // action answers with the month as it is when the server lets go, so it takes its number on arrival.
  const asked = useRef(0);
  const shown = useRef(0);
  /** Polls that failed in a row, for one notice when the connection is gone. */
  const failed = useRef(0);

  const apply = useCallback((id: string, d: BatchResponse, n = ++asked.current) => {
    if (current.current !== id || n < shown.current) return;
    shown.current = n;
    setView({ batch: d.batch, sources: d.sources, tasks: d.tasks });
  }, []);

  /** The month as the server has it now; an answer overtaken by a newer one is dropped. */
  const read = useCallback(
    async (id: string) => {
      const n = ++asked.current;
      apply(id, await get<BatchResponse>(`/api/studio/batch?batch=${encodeURIComponent(id)}`), n);
    },
    [apply],
  );

  const open = useCallback(
    async (id: string) => {
      current.current = id;
      await read(id);
    },
    [read],
  );

  const close = useCallback(() => {
    current.current = null;
    setView({ batch: null, sources: [], tasks: [] });
  }, []);

  const action = useCallback(
    async (path: string, body: Record<string, unknown> = {}) => {
      const id = current.current;
      if (!id) return;
      apply(id, await post<BatchResponse>(`/api/studio/${path}`, { batch: id, ...body }));
    },
    [apply],
  );

  const active =
    view.batch?.state === "running" || view.tasks.some((t) => t.status === "processing");

  useEffect(() => {
    if (!active) return;
    const id = current.current;
    if (!id) return;
    // The tick drives generation and the server holds it open until the images it started are
    // saved (up to a minute or two), so a separate light refresh keeps the view current meanwhile.
    // A hidden tab keeps driving the batch: browsers slow a hidden tab's timer to about once a
    // minute, and the server holds each tick for minutes of work, so generation carries on.
    // One failed poll is transient and the next one retries. Three in a row is said once, so the
    // board does not go on reading "Generating…" with nobody told; the notice leaves when a poll works.
    let polling = true;
    const polled = (e?: unknown) => {
      // An answer that arrives after the polling stopped counts for nothing.
      if (!polling) return;
      if (e === undefined) {
        if (failed.current >= 3) toast.dismiss(POLL_LOST);
        failed.current = 0;
      } else if (++failed.current === 3)
        toast.error(e instanceof ApiError ? `The studio is not answering properly (${e.message}). It will keep trying.` : "Connection lost. The studio will keep trying.", { id: POLL_LOST, duration: Infinity });
    };
    const tick = async () => {
      if (ticking.current) return;
      ticking.current = true;
      try {
        apply(id, await post<BatchResponse>("/api/studio/tick", { batch: id }));
        polled();
      } catch (e) {
        polled(e);
      } finally {
        ticking.current = false;
      }
    };
    void tick();
    const timer = setInterval(tick, TICK_MS);
    // Coming back to the tab fires a tick at once instead of waiting for the slowed timer.
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    const refresher = setInterval(async () => {
      if (!ticking.current || document.hidden) return;
      try {
        await read(id);
        polled();
      } catch (e) {
        polled(e);
      }
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      clearInterval(refresher);
      document.removeEventListener("visibilitychange", onVisible);
      // Nothing is polled any more: the notice would never be taken down by a poll that works.
      polling = false;
      if (failed.current >= 3) toast.dismiss(POLL_LOST);
      failed.current = 0;
    };
  }, [active, apply, read, view.batch?.id]);

  const remove = useCallback(async () => {
    const id = current.current;
    if (!id) return;
    await del(`/api/studio/batch?batch=${encodeURIComponent(id)}`);
    close();
  }, [close]);

  return {
    ...view,
    active,
    open,
    close,
    refresh: () => (current.current ? open(current.current) : Promise.resolve()),
    action,
    remove,
  };
}
