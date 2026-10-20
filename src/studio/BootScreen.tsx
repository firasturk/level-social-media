import { useEffect, useState } from "react";
import LevelLogo from "@/components/LevelLogo";
import { Orb } from "@/components/Orb";

/** Full-page loader shown until the first screen's data and media are ready. Fades out, then unmounts. */
export default function BootScreen({ done = false }: { done?: boolean }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setGone(true), 450);
    return () => clearTimeout(t);
  }, [done]);
  if (gone) return null;
  return (
    <div className={`boot-screen ${done ? "done" : ""}`} role="status" aria-live="polite">
      <LevelLogo className="boot-wordmark" />
      <Orb size={60} stacked status="Loading your studio…" />
    </div>
  );
}
