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
  segments: {
    emptyMinAgeDays: number;
    filterBatchSize: number;
    maxPropertyLookups: number;
  };
  duplicates: {
    sharedPhoneMin: number;
    largeOrgMin: number;
    blockMax: number;
    maxGroupSize: number;
    typoMinLength: number;
    freeEmailDomains: string[];
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
  segments: {
    // Segments younger than this may still be filling up, so they aren't
    // reported as empty.
    emptyMinAgeDays: 30,
    // Segment IDs per call when reading filter definitions.
    filterBatchSize: 100,
    // Properties named in segment filters but missing from the property
    // list are looked up one by one (archived, sensitive or gone), up to
    // this many names. The rest are reported as not verified.
    maxPropertyLookups: 25,
  },
  duplicates: {
    // A phone number on this many contacts in the window is a shared line
    // (a switchboard or a household), so it isn't a duplicate signal.
    sharedPhoneMin: 5,
    // A company name, email domain or company shared by this many contacts
    // is a large organization: matching it alone can't make a match High.
    largeOrgMin: 25,
    // Groups of records sharing a key are compared pair by pair up to this
    // size; larger ones only compare records with similar names.
    blockMax: 50,
    // Duplicate groups larger than this are reported as separate pairs.
    maxGroupSize: 10,
    // Names shorter than this only match exactly or as nicknames, not as typos.
    typoMinLength: 5,
    // Free and internet-provider email domains: people at different
    // organizations share them, so they aren't a duplicate signal.
    freeEmailDomains: [
      "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.ca", "yahoo.fr", "yahoo.de", "ymail.com",
      "rocketmail.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "outlook.com", "live.com", "msn.com",
      "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de",
      "gmx.net", "web.de", "mail.com", "yandex.com", "yandex.ru", "mail.ru", "zoho.com", "qq.com", "163.com",
      "126.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net", "charter.net",
      "btinternet.com", "sky.com", "virginmedia.com", "orange.fr", "free.fr", "t-online.de", "shaw.ca",
      "rogers.com", "bigpond.com", "optusnet.com.au", "fastmail.com", "hey.com", "tutanota.com",
    ],
  },
};
