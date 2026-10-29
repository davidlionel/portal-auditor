import { parse } from "tldts";
import { NICKNAME_GROUPS } from "@/config/nicknames";
import { normalizeCompany, normalizeDomain, normalizeName } from "@/lib/text";

// Matching keys for the duplicate checks. Values are turned into keys as
// each page of records arrives; only the keys are kept, never the values.

// A 53-bit hash of a string (cyrb53). Matching only needs equality, so
// phones, domains and company names are kept as numbers rather than text.
// 0 means "no value". Two different values sharing a hash is about a
// one-in-a-billion event even across a million records.
export function hashKey(s: string): number {
  if (!s) return 0;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0) || 1;
}

// The last 10 digits of a phone number, so "+1 (415) 555-0142" and
// "415.555.0142" match. Numbers with fewer than 10 digits are too short to
// compare safely and give "".
export function phoneKey(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

// The domain of an email address, lowercased: "" when there isn't one.
export function emailDomain(email: string | null | undefined): string {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@");
  return at < 0 ? "" : normalizeDomain(email!.trim().slice(at + 1));
}

// The registrable domain, using the Public Suffix List: "eu.acme.com" gives
// "acme.com", "acme.co.uk" stays "acme.co.uk", and each myshopify.com shop
// is its own domain. "" when the host has none.
export function rootDomain(domain: string): string {
  return (domain && parse(domain, { allowPrivateDomains: true }).domain) || "";
}

// The name part of a registrable domain: "acme" for acme.com and acme.co.uk.
export function domainLabel(domain: string): string {
  return (domain && parse(domain, { allowPrivateDomains: true }).domainWithoutSuffix) || "";
}

// "hs_additional_domains" holds extra domains separated by semicolons.
export function additionalDomains(value: string | null | undefined): string[] {
  return (value ?? "").split(";").map(normalizeDomain).filter(Boolean);
}

// Accents dropped, so "José" matches "Jose" and "Café" matches "Cafe".
export const foldAccents = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");

// A person's name for matching: normalizeName without accents.
export const personNameKey = (name: string | null | undefined) => normalizeName(foldAccents(name ?? ""));

// A company name for matching: normalizeCompany without accents, plus "&"
// read as "and" and a leading "the" dropped.
export function companyNameKey(name: string | null | undefined): string {
  const words = normalizeCompany(foldAccents(name ?? "").replace(/&/g, " and ")).split(" ").filter(Boolean);
  if (words.length > 1 && words[0] === "the") words.shift();
  return words.join(" ");
}

// Which nickname groups a first name belongs to.
const GROUPS_OF = new Map<string, number[]>();
NICKNAME_GROUPS.forEach((line, group) => {
  for (const name of line.split(" ")) GROUPS_OF.set(name, [...(GROUPS_OF.get(name) ?? []), group]);
});

export const nicknameGroups = (first: string): number[] => GROUPS_OF.get(first) ?? [];

// True when two different first names are nicknames of each other, like
// Bob and Robert, or Jon and John.
export function isNickname(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const groups = nicknameGroups(a);
  return nicknameGroups(b).some((g) => groups.includes(g));
}

// True when a and b are exactly one typo apart: one letter added, dropped,
// changed, or two neighbours swapped ("jhon" and "john").
export function oneTypoApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.slice(i) === long.slice(i + 1);
}

// Every string one deleted letter away from s, plus s itself. Two names one
// typo apart always share one, so they can be bucketed without comparing
// every pair.
export function deletionVariants(s: string): string[] {
  const out = new Set([s]);
  for (let i = 0; i < s.length; i++) out.add(s.slice(0, i) + s.slice(i + 1));
  return [...out];
}
