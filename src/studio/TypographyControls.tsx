import { useEffect, useRef, useState } from "react";
import { ChevronDown, Type } from "lucide-react";
import { Orb } from "@/components/Orb";
import { TYPO_LABELS, TYPO_STYLES, type TypoStyle } from "@shared/typography";

/**
 * Typography styles for the month: the team picks the style (or lets the AI pick per post), and a
 * switch beside it brings back the plain headlines when the typography has a mistake.
 */
export interface TypographyProps {
  on: boolean;
  set: boolean;
  onSet: (style?: TypoStyle) => Promise<void>;
  onSwitch: (on: boolean) => Promise<void>;
}

export default function TypographyControls({
  on,
  set,
  disabled,
  onSet,
  onSwitch,
  className = "secondary",
}: {
  /** The month's typography is shown (not switched off). */
  on: boolean;
  /** Some post already has typography. */
  set: boolean;
  disabled?: boolean;
  onSet: (style?: TypoStyle) => Promise<void>;
  onSwitch: (on: boolean) => Promise<void>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"" | "set" | "switch">("");
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const run = async (what: "set" | "switch", fn: () => Promise<void>) => {
    setOpen(false);
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy("");
    }
  };
  const options: { style?: TypoStyle; label: string; hint: string }[] = [
    { label: "AI picks for each post", hint: "Behind, across, repeated or outline: what fits each picture" },
    ...TYPO_STYLES.map((s) => ({
      style: s,
      label: TYPO_LABELS[s],
      hint:
        s === "behind"
          ? "A big word with the product standing in front of it"
          : s === "overlap"
            ? "A big word crossing the product"
            : s === "repeat"
              ? "The word repeated down the post"
              : "One big outlined word",
    })),
  ];
  return (
    <span className="typo-controls" ref={box}>
      <button type="button" className={className} disabled={disabled || !!busy} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {busy === "set" ? <Orb size={15} /> : <Type size={15} />} Typography styles <ChevronDown size={13} />
      </button>
      {set && (
        <label className={`typo-switch ${on ? "on" : ""}`} title={on ? "Switch off: every post shows its plain headline" : "Switch on: the typography comes back"}>
          <input type="checkbox" checked={on} disabled={!!busy} onChange={(e) => void run("switch", () => onSwitch(e.target.checked))} />
          <span className="typo-switch-track">
            <span />
          </span>
          {busy === "switch" ? <Orb size={12} /> : on ? "On" : "Off"}
        </label>
      )}
      {open && (
        <span className="typo-menu" role="menu">
          {options.map((o) => (
            <button key={o.label} type="button" role="menuitem" onClick={() => void run("set", () => onSet(o.style))}>
              <strong>{o.label}</strong>
              <small>{o.hint}</small>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
