/**
 * The month's occasions in Jordan, so posts land on the days people care about. Fixed dates are
 * listed; the Islamic ones are found with the Umm al-Qura calendar, which moves them every year.
 */
export interface Occasion {
  /** YYYY-MM-DD */
  date: string;
  name: string;
  ar: string;
}

const FIXED: { md: string; name: string; ar: string }[] = [
  { md: "01-01", name: "New Year's Day", ar: "رأس السنة" },
  { md: "01-30", name: "King Abdullah II's birthday", ar: "عيد ميلاد الملك" },
  { md: "02-14", name: "Valentine's Day", ar: "عيد الحب" },
  { md: "03-21", name: "Mother's Day", ar: "عيد الأم" },
  { md: "05-01", name: "Labour Day", ar: "عيد العمال" },
  { md: "05-25", name: "Independence Day", ar: "عيد الاستقلال" },
  { md: "06-09", name: "Accession Day", ar: "عيد الجلوس الملكي" },
  { md: "06-10", name: "Army Day and the Great Arab Revolt", ar: "يوم الجيش وذكرى الثورة العربية الكبرى" },
  { md: "11-14", name: "Birthday of the late King Hussein", ar: "ذكرى ميلاد الملك الحسين" },
  { md: "12-25", name: "Christmas", ar: "عيد الميلاد المجيد" },
  { md: "12-31", name: "New Year's Eve", ar: "ليلة رأس السنة" },
];

/** Hijri month and day (1-based) as "m-d". */
const HIJRI: { md: string; name: string; ar: string }[] = [
  { md: "1-1", name: "Islamic New Year", ar: "رأس السنة الهجرية" },
  { md: "3-12", name: "The Prophet's Birthday", ar: "المولد النبوي" },
  { md: "7-27", name: "Isra and Mi'raj", ar: "الإسراء والمعراج" },
  { md: "9-1", name: "First day of Ramadan", ar: "أول رمضان" },
  { md: "10-1", name: "Eid al-Fitr", ar: "عيد الفطر" },
  { md: "12-9", name: "Day of Arafah", ar: "يوم عرفة" },
  { md: "12-10", name: "Eid al-Adha", ar: "عيد الأضحى" },
];

function hijriOf(d: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
      day: "numeric",
      month: "numeric",
      timeZone: "UTC",
    }).formatToParts(d);
    const m = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    return m && day ? `${Number(m)}-${Number(day)}` : null;
  } catch {
    return null;
  }
}

function daysIn(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const iso = (month: string, day: number) => `${month}-${String(day).padStart(2, "0")}`;

export function occasionsOf(month: string): Occasion[] {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  const [y, m] = month.split("-").map(Number);
  const out: Occasion[] = [];
  for (let day = 1; day <= daysIn(month); day++) {
    const md = `${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    for (const f of FIXED) if (f.md === md) out.push({ date: iso(month, day), name: f.name, ar: f.ar });
    const h = hijriOf(new Date(Date.UTC(y, m - 1, day, 12)));
    for (const f of HIJRI) if (h === f.md) out.push({ date: iso(month, day), name: f.name, ar: f.ar });
  }
  return out;
}

/** Posting days spread evenly over the month (the 1st to the last day), one per post. */
export function spreadDates(month: string, count: number): string[] {
  if (!/^\d{4}-\d{2}$/.test(month) || count < 1) return [];
  const days = daysIn(month);
  return Array.from({ length: count }, (_, i) =>
    iso(month, Math.min(days, 1 + Math.round((i * (days - 1)) / Math.max(1, count - 1 || 1)))),
  );
}

/** A date of this month, or undefined. */
export function dateInMonth(value: unknown, month: string): string | undefined {
  const v = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && v.startsWith(`${month}-`) && Number(v.slice(8)) <= daysIn(month)
    ? v
    : undefined;
}

/** "Sat 14 Nov" in English, for chips and the share page. */
export function shortDate(date: string, locale = "en-GB"): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * Every post gets a day of the month: the writer's date when it is inside the month, otherwise
 * an evenly spread one. Posts are put in date order and numbered again.
 */
export function withDates<T extends { index: number; date?: string }>(plan: T[], month: string): T[] {
  if (!/^\d{4}-\d{2}$/.test(month)) return plan;
  const spread = spreadDates(month, plan.length);
  const dated = plan.map((p, i) => ({ ...p, date: dateInMonth(p.date, month) ?? spread[i] }));
  return dated
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.date!.localeCompare(b.p.date!) || a.i - b.i)
    .map(({ p }, i) => ({ ...p, index: i + 1 }));
}
