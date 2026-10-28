import type { TeamUser } from "@shared/team";
import { Sparkles } from "lucide-react";
import { avatarHue, initialsOf, LEVEL_AI } from "@shared/team-ui";

/** Initials on a soft colour from the person's id (the team has no pictures). */
export function Avatar({ user, size = 32, className = "" }: { user: Pick<TeamUser, "id" | "name">; size?: number; className?: string }) {
  const ai = user.id === LEVEL_AI.id;
  const hue = avatarHue(user.id);
  return (
    <span
      className={`tm-avatar ${ai ? "ai" : ""} ${className}`}
      style={{ "--size": `${size}px`, "--hue": hue } as React.CSSProperties}
      title={user.name}
      aria-hidden="true"
    >
      {ai ? <Sparkles size={Math.round(size * 0.5)} /> : initialsOf(user.name)}
    </span>
  );
}

/** A few members, overlapping, with "+n" for the rest. */
export function AvatarStack({ users, max = 4, size = 24 }: { users: Pick<TeamUser, "id" | "name">[]; max?: number; size?: number }) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <span className="tm-avatar-stack" title={users.map((u) => u.name).join(", ")}>
      {shown.map((u) => (
        <Avatar key={u.id} user={u} size={size} />
      ))}
      {rest > 0 && (
        <span className="tm-avatar tm-avatar-more" style={{ "--size": `${size}px` } as React.CSSProperties}>
          +{rest}
        </span>
      )}
    </span>
  );
}
