import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { populationNoun, rateText } from "@/lib/checks/population";
import type { Finding } from "@/lib/checks/types";

const f = (checkId: string, category: Finding["category"], objectType: Finding["objectType"], affected: number, population: number) =>
  ({ checkId, category, objectType, affected, population });

describe("rate text", () => {
  it("names what was affected, not what was checked", () => {
    assert.equal(rateText(f("companies.duplicate-domain", "Companies", "companies", 10, 139)), "10 of 139 companies affected (7.2%)");
    assert.equal(rateText(f("properties.no-description", "Properties", "contacts", 10, 11)), "10 of 11 properties affected (90.9%)");
  });

  it("uses each check's own population", () => {
    assert.equal(populationNoun(f("contacts.customer-without-won-deal", "Contacts", "contacts", 35, 66)), "customers");
    assert.equal(populationNoun(f("deals.stale", "Deals", "deals", 154, 158)), "open deals");
    assert.equal(populationNoun(f("deals.missing-close-date", "Deals", "deals", 59, 158)), "open deals");
    assert.equal(populationNoun(f("deals.missing-amount", "Deals", "deals", 6, 275)), "open or won deals");
    assert.equal(populationNoun(f("contacts.missing-email", "Contacts", "contacts", 2, 900)), "contacts");
    assert.equal(populationNoun(f("contacts.malformed-email", "Contacts", "contacts", 2, 900)), "contacts");
    assert.equal(populationNoun(f("properties.dropdown-variants", "Properties", "deals", 1, 4)), "dropdown properties");
  });

  it("is singular for a population of one", () => {
    assert.equal(rateText(f("properties.near-zero-fill", "Properties", "deals", 1, 1)), "1 of 1 property affected (100%)");
    assert.equal(populationNoun(f("deals.stale", "Deals", "deals", 1, 1)), "open deal");
  });

  it("shows two decimals under 1%, and never 0% when something is affected", () => {
    assert.equal(rateText(f("contacts.missing-email", "Contacts", "contacts", 3, 1000)), "3 of 1,000 contacts affected (0.3%)");
    assert.equal(rateText(f("contacts.missing-email", "Contacts", "contacts", 3, 250_000)), "3 of 250,000 contacts affected (<0.01%)");
  });
});
