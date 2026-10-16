import wordmark from "@/assets/level-wordmark.svg?raw";

/** The Level wordmark (vector, from the brand file); it takes the text colour of its parent. */
export default function LevelLogo({ className = "" }: { className?: string }) {
  return (
    <span
      className={`level-logo ${className}`}
      role="img"
      aria-label="Level"
      dangerouslySetInnerHTML={{ __html: wordmark }}
    />
  );
}

/**
 * The wordmark, animated: its letters rise in one by one, then a sheen in the studio's gradient
 * passes over them now and then (clipped to the letters by the wordmark itself as a mask).
 */
export function AnimatedLevelLogo({ className = "" }: { className?: string }) {
  const mask = `url("data:image/svg+xml;utf8,${encodeURIComponent(wordmark)}")`;
  return (
    <span className={`level-logo-anim ${className}`} role="img" aria-label="Level">
      <span className="level-logo-letters" aria-hidden dangerouslySetInnerHTML={{ __html: wordmark }} />
      <span className="level-logo-shine" aria-hidden style={{ maskImage: mask, WebkitMaskImage: mask }} />
    </span>
  );
}
