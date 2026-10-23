/**
 * What the phase-3 panels (Colour, Templates, the music source) need from the editor besides the
 * shared PanelCtx: the split view, the client (its Drive pictures and its music library), the
 * reference pictures saved in the studio for this post, and the library pick.
 */
import type { MusicPick } from "./MusicLibrary";

/** A picture saved in the studio that can be a colour reference: the post's pinned reference or the theme's (Pinterest pins and uploads). */
export interface RefPicture {
  kind: "studio" | "post";
  id: string;
  name: string;
  /** Same-origin address of the picture (read-only). */
  url: string;
}

export interface LooksCtx {
  split: boolean;
  setSplit: (on: boolean) => void;
  client: { id: string; name: string } | null;
  references: RefPicture[];
  /** A music library track becomes the cut's music (decoded, beats found, its licence kept with the project). */
  pickLibrary: (pick: MusicPick) => Promise<void>;
  /** The LUT file loaded in this tab (a phase-1 draft keeps only the name). */
  tabLutName: string | null;
}

/** The studio's reference addresses (server/studio.ts and server/posts.ts read-only routes). */
export const studioRefUrl = (id: string): string => `/api/studio/references/${encodeURIComponent(id)}/file`;
export const postRefUrl = (batch: string, index: number, at: number): string => `/api/studio/posts/reference/image?batch=${encodeURIComponent(batch)}&index=${index}&size=full&v=${at}`;
export const drivePhotoUrl = (id: string, size: number): string => `/api/studio/drive/photo/${encodeURIComponent(id)}?size=${size}`;
