import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BODY_FONTS, HEADLINE_FONTS, LATIN_FONTS, type FontChoice } from "@shared/overlay";

const SAMPLE_AR = "حلويات العيد";

/**
 * A font list where every option is drawn in its own font. Brand fonts uploaded for the client
 * come first; a font typed earlier that is in no list stays selectable under "Current".
 */
export default function FontPicker({
  kind,
  value,
  brandFonts,
  onChange,
  label,
}: {
  kind: "headline" | "body";
  value: string;
  brandFonts: string[];
  onChange: (family: string, weight: number | null) => void;
  label: string;
}) {
  const main = kind === "headline" ? HEADLINE_FONTS : BODY_FONTS;
  const other = kind === "headline" ? BODY_FONTS : HEADLINE_FONTS;
  const listed = new Set([...brandFonts, ...main, ...LATIN_FONTS, ...other].map((f) => (typeof f === "string" ? f : f.family)));
  const current = value && !listed.has(value) ? value : "";
  const weightOf = (family: string) =>
    [...main, ...other, ...LATIN_FONTS].find((f) => f.family === family)?.weight ?? null;
  const item = (f: FontChoice | string, key: string) => {
    const family = typeof f === "string" ? f : f.family;
    const weight = typeof f === "string" ? 400 : f.weight;
    return (
      <SelectItem key={key} value={family}>
        <span className="font-option" style={{ fontFamily: `"${family}", Tajawal, sans-serif`, fontWeight: weight }}>
          <span className="font-option-name">{family}</span>
          {LATIN_FONTS.some((l) => l.family === family) ? (
            <span className="font-option-sample">Aa Bb Cc</span>
          ) : (
            <span className="font-option-sample" dir="rtl">
              {SAMPLE_AR}
            </span>
          )}
        </span>
      </SelectItem>
    );
  };
  return (
    <Select value={value || undefined} onValueChange={(v) => onChange(v, weightOf(v))}>
      <SelectTrigger aria-label={label} className="font-picker">
        <SelectValue placeholder="Choose a font" />
      </SelectTrigger>
      <SelectContent className="font-picker-list">
        {current && (
          <SelectGroup>
            <SelectLabel>Current</SelectLabel>
            {item(current, `cur-${current}`)}
          </SelectGroup>
        )}
        {brandFonts.length > 0 && (
          <SelectGroup>
            <SelectLabel>Brand fonts</SelectLabel>
            {brandFonts.map((f) => item(f, `brand-${f}`))}
          </SelectGroup>
        )}
        <SelectGroup>
          <SelectLabel>{kind === "headline" ? "Headline fonts" : "Body fonts"}</SelectLabel>
          {main.map((f) => item(f, `main-${f.family}`))}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>{kind === "headline" ? "Body fonts" : "Headline fonts"}</SelectLabel>
          {other.filter((f) => !main.some((m) => m.family === f.family)).map((f) => item(f, `other-${f.family}`))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Latin</SelectLabel>
          {LATIN_FONTS.map((f) => item(f, `latin-${f.family}`))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
