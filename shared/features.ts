/**
 * Features switched off in the interface, in one place.
 *
 * Hidden 15 Nov 2026 (the owner's decision): nobody ever used them (no rows in production). Only
 * their entry points are hidden: the code, the routes and the data stay, so nothing is lost. Set a
 * flag to true to bring that feature back. If nobody asks for one within 30 days it can be deleted.
 *
 *  - publish:        "Publish to Instagram…" on a card, "Schedule the approved posts…" under More,
 *                    and the "Publishing: ready" line in Connection → Instagram.
 *  - driveDelivery:  "Deliver to the client's Drive…" under More.
 *  - music:          the music library in the video editor's Music tab ("Browse the music library").
 *                    A track from the computer, a reel's sound and the voice-over stay.
 *  - radio:          the floating "Listen to your favourite music" button (Jordanian radio streams).
 *                    Hidden with the music library; it keeps no data, so it has its own flag.
 *  - influencers:    AI influencers (the screen has no entry left; the wording that names them).
 *
 * Imported by the browser code and the tests only ("@shared/features"). The worker does not import
 * it: the server routes of these features stay as they are.
 */
export const FEATURES = {
  publish: false,
  driveDelivery: false,
  music: false,
  radio: false,
  influencers: false,
} as const;

export type FeatureName = keyof typeof FEATURES;
