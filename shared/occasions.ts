/**
 * Occasions in Jordan, so a month can carry greeting posts on the days people care about: national
 * and royal days, religious feasts (the Islamic ones found with the Umm al-Qura calendar, Easter
 * computed), and international days. The team picks the ones the month posts; each picked occasion
 * becomes one greeting post designed in the month's theme with the occasion's own elements.
 */
export type OccasionCategory = "national" | "royal" | "religious" | "international" | "commercial";

export interface Occasion {
  /** Stable id ("independence", "ramadan"); custom occasions start with "c-". */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  name: string;
  ar: string;
  category: OccasionCategory;
  /** What the greeting design is built from (no food other than the client's products). */
  elements: string;
  /** Royal days: the greeting carries an official portrait the team uploads (never generated). */
  portrait?: boolean;
  /** Big days: a warning shows when the month does not post them. */
  major?: boolean;
}

type Def = Omit<Occasion, "date">;

const FLAG =
  "the Jordanian flag colours (black, white, green and red) as ribbons, bunting or fabric, the seven-pointed star as a subtle motif, celebratory light";
const ROYAL = `${FLAG}; an elegant, dignified frame of space in the upper middle where an official portrait is placed later (left empty, no person drawn)`;

const FIXED: (Def & { md: string })[] = [
  { md: "01-01", id: "new-year", name: "New Year's Day", ar: "رأس السنة الميلادية", category: "international", elements: "sparkling lights, confetti, a fresh calendar mood" },
  { md: "01-30", id: "king-birthday", name: "King Abdullah II's birthday", ar: "عيد ميلاد جلالة الملك عبدالله الثاني", category: "royal", elements: ROYAL, portrait: true, major: true },
  { md: "02-07", id: "loyalty-day", name: "Day of Loyalty and Allegiance", ar: "يوم الوفاء والبيعة", category: "royal", elements: ROYAL, portrait: true },
  { md: "02-14", id: "valentine", name: "Valentine's Day", ar: "عيد الحب", category: "international", elements: "roses and petals kept away from the food, ribbons, soft romantic light" },
  { md: "03-01", id: "arabization", name: "Arabization of the Army Command", ar: "ذكرى تعريب قيادة الجيش", category: "national", elements: FLAG },
  { md: "03-08", id: "womens-day", name: "International Women's Day", ar: "يوم المرأة العالمي", category: "international", elements: "fresh flowers, soft light, an elegant feminine touch" },
  { md: "03-21", id: "mothers-day", name: "Mother's Day", ar: "عيد الأم", category: "international", elements: "fresh flowers kept away from the food, a handwritten card without readable text, warm tender light", major: true },
  { md: "03-21", id: "karameh", name: "Battle of Karameh anniversary", ar: "ذكرى معركة الكرامة", category: "national", elements: FLAG },
  { md: "04-16", id: "flag-day", name: "Jordanian Flag Day", ar: "يوم العلم الأردني", category: "national", elements: FLAG, major: true },
  { md: "04-22", id: "earth-day", name: "Earth Day", ar: "يوم الأرض", category: "international", elements: "green leaves, natural materials, daylight" },
  { md: "05-01", id: "labour-day", name: "Labour Day", ar: "عيد العمال", category: "international", elements: "the craft and the hands that make the product, warm working light" },
  { md: "05-25", id: "independence", name: "Independence Day", ar: "عيد الاستقلال", category: "national", elements: FLAG, major: true },
  { md: "06-05", id: "environment-day", name: "World Environment Day", ar: "يوم البيئة العالمي", category: "international", elements: "green plants, natural textures" },
  { md: "06-09", id: "accession", name: "Accession Day", ar: "عيد الجلوس الملكي", category: "royal", elements: ROYAL, portrait: true, major: true },
  { md: "06-10", id: "army-day", name: "Army Day and the Great Arab Revolt", ar: "يوم الجيش وذكرى الثورة العربية الكبرى", category: "national", elements: FLAG, major: true },
  { md: "06-21", id: "fathers-day", name: "Father's Day", ar: "يوم الأب", category: "international", elements: "a classic watch, a folded newspaper without text, warm afternoon light" },
  { md: "06-28", id: "crown-prince-birthday", name: "Crown Prince Hussein's birthday", ar: "عيد ميلاد سمو ولي العهد الأمير الحسين", category: "royal", elements: ROYAL, portrait: true },
  { md: "07-07", id: "chocolate-day", name: "World Chocolate Day", ar: "يوم الشوكولاتة العالمي", category: "commercial", elements: "rich textures and warm light around the product" },
  { md: "08-31", id: "queen-birthday", name: "Queen Rania's birthday", ar: "عيد ميلاد جلالة الملكة رانيا العبدالله", category: "royal", elements: ROYAL, portrait: true },
  { md: "10-01", id: "coffee-day", name: "International Coffee Day", ar: "اليوم العالمي للقهوة", category: "commercial", elements: "coffee beans and a dallah as props when the client sells coffee; otherwise warm cafe light only" },
  { md: "10-05", id: "teachers-day", name: "World Teachers' Day", ar: "يوم المعلم", category: "international", elements: "books, pencils, a chalk-board texture without writing" },
  { md: "10-16", id: "food-day", name: "World Food Day", ar: "يوم الغذاء العالمي", category: "international", elements: "a generous, sharing table of the client's own products" },
  { md: "11-14", id: "king-hussein-birthday", name: "Birthday of the late King Hussein", ar: "ذكرى ميلاد المغفور له الملك الحسين", category: "royal", elements: ROYAL, portrait: true },
  { md: "11-20", id: "childrens-day", name: "World Children's Day", ar: "يوم الطفل العالمي", category: "international", elements: "playful colours, balloons, toys" },
  { md: "12-18", id: "arabic-day", name: "World Arabic Language Day", ar: "اليوم العالمي للغة العربية", category: "international", elements: "Arabic calligraphy texture as an abstract pattern without readable words, ink and paper" },
  { md: "12-25", id: "christmas", name: "Christmas", ar: "عيد الميلاد المجيد", category: "religious", elements: "pine branches, warm fairy lights, ornaments, wrapped gifts", major: true },
  { md: "12-31", id: "new-years-eve", name: "New Year's Eve", ar: "ليلة رأس السنة", category: "international", elements: "sparklers, golden bokeh lights, a festive night mood" },
];

