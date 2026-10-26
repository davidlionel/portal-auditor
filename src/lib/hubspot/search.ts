import type { Client } from "@hubspot/api-client";
import type { Pacer } from "../pace";
import { request, type CallCounter, type HubSpotResult } from "./client";
import type { ObjectType } from "./properties";

// Counts records via the Search API's `total`, without pulling the records.
// With no propertyName it counts every record of the object.
export async function countRecords(
  client: Client,
  counter: CallCounter,
  pace: Pacer,
  objectType: ObjectType,
  propertyName?: string,
): Promise<HubSpotResult<number>> {
  const body = {
    limit: 1,
    properties: ["hs_object_id"],
    filterGroups: propertyName
      ? [{ filters: [{ propertyName, operator: "HAS_PROPERTY" }] }]
      : [],
  };

  const result = await pace(() =>
    request<{ total?: number }>(
      client,
      counter,
      "POST",
      `/crm/objects/2026-09/${objectType}/search`,
      body,
    ),
  );
  if (!result.ok) return result;
  if (typeof result.data.total !== "number") return { ok: false, kind: "unexpected" };
  return { ok: true, data: result.data.total };
}
