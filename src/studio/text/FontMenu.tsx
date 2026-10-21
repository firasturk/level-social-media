import { useMemo, useState } from "react";
import { ChevronDown, Star, Upload } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { BODY_FONTS, HEADLINE_FONTS, LATIN_FONTS } from "@shared/overlay";
import { favouriteFonts, recentFonts } from "./model";

const SAMPLE_AR = "حلويات العيد";

/**
 * The font family menu: every option drawn in its own face, searchable, in groups: the brand's
 * fonts first, then favourites, recent, Arabic display, Arabic text and Latin.
 */
export default function FontMenu({
  value,
  brand,
  onChange,
  onUpload,
}: {
  value: string;
  brand: string[];
  onChange: (family: string) => void;
  onUpload?: (file: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tick, setTick] = useState(0);
  const favs = useMemo(() => favouriteFonts.list(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const recent = useMemo(() => recentFonts.list().filter((f) => !brand.includes(f)), [brand, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups: { title: string; fonts: string[]; latin?: boolean }[] = [
    { title: "Brand", fonts: brand },
    { title: "Favourites", fonts: favs },
    { title: "Recent", fonts: recent },
    { title: "Arabic display", fonts: HEADLINE_FONTS.map((f) => f.family) },
    { title: "Arabic text", fonts: BODY_FONTS.map((f) => f.family) },
    { title: "Latin", fonts: LATIN_FONTS.map((f) => f.family), latin: true },
  ];
  const needle = q.trim().toLowerCase();
  const pick = (f: string) => {
    onChange(f);
    recentFonts.add(f);
    setOpen(false);
  };
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className="ts-font-trigger" title="Font family" style={{ fontFamily: `"${value}", Tajawal, sans-serif` }}>
          <span className="ts-font-trigger-name">{value || "Font"}</span>
          <ChevronDown size={13} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content className="ts-pop ts-fonts" sideOffset={8} align="start" collisionPadding={12}>
          <input className="ts-font-search" autoFocus placeholder="Search fonts…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="ts-font-list">
            {groups.map((g) => {
              const fonts = g.fonts.filter((f) => !needle || f.toLowerCase().includes(needle));
              if (!fonts.length) return null;
              return (
                <div key={g.title} className="ts-font-group">
                  <span className="ts-font-group-title">{g.title}</span>
                  {fonts.map((f) => (
                    <div key={`${g.title}:${f}`} className={`ts-font-item ${f === value ? "on" : ""}`}>
                      <button type="button" className="ts-font-pick" onClick={() => pick(f)} style={{ fontFamily: `"${f}", Tajawal, sans-serif` }}>
                        <span className="ts-font-name">{f}</span>
                        <span className="ts-font-sample" dir={g.latin ? "ltr" : "auto"}>
                          {g.latin || LATIN_FONTS.some((x) => x.family === f) ? "Aa Bb Cc" : SAMPLE_AR}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`ts-font-star ${favs.includes(f) ? "on" : ""}`}
                        aria-label={favs.includes(f) ? "Remove from favourites" : "Add to favourites"}
                        onClick={() => {
                          favouriteFonts.toggle(f);
                          setTick((t) => t + 1);
                        }}
                      >
                        <Star size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {onUpload && (
            <label className="ts-font-upload">
              <Upload size={13} /> Upload a brand font (.ttf, .otf, .woff2)
              <input type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
            </label>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
