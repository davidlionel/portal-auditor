import type { Client } from "@hubspot/api-client";
import { request, type CallCounter, type HubSpotResult } from "./client";

export type ObjectType = "contacts" | "companies" | "deals";

export type PropertyOption = { label: string; value: string; hidden: boolean };

// The subset of HubSpot's Property schema the checks use.
export type PropertyDef = {
  name: string;
  label: string;
  description: string;
  type: string;
  fieldType: string;
  // True for HubSpot's built-in properties. We treat anything else as custom;
  // the docs imply this but don't state it as a rule.
  hubspotDefined: boolean;
  calculated: boolean;
  hasFormula: boolean;
  externalOptions: boolean;
  archived: boolean;
  createdAt: string | null;
  options: PropertyOption[];
};

type RawProperty = {
  name: string;
  label?: string;
  description?: string;
  type?: string;
  fieldType?: string;
  hubspotDefined?: boolean;
  calculated?: boolean;
  calculationFormula?: string;
  externalOptions?: boolean;
  archived?: boolean;
  createdAt?: string;
  options?: { label?: string; value?: string; hidden?: boolean }[];
};

// Returns non-archived, non-sensitive properties (the API's defaults).
export async function listProperties(
  client: Client,
  counter: CallCounter,
  objectType: ObjectType,
): Promise<HubSpotResult<PropertyDef[]>> {
  const result = await request<{ results?: RawProperty[] }>(
    client,
    counter,
    "GET",
    `/crm/properties/2026-09/${objectType}`,
  );
  if (!result.ok) return result;

  return {
    ok: true,
    data: (result.data.results ?? []).map((p) => ({
      name: p.name,
      label: p.label ?? p.name,
      description: p.description ?? "",
      type: p.type ?? "",
      fieldType: p.fieldType ?? "",
      hubspotDefined: p.hubspotDefined === true,
      calculated: p.calculated === true,
      hasFormula: Boolean(p.calculationFormula),
      externalOptions: p.externalOptions === true,
      archived: p.archived === true,
      createdAt: p.createdAt ?? null,
      options: (p.options ?? []).map((o) => ({
        label: o.label ?? "",
        value: o.value ?? "",
        hidden: o.hidden === true,
      })),
    })),
  };
}

export function isCustom(p: PropertyDef): boolean {
  return !p.hubspotDefined && !p.archived;
}
