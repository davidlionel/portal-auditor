// Turns a HubSpot docs page into plain text for key-phrase checks: drops
// scripts and styles, replaces tags with spaces, decodes entities and
// collapses whitespace. HubSpot's HTML splits sentences around tags, so a
// space before punctuation is removed too ("segment :" becomes "segment:").
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  ndash: "-",
  mdash: "-",
};

export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/ ([:;,.)])/g, "$1")
    .trim();
}

// Key phrases the page no longer contains, compared case-insensitively on
// the same normalized text.
export function missingPhrases(text: string, phrases: string[]): string[] {
  const haystack = text.toLowerCase();
  return phrases.filter((phrase) => !haystack.includes(pageText(phrase).toLowerCase()));
}