const RAMADAN = "a crescent moon, fanous lanterns with warm glowing light, stars, arabesque patterns, a calm evening blue light";
const EID = "festive lights, a crescent and stars, ribbons and wrapped gifts, a joyful family mood";

/** Hijri month and day (1-based) as "m-d". */
const HIJRI: (Def & { md: string })[] = [
  { md: "1-1", id: "hijri-new-year", name: "Islamic New Year", ar: "رأس السنة الهجرية", category: "religious", elements: "a crescent moon, soft night light, arabesque patterns" },
  { md: "3-12", id: "mawlid", name: "The Prophet's Birthday", ar: "المولد النبوي الشريف", category: "religious", elements: "arabesque patterns, soft lanterns, a serene light", major: true },
  { md: "7-27", id: "isra", name: "Isra and Mi'raj", ar: "ذكرى الإسراء والمعراج", category: "religious", elements: "a night sky with stars, arabesque patterns, serene light" },
  { md: "9-1", id: "ramadan", name: "Ramadan begins", ar: "رمضان كريم", category: "religious", elements: RAMADAN, major: true },
  { md: "9-27", id: "laylat-al-qadr", name: "Laylat al-Qadr", ar: "ليلة القدر", category: "religious", elements: RAMADAN },
  { md: "10-1", id: "eid-al-fitr", name: "Eid al-Fitr", ar: "عيد الفطر السعيد", category: "religious", elements: EID, major: true },
  { md: "12-9", id: "arafah", name: "Day of Arafah", ar: "يوم عرفة", category: "religious", elements: "a calm sunrise light, arabesque patterns" },
  { md: "12-10", id: "eid-al-adha", name: "Eid al-Adha", ar: "عيد الأضحى المبارك", category: "religious", elements: EID, major: true },
];

/** Easter Sunday: Western (Gregorian) or Orthodox (Julian, shown in the Gregorian calendar). */
function easter(year: number, orthodox: boolean): Date {
  if (orthodox) {
    const a = year % 4, b = year % 7, c = year % 19;
    const d = (19 * c + 15) % 30;
    const e = (2 * a + 4 * b - d + 34) % 7;
    const month = Math.floor((d + e + 114) / 31);
    const day = ((d + e + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day + 13));
  }
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Days computed every year: Easter (both calendars) and Black Friday. */
function movable(year: number): (Def & { date: string })[] {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstThursday = 1 + ((4 - nov1 + 7) % 7);
  const blackFriday = new Date(Date.UTC(year, 10, firstThursday + 21 + 1));
  const west = easter(year, false);
  const east = easter(year, true);
  const out: (Def & { date: string })[] = [
    { date: iso(west), id: "easter", name: "Easter", ar: "عيد الفصح المجيد", category: "religious", elements: "spring flowers, painted eggs as decoration, soft morning light" },
    { date: iso(blackFriday), id: "black-friday", name: "Black Friday", ar: "الجمعة البيضاء", category: "commercial", elements: "bold sale mood in the month's colours, gift wrapping" },
  ];
  if (iso(east) !== iso(west))
    out.push({ date: iso(east), id: "orthodox-easter", name: "Orthodox Easter", ar: "عيد الفصح (الشرقي)", category: "religious", elements: "spring flowers, painted eggs as decoration, soft morning light" });
  return out;
}

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
    for (const { md: at, ...f } of FIXED) if (at === md) out.push({ ...f, date: iso(month, day) });
    const h = hijriOf(new Date(Date.UTC(y, m - 1, day, 12)));
    for (const { md: at, ...f } of HIJRI) if (h === at) out.push({ ...f, date: iso(month, day) });
  }
  for (const o of movable(y)) if (o.date.startsWith(`${month}-`)) out.push(o);
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** The occasions a month posts: the picked ones of the calendar and the team's own. */
export interface MonthOccasions {
  picked?: string[];
  custom?: { id: string; date: string; name: string; elements?: string }[];
  /** Official portraits uploaded for royal days, by occasion id (R2 keys). */
  photos?: Record<string, string>;
}

export function pickedOccasions(month: string, sel: MonthOccasions | undefined): Occasion[] {
  const picked = new Set(sel?.picked ?? []);
  const own: Occasion[] = (sel?.custom ?? [])
    .filter((c) => c.date.startsWith(`${month}-`))
    .map((c) => ({
      id: c.id,
      date: c.date,
      name: c.name,
      ar: c.name,
      category: "commercial",
      elements: c.elements?.trim() || "a festive touch that fits the occasion, in the month's colours",
    }));
  return [...occasionsOf(month).filter((o) => picked.has(o.id)), ...own].sort((a, b) => a.date.localeCompare(b.date));
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
