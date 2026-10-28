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
};
