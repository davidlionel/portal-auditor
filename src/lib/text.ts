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

// Apostrophes, straight and curly, are dropped rather than turned into a
// space, so "O'Neil" and "oneil" or "McDonald's" and "McDonalds" match.
const APOSTROPHES = /['‘’ʼ]/g;

// A person's name with case, spaces and punctuation ignored: "O'Neil",
// "O’Neil", "o neil" and "oneil" all become "oneil".
export function normalizeName(s: string): string {
  return normalizeLabel(s.replace(APOSTROPHES, "")).replace(/ /g, "");
}

// Legal suffixes that don't distinguish one company from another.
const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "co", "corp", "corporation", "plc", "gmbh",
]);

// "Acme, Inc." and "ACME Inc" both become "acme".
export function normalizeCompany(s: string): string {
  const words = normalizeLabel(s.replace(APOSTROPHES, "")).split(" ").filter(Boolean);
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

// "https://www.Globex.example/about" becomes "globex.example". Returns "" for
// values with no dot, which can't be a domain.
export function normalizeDomain(s: string): string {
  const host = s
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#:]/)[0]
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return host.includes(".") ? host : "";
}

// Why an email looks wrong, or null if it looks fine. Deliberately simple:
// HubSpot already rejects most bad formats, so typo domains matter more.
export function emailProblem(email: string, typoDomains: string[]): "format" | "typo" | null {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "format";
  const domain = trimmed.slice(trimmed.lastIndexOf("@") + 1);
  return typoDomains.includes(domain) ? "typo" : null;
}

// True when two strings differ only in their digits, like "Region 1" and
// "Region 2". Numbered series are intentional, not typos.
export function differOnlyInDigits(a: string, b: string): boolean {
  return a !== b && a.replace(/\d/g, "") === b.replace(/\d/g, "");
}
