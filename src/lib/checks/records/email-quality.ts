import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import type { SearchRow } from "@/lib/hubspot/search";
import { emailProblem } from "@/lib/text";
import { CATEGORY_FOR_OBJECT, type Finding } from "../types";

// Emails that are badly formatted or use a typo domain like gmial.com.
// Contacts with no email are counted separately, across the whole portal.
export function checkMalformedEmails(
  rows: SearchRow[],
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const bad = rows.filter((row) => {
    const email = row.properties.email;
    return email ? emailProblem(email, config.records.typoDomains) !== null : false;
  });
  if (!bad.length) return [];

  return [
    {
      checkId: "contacts.malformed-email",
      title: "Contacts with a malformed or mistyped email",
      category: CATEGORY_FOR_OBJECT.contacts,
      objectType: "contacts",
      severity: "medium",
      count: bad.length,
      samples: [],
      recordSamples: bad.slice(0, config.sampleCap).map((row) => [row.id]),
      why: "Emails to these addresses bounce, which hurts sender reputation, and the real person never hears from you.",
      fix: "Correct each address (gmial.com is almost always gmail.com), and add email validation to the forms that created them.",
    },
  ];
}
