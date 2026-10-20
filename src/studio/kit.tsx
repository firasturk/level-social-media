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
  Shirt,
  SlidersHorizontal,
  Sparkles,
  Stamp,
  Type,
  Users,
} from "lucide-react";

export const KIT = {
  brand: { icon: Gem, color: "#2038e2", label: "Brand kit" },
  colours: { icon: Palette, color: "#ff5a00", label: "Colours" },
  fonts: { icon: Type, color: "#007bff", label: "Fonts" },
  voice: { icon: MessageSquareQuote, color: "#10b981", label: "Tone of voice" },
  rules: { icon: ShieldCheck, color: "#c24400", label: "Rules" },
  identity: { icon: Images, color: "#3d5cff", label: "Visual identity" },
  ambassadors: { icon: Users, color: "#ff7a33", label: "Brand ambassadors" },
  theme: { icon: Sparkles, color: "#1fb6ff", label: "Theme" },
  references: { icon: ImagePlus, color: "#007bff", label: "References" },
  direction: { icon: Compass, color: "#0fa88f", label: "Direction" },
  props: { icon: Shapes, color: "#4caf50", label: "Props" },
  wardrobe: { icon: Shirt, color: "#ff5a00", label: "Wardrobe" },
  shots: { icon: Camera, color: "#2038e2", label: "Shots" },
  overlay: { icon: Layers, color: "#007bff", label: "Overlay" },
  logo: { icon: BadgeCheck, color: "#2038e2", label: "Logo" },
  corner: { icon: Stamp, color: "#ff5a00", label: "Corner logo" },
  headline: { icon: Heading, color: "#007bff", label: "Headline" },
  secondline: { icon: AlignLeft, color: "#5b9dff", label: "Second line" },
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
    <div className="kit-group" data-kit={kit} style={{ "--kit": KIT[kit].color } as React.CSSProperties}>
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
