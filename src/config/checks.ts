export type ChecksConfig = {
  sampleCap: number;
  searchMinIntervalMs: number;
  fillRate: {
    nearZeroThreshold: number;
    minAgeDays: number;
  };
  duplicateLabels: {
    nearMinLength: number;
    nearMaxDistance: number;
  };
  records: {
    recordWindow: number;
    workListCap: number;
    staleDealDays: number;
    typoDomains: string[];
  };
};

// Thresholds for the audit checks. The reasoning for each value lives in
// the project's decision log, not here. Checks take this as a default, so
// tests can pass their own config without changing the real rules.
export const CHECKS_CONFIG: ChecksConfig = {
  sampleCap: 10,
  searchMinIntervalMs: 250,
  fillRate: {
    // A custom property filled on fewer than this share of records is "near-zero".
    nearZeroThreshold: 0.01,
    // Properties younger than this haven't had time to be filled.
    minAgeDays: 30,
  },
  duplicateLabels: {
    // Edit distance only applies to labels at least this long.
    nearMinLength: 8,
    nearMaxDistance: 2,
  },
  records: {
    // Row-level checks (duplicates, malformed email) read only this many of
    // the most recently created records per object. 10,000 is the Search
    // API's ceiling for one query.
    recordWindow: 10_000,
    // Record IDs per check in the work-list export. Count checks page
    // through matching records up to this many (200 per call).
    workListCap: 1_000,
    // An open deal with no stage change for this long is stale.
    staleDealDays: 30,
    // Valid-looking email domains that are almost always typos.
    typoDomains: [
      "gmial.com",
      "gmai.com",
      "gnail.com",
      "gmail.co",
      "gmail.con",
      "hotmial.com",
      "hotmai.com",
      "hotmail.co",
      "yaho.com",
      "yahoo.co",
      "outlok.com",
      "outllook.com",
      "iclod.com",
    ],
  },
};
