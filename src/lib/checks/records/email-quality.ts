import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import type { SearchRow } from "@/lib/hubspot/search";
import { emailProblem } from "@/lib/text";
import { CATEGORY_FOR_OBJECT, type CheckMeta, type Finding } from "../types";

export const MALFORMED_EMAIL: CheckMeta = {
  checkId: "contacts.malformed-email",
  title: "Contacts with a malformed or mistyped email",
  severity: "medium",
};

// True for an email that is badly formatted or uses a typo domain like
// gmial.com. Contacts with no email are counted separately, across the
// whole portal.
export function hasMalformedEmail(row: SearchRow, config: ChecksConfig = CHECKS_CONFIG): boolean {
  const email = row.properties.email;
  return email ? emailProblem(email, config.records.typoDomains) !== null : false;
}

// The finding for the contacts whose email failed, out of `population` read.
export function malformedEmailFinding(ids: string[], population: number, config: ChecksConfig = CHECKS_CONFIG): Finding[] {
  if (!ids.length) return [];
  return [
    {
      ...MALFORMED_EMAIL,
      category: CATEGORY_FOR_OBJECT.contacts,
      objectType: "contacts",
      count: ids.length,
      affected: ids.length,
      population,
      samples: [],
      recordSamples: ids.slice(0, config.sampleCap).map((id) => [id]),
      records: ids.slice(0, config.records.workListCap).map((id) => ({ id })),
      why: "Emails to these addresses bounce, which hurts sender reputation, and the real person never hears from you.",
      fix: "Correct each address (gmial.com is almost always gmail.com), and add email validation to the forms that created them.",
    },
  ];
}

export function checkMalformedEmails(rows: SearchRow[], config: ChecksConfig = CHECKS_CONFIG): Finding[] {
  return malformedEmailFinding(
    rows.filter((row) => hasMalformedEmail(row, config)).map((row) => row.id),
    rows.length,
    config,
  );
}
