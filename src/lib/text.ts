// Lowercase, turn punctuation and underscores into spaces, collapse whitespace.
// "Lead  Source", "lead_source" and "Lead-Source!" all become "lead source".
export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Minimum number of single-character edits (insert, delete, substitute)
// to turn a into b. Classic dynamic programming, one row at a time.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// True when two strings differ only in their digits, like "Region 1" and
// "Region 2". Numbered series are intentional, not typos.
export function differOnlyInDigits(a: string, b: string): boolean {
  return a !== b && a.replace(/\d/g, "") === b.replace(/\d/g, "");
}
