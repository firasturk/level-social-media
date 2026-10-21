/**
 * The loading motif of the workflow: the Level mark in motion, one label per job, and a count only
 * when the engine gives one. Used where a reading, a plan or a rewrite is running.
 */
import { AnimatedLevelLogo } from "@/components/LevelLogo";

export default function Working({ label, count, className = "" }: { label: string; count?: { done: number; of: number }; className?: string }) {
  return (
    <div className={`working ${className}`} role="status" aria-live="polite">
      <AnimatedLevelLogo className="working-mark" />
      <span className="working-text">
        <b>{label}</b>
        {count && count.of > 0 && (
          <small>
            {count.done} of {count.of}
          </small>
        )}
      </span>
    </div>
  );
}
