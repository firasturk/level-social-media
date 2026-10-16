/**
 * The studio's icon kit: one icon and one colour per kind of setting, used on every section and
 * group so a designer finds the same thing in the same place (colours are always pink with a
 * palette, fonts always blue with a "T", and so on).
 */
import type { ReactNode } from "react";
import {
  AlignLeft,
  BadgeCheck,
  Camera,
  Compass,
  Gem,
  Heading,
  ImagePlus,
  Images,
  Layers,
  type LucideIcon,
  MessageSquareQuote,
  Palette,
  Scan,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Stamp,
  Type,
  Users,
} from "lucide-react";

export const KIT = {
  brand: { icon: Gem, color: "#8b5cf6", label: "Brand kit" },
  colours: { icon: Palette, color: "#ec4899", label: "Colours" },
  fonts: { icon: Type, color: "#3b82f6", label: "Fonts" },
  voice: { icon: MessageSquareQuote, color: "#10b981", label: "Tone of voice" },
  rules: { icon: ShieldCheck, color: "#f59e0b", label: "Rules" },
  identity: { icon: Images, color: "#a855f7", label: "Visual identity" },
  ambassadors: { icon: Users, color: "#f97316", label: "Brand ambassadors" },
  theme: { icon: Sparkles, color: "#06b6d4", label: "Theme" },
  references: { icon: ImagePlus, color: "#0ea5e9", label: "References" },
  direction: { icon: Compass, color: "#14b8a6", label: "Direction" },
  props: { icon: Shapes, color: "#84cc16", label: "Props" },
  shots: { icon: Camera, color: "#6366f1", label: "Shots" },
  overlay: { icon: Layers, color: "#0ea5e9", label: "Overlay" },
  logo: { icon: BadgeCheck, color: "#8b5cf6", label: "Logo" },
  corner: { icon: Stamp, color: "#f43f5e", label: "Corner logo" },
  headline: { icon: Heading, color: "#3b82f6", label: "Headline" },
  secondline: { icon: AlignLeft, color: "#60a5fa", label: "Second line" },
  spacing: { icon: Scan, color: "#94a3b8", label: "Margins and fade" },
  output: { icon: SlidersHorizontal, color: "#94a3b8", label: "Output" },
} satisfies Record<string, { icon: LucideIcon; color: string; label: string }>;

export type KitKey = keyof typeof KIT;

/** The kit's icon in a small tinted square. */
export function KitIcon({ kit, size = 14 }: { kit: KitKey; size?: number }) {
  const { icon: Icon, color } = KIT[kit];
  return (
    <span className="kit-icon" style={{ "--kit": color } as React.CSSProperties} aria-hidden>
      <Icon size={size} />
    </span>
  );
}

/** A colour-coded block inside a panel section: the kit's icon, a title and its fields. */
export function Group({
  kit,
  title,
  note,
  actions,
  children,
}: {
  kit: KitKey;
  title?: string;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="kit-group" style={{ "--kit": KIT[kit].color } as React.CSSProperties}>
      <div className="kit-group-head">
        <KitIcon kit={kit} />
        <strong>{title ?? KIT[kit].label}</strong>
        {note && <span className="kit-group-note">{note}</span>}
        {actions && <span className="kit-group-actions">{actions}</span>}
      </div>
      <div className="kit-group-body">{children}</div>
    </div>
  );
}
