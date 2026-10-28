import type { AccountDetails } from "./client";
import type { ObjectType } from "./properties";

// HubSpot's object type IDs, used in record URLs.
const OBJECT_TYPE_IDS: Record<ObjectType, string> = {
  contacts: "0-1",
  companies: "0-2",
  deals: "0-3",
};

// A link to the record in HubSpot, or null when the account didn't report
// its UI domain.
export function recordUrl(
  portal: Pick<AccountDetails, "uiDomain" | "portalId">,
  objectType: ObjectType,
  id: string,
): string | null {
  if (!portal.uiDomain) return null;
  return `https://${portal.uiDomain}/contacts/${portal.portalId}/record/${OBJECT_TYPE_IDS[objectType]}/${id}`;
}
