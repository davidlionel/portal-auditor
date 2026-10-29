import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  additionalDomains,
  companyNameKey,
  deletionVariants,
  domainLabel,
  emailDomain,
  hashKey,
  isNickname,
  oneTypoApart,
  phoneKey,
  rootDomain,
} from "@/lib/dedupe/keys";

describe("phoneKey", () => {
  it("keeps the last 10 digits, whatever the formatting", () => {
    assert.equal(phoneKey("+1 (415) 555-0142"), "4155550142");
    assert.equal(phoneKey("415.555.0142"), "4155550142");
    assert.equal(phoneKey("+44 20 7946 0958"), "2079460958");
  });

  it("ignores numbers too short to compare", () => {
    assert.equal(phoneKey("555-0142"), "");
    assert.equal(phoneKey(null), "");
  });
});

describe("domains", () => {
  it("takes an email's domain", () => {
    assert.equal(emailDomain("Ana@Example.COM"), "example.com");
    assert.equal(emailDomain("no-at-sign"), "");
  });

  it("finds the root domain with the Public Suffix List", () => {
    assert.equal(rootDomain("eu.acme.com"), "acme.com");
    assert.equal(rootDomain("acme.co.uk"), "acme.co.uk");
    assert.equal(rootDomain("shop.acme.com.au"), "acme.com.au");
    // Each shop on a hosting platform is its own domain.
    assert.notEqual(rootDomain("one.myshopify.com"), rootDomain("two.myshopify.com"));
    assert.equal(domainLabel("acme.co.uk"), "acme");
  });

  it("splits additional domains", () => {
    assert.deepEqual(additionalDomains("acme.io; www.Acme.net ;"), ["acme.io", "acme.net"]);
    assert.deepEqual(additionalDomains(null), []);
  });

  it("cleans company names", () => {
    assert.equal(companyNameKey("The Smith & Sons Co."), "smith and sons");
    assert.equal(companyNameKey("Acme, Inc."), "acme");
  });
});

describe("names", () => {
  it("knows nicknames, in either direction", () => {
    assert.ok(isNickname("bob", "robert"));
    assert.ok(isNickname("robert", "bob"));
    assert.ok(isNickname("jon", "john"));
    assert.ok(isNickname("chris", "christina"));
    assert.ok(!isNickname("christopher", "christina"), "both short for Chris, but different names");
    assert.ok(!isNickname("john", "john"));
  });

  it("finds names exactly one typo apart", () => {
    assert.ok(oneTypoApart("jhon", "john"), "swapped letters");
    assert.ok(oneTypoApart("micheal", "michael"));
    assert.ok(oneTypoApart("stephen", "stephan"), "changed letter");
    assert.ok(oneTypoApart("johnson", "jonson"), "dropped letter");
    assert.ok(!oneTypoApart("smith", "smyth2"));
    assert.ok(!oneTypoApart("anna", "anna"));
  });

  it("buckets one-typo names together through deletion variants", () => {
    for (const [a, b] of [["jhon", "john"], ["stephen", "stephan"], ["johnson", "jonson"]]) {
      const shared = deletionVariants(a).filter((v) => deletionVariants(b).includes(v));
      assert.ok(shared.length > 0, `${a} / ${b}`);
    }
  });
});

describe("hashKey", () => {
  it("is 0 only for empty values and the same for equal ones", () => {
    assert.equal(hashKey(""), 0);
    assert.equal(hashKey("acme.com"), hashKey("acme.com"));
    assert.notEqual(hashKey("acme.com"), hashKey("acme.co"));
    assert.ok(Number.isSafeInteger(hashKey("x")) && hashKey("x") > 0);
  });
});
