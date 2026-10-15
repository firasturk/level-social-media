import { useEffect, useState } from "react";

/** Full-page loader shown until the first screen's data and media are ready. Fades out, then unmounts. */
export default function BootScreen({ done = false }: { done?: boolean }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setGone(true), 450);
    return () => clearTimeout(t);
  }, [done]);
  if (gone) return null;
  const light =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
  return (
    <div className={`boot-screen ${done ? "done" : ""}`} role="status" aria-live="polite">
      <img
        src={light ? "/logo-mark-dark.png" : "/logo-mark.png"}
        alt="Level"
        width={120}
        height={40}
      />
      <div className="boot-ring" aria-hidden="true" />
      <span>Loading your studio…</span>
    </div>
  );
}
