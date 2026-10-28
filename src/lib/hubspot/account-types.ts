// HubSpot account types in plain words, for the report and the playbook.
export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  DEVELOPER_TEST: "Developer test portal",
  SANDBOX: "Sandbox",
  STANDARD: "Standard portal",
  APP_DEVELOPER: "App developer account",
};

export const accountTypeLabel = (accountType: string) => ACCOUNT_TYPE_LABELS[accountType] ?? accountType;
