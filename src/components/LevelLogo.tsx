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
