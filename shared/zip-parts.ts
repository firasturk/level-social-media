/**
 * Export splitting: files are grouped by product folder (the name before the first slash) in
 * first-seen order, and a new part starts when the next folder would push the current part over
 * the limit, so a product's images stay together unless the folder alone is bigger than a part.
 */
export interface PartItem {
  name: string;
  /** Bytes of the file as it will sit in the archive. */
  size: number;
}

/** ZIP bookkeeping per file (local header plus central directory entry) on top of its bytes. */
export function zipOverhead(name: string): number {
  return 2 * (name.length + 46) + 30;
}

/** Index lists, one per part, in order. */
export function splitIntoParts(items: PartItem[], partMax: number): number[][] {
  const groups = new Map<string, number[]>();
  items.forEach((it, i) => {
    const folder = it.name.includes("/") ? it.name.slice(0, it.name.indexOf("/")) : it.name;
    groups.set(folder, [...(groups.get(folder) ?? []), i]);
  });
  const parts: number[][] = [];
  let part: number[] = [];
  let bytes = 0;
  const cost = (i: number) => items[i].size + zipOverhead(items[i].name);
  for (const group of groups.values()) {
    const size = group.reduce((n, i) => n + cost(i), 0);
    if (part.length && bytes + size > partMax) {
      parts.push(part);
      part = [];
      bytes = 0;
    }
    for (const i of group) {
      // A single folder bigger than a part is split file by file.
      if (part.length && bytes + cost(i) > partMax) {
        parts.push(part);
        part = [];
        bytes = 0;
      }
      part.push(i);
      bytes += cost(i);
    }
  }
  if (part.length || !parts.length) parts.push(part);
  return parts;
}
