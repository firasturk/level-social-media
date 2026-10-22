/**
 * The audio choices a video version can carry, shared by the routes (server/video-audio.ts) and
 * the studio (the Video dialog, the versions list). What each one can do today is written up in
 * docs/audio-capabilities.md; the short of it:
 *
 *  - provider:  the engine's own generated sound (settings.audio true), only where the model makes any
 *  - none:      no sound (settings.audio false)
 *  - upload:    a licensed track the team uploaded; kept with the version and mixed in by the
 *               browser-side video editor, never by the server (the mp4 is unchanged until then)
 *  - generated: music from a connected provider (Magnific or Higgsfield); not connected yet
 *  - instagram: the Instagram music library, which only the Instagram app can add at publishing
 */
export type AudioChoice = "provider" | "none" | "upload" | "generated" | "instagram";

export const AUDIO_CHOICES: readonly AudioChoice[] = ["provider", "none", "upload", "generated", "instagram"] as const;

export const AUDIO_CHOICE_LABELS: Record<AudioChoice, string> = {
  provider: "Engine sound",
  none: "No sound",
  upload: "Upload a track",
  generated: "Generated music",
  instagram: "Add music on Instagram when publishing",
};

/** The accepted upload formats: the MIME types a browser sends for each extension. */
export const AUDIO_MIMES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
};

export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;

/** Why "Generated music" cannot run yet: the same sentence the route answers with (503). */
export const GENERATED_NOT_CONNECTED = "Generated music is not connected: add a Freepik/Magnific key or a Higgsfield key under Connection, then an admin can propose a track here.";

/** The one line a versions list shows for a version's audio ("Track: Summer loop"). */
export function audioChoiceLine(choice: AudioChoice | null, trackName?: string | null): string | null {
  switch (choice) {
    case "provider":
      return "Engine sound";
    case "none":
      return "No sound";
    case "upload":
      return `Track: ${trackName || "uploaded"}`;
    case "generated":
      return `Generated music${trackName ? `: ${trackName}` : ""}`;
    case "instagram":
      return "Music added on Instagram";
    default:
      return null;
  }
}
