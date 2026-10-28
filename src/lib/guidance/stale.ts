import { GUIDANCE, type GuidanceEntry } from "@/config/hubspot-guidance";

const DAY_MS = 24 * 60 * 60 * 1000;

// Guidance not re-verified for more than `maxDays`, oldest first.
export function staleGuidance(
  today: Date,
  maxDays = 90,
  guidance: Record<string, GuidanceEntry> = GUIDANCE,
): { id: string; lastVerified: string; days: number }[] {
  return Object.entries(guidance)
    .map(([id, entry]) => ({
      id,
      lastVerified: entry.lastVerified,
      days: Math.floor((today.getTime() - Date.parse(entry.lastVerified)) / DAY_MS),
    }))
    .filter((e) => e.days > maxDays)
    .sort((a, b) => b.days - a.days);
}
