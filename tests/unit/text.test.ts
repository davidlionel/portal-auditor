import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { differOnlyInDigits, levenshtein, normalizeLabel } from "@/lib/text";

describe("normalizeLabel", () => {
  it("lowercases and turns punctuation and underscores into single spaces", () => {
    assert.equal(normalizeLabel("Lead  Source"), "lead source");
    assert.equal(normalizeLabel("lead_source"), "lead source");
    assert.equal(normalizeLabel(" Lead-Source! "), "lead source");
  });

  it("keeps non-English letters", () => {
    assert.equal(normalizeLabel("Société Générale"), "société générale");
  });
});

describe("levenshtein", () => {
  it("counts single-character edits", () => {
    assert.equal(levenshtein("kitten", "sitting"), 3);
    assert.equal(levenshtein("preferred", "prefered"), 1);
    assert.equal(levenshtein("same", "same"), 0);
    assert.equal(levenshtein("", "abc"), 3);
  });
});

describe("differOnlyInDigits", () => {
  it("is true for numbered series and false otherwise", () => {
    assert.equal(differOnlyInDigits("region 1", "region 2"), true);
    assert.equal(differOnlyInDigits("region 1", "region 1"), false);
    assert.equal(differOnlyInDigits("region 1", "regions 1"), false);
  });
});
