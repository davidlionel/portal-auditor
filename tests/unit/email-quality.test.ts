import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkMalformedEmails } from "@/lib/checks/records/email-quality";
import { row } from "./fixtures";

const contact = (id: string, email: string | null) => row(id, { email });

describe("malformed email", () => {
  it("flags typo domains and badly formatted addresses", () => {
    const [finding] = checkMalformedEmails([
      contact("1", "ana@gmial.com"),
      contact("2", "lee@HOTMIAL.com"),
      contact("3", "no-at-sign.example.com"),
      contact("4", "name@company"),
      contact("5", "good@example.com"),
    ]);
    assert.equal(finding.checkId, "contacts.malformed-email");
    assert.equal(finding.count, 4);
    assert.deepEqual(finding.recordSamples, [["1"], ["2"], ["3"], ["4"]]);
  });

  it("does not flag valid unusual addresses", () => {
    assert.deepEqual(
      checkMalformedEmails([
        contact("1", "o'brien+tag@sub.example.co.uk"),
        contact("2", "first.last@gmail.com"),
        contact("3", "x@mail.gmail.co.uk"),
      ]),
      [],
    );
  });

  it("leaves contacts with no email to the missing-email check", () => {
    assert.deepEqual(checkMalformedEmails([contact("1", null), contact("2", "")]), []);
  });
});
