import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  differOnlyInDigits,
  emailProblem,
  levenshtein,
  normalizeCompany,
  normalizeDomain,
  normalizeLabel,
  normalizeName,
} from "@/lib/text";

describe("normalizeCompany", () => {
  it("drops trailing legal suffixes", () => {
    assert.equal(normalizeCompany("Acme, Inc."), "acme");
    assert.equal(normalizeCompany("ACME Inc"), "acme");
    assert.equal(normalizeCompany("Globex Corp Ltd"), "globex");
  });

  it("keeps a name that is only a suffix word", () => {
    assert.equal(normalizeCompany("Co"), "co");
  });

  it("keeps words that only matter in the middle", () => {
    assert.equal(normalizeCompany("Co-op Foods"), "co op foods");
  });

  it("drops apostrophes instead of splitting the word", () => {
    assert.equal(normalizeCompany("McDonald's Inc"), "mcdonalds");
    assert.equal(normalizeCompany("McDonald’s"), "mcdonalds");
  });
});

describe("normalizeName", () => {
  it("ignores case, apostrophes, spaces and hyphens", () => {
    for (const s of ["O'Neil", "O’Neil", "o neil", "O-Neil", "oneil"]) assert.equal(normalizeName(s), "oneil", s);
    assert.equal(normalizeName("Mary Ann"), normalizeName("Maryann"));
  });

  it("keeps non-English letters", () => {
    assert.equal(normalizeName("José"), "josé");
  });
});

describe("normalizeDomain", () => {
  it("strips protocol, www, path, port and case", () => {
    assert.equal(normalizeDomain("https://www.Globex.example/about?x=1"), "globex.example");
    assert.equal(normalizeDomain("globex.example:8080"), "globex.example");
    assert.equal(normalizeDomain(" Globex.example. "), "globex.example");
  });

  it("keeps subdomains other than www", () => {
    assert.equal(normalizeDomain("eu.initech.example"), "eu.initech.example");
  });

  it("returns empty for values that can't be a domain", () => {
    assert.equal(normalizeDomain(""), "");
    assert.equal(normalizeDomain("localhost"), "");
  });
});

describe("emailProblem", () => {
  const typos = ["gmial.com"];
  it("classifies format failures, typo domains and good addresses", () => {
    assert.equal(emailProblem("a@b", typos), "format");
    assert.equal(emailProblem("a b@c.com", typos), "format");
    assert.equal(emailProblem("a@gmial.com", typos), "typo");
    assert.equal(emailProblem("a@gmail.com", typos), null);
  });
});

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
