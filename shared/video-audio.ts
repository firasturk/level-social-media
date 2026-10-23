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

/**
 * A video whose sound is the track ("Sound from a video file", "Sound from an Instagram link"):
 * the file is kept as it is and the browser's `decodeAudioData` reads the AAC sound out of the
 * MP4 (or MOV) when the editor plays and renders it. Only the post's tracks take these (the
 * upload route and the Instagram route); the music library stays audio files only.
 */
export const VIDEO_SOUND_MIMES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/** The formats a post's track may be stored in: the audio files, and the videos whose sound is the track. */
export const TRACK_MIMES: Record<string, string> = { ...AUDIO_MIMES, ...VIDEO_SOUND_MIMES };

/** A video kept for its sound is larger than an audio file: 60 MB at most (the size of a long reel). */
export const VIDEO_SOUND_MAX_BYTES = 60 * 1024 * 1024;

/** The name an Instagram reel's sound is kept under with the post. */
export const instagramSoundName = (username: string): string => `Sound of @${username}'s reel`;

/** The licence line an Instagram reel's sound is kept with: where it came from, and what the sound may be used for. */
export const instagramSoundLicence = (username: string, link: string): string =>
  `From Instagram (@${username}, ${link}). Sound from Instagram is licensed for use on Instagram only: confirm the rights before publishing it elsewhere.`;

/** The one line the editor shows when a reel's sound becomes the music. */
export const INSTAGRAM_SOUND_WARNING = "Sound from Instagram is licensed for use on Instagram only: confirm the rights before publishing this video anywhere else.";

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
