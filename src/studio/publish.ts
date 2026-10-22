/**
 * Publishing to Instagram, browser side: the month's publications (read again while one is going
 * out), the publishing connection's state, and the final artwork composed the same way the OCR
 * panel and the export compose it: the words and the logo drawn over the picture at 1080 px, as a
 * JPEG Instagram accepts.
 */
import { useCallback, useEffect, useState } from "react";
import { get, post } from "@/api";
import { facesOf, renderOverlay } from "@/lib/overlay";
import type { OverlaySpec } from "@shared/overlay";
import type { Post } from "@shared/posts";
import type { Task } from "@shared/types";
import type { Publication } from "@shared/publish";

export interface PublishStatus {
  connected: boolean;
  reason: string | null;
  accounts: { igId: string; username: string }[];
  chosen: string | null;
}

export const ARTWORK_WIDTH = 1080;
export const JPEG_QUALITY = 0.9;

/** One slide's artwork as a JPEG data URL: the picture with its words and logo, as the card shows it. */
export async function composeArtwork(src: string, spec: OverlaySpec, p: Post, t: Task, logoSrc: string | null): Promise<string> {
  const canvas = await renderOverlay(src, spec, { headline: p.headline, subline: p.subline }, p.overlay === false ? null : logoSrc, ARTWORK_WIDTH, { patch: p.ov, faces: facesOf(t.qa) });
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** The month's publications, read again every few seconds while one is being published. */
export function usePublications(batchId: string | null): { list: Publication[]; refresh: () => Promise<void> } {
  const [list, setList] = useState<Publication[]>([]);
  const refresh = useCallback(async () => {
    if (!batchId) {
      setList([]);
      return;
    }
    try {
      const r = await get<{ publications: Publication[] }>(`/api/studio/publish?batch=${encodeURIComponent(batchId)}`);
      setList(r.publications);
    } catch {
      /* the month is not a plan yet, or the request failed: the cards show nothing */
    }
  }, [batchId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const busy = list.some((p) => p.status === "publishing");
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [busy, refresh]);
  return { list, refresh };
}

/** The publishing connection: whether the token can publish, and to which accounts. */
export function usePublishStatus(open: boolean, clientId: string | null): PublishStatus | null {
  const [status, setStatus] = useState<PublishStatus | null>(null);
  useEffect(() => {
    if (!open) return;
    setStatus(null);
    get<PublishStatus>(`/api/studio/publish/status${clientId ? `?client=${encodeURIComponent(clientId)}` : ""}`)
      .then(setStatus)
      .catch((e: Error) => setStatus({ connected: false, reason: e.message, accounts: [], chosen: null }));
  }, [open, clientId]);
  return status;
}

export interface PublishRequest {
  batch: string;
  index: number;
  igAccount: string;
  /** "now" or an ISO time. */
  when: string;
  artwork: string[];
}

export function requestPublish(body: PublishRequest): Promise<Publication> {
  return post<{ publication: Publication }>("/api/studio/publish", body).then((r) => r.publication);
}

export function cancelPublication(id: string): Promise<Publication> {
  return post<{ publication: Publication }>(`/api/studio/publish/${encodeURIComponent(id)}/cancel`).then((r) => r.publication);
}

export function retryPublication(id: string): Promise<Publication> {
  return post<{ publication: Publication }>(`/api/studio/publish/${encodeURIComponent(id)}/retry`).then((r) => r.publication);
}
