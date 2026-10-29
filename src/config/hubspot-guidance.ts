// Every HubSpot instruction the playbook prints (menu paths, property and
// filter names, fix steps), each tied to the HubSpot page that backs it.
//
// - `text` is what the playbook prints. "{object}" becomes Contacts,
//   Companies or Deals.
// - `keyPhrases` are short, verbatim extracts from the source page. The
//   weekly docs check (`npm run check:hubspot-docs`) fetches every source and
//   opens a GitHub issue when a page moves or a phrase disappears.
// - `lastVerified` is the date someone last read the page and confirmed the
//   text. `npm test` warns when it is over 90 days old.
// - `general: true` marks advice HubSpot's docs don't cover. The playbook
//   labels it "General guidance" and it has no source.

export type GuidanceEntry = {
  text: string;
  lastVerified: string;
} & ({ source: string; keyPhrases: string[]; general?: never } | { general: true; source?: never; keyPhrases?: never });

const KB = "https://knowledge.hubspot.com";
const VIEWS = `${KB}/records/view-and-filter-records`;
const CRITERIA = `${KB}/segments/determine-filter-criteria`;
const CONTACT_PROPS = `${KB}/properties/hubspots-default-contact-properties`;
const COMPANY_PROPS = `${KB}/properties/hubspot-crm-default-company-properties`;
const DEAL_PROPS = `${KB}/properties/hubspots-default-deal-properties`;
const BULK = `${KB}/records/bulk-edit-records`;
const DUPLICATES = `${KB}/records/manage-duplicate-records`;
const ASSOCIATE = `${KB}/records/associate-records`;
const EDIT_PROPERTIES = `${KB}/properties/create-and-edit-properties`;
const ARCHIVE = `${KB}/properties/organize-and-export-properties`;
const OPTIONS = `${KB}/properties/manage-enumeration-property-options`;
const WORKFLOW_EDIT = `${KB}/workflows/edit-records-using-workflows`;
const AUTO_ASSOCIATE = `${KB}/object-settings/automatically-create-and-associate-companies-with-contacts`;
const PIPELINES = `${KB}/object-settings/set-up-and-customize-pipelines`;
const IMPORT = `${KB}/import-and-export/import-records-for-a-single-object`;
const FIELD_TYPES = `${KB}/properties/property-field-types-in-hubspot`;
const MERGE = `${KB}/records/merge-records`;
const LIFECYCLE = `${KB}/records/use-lifecycle-stages`;

export const GUIDANCE = {
  // Finding records on an index page.
  openIndex: {
    text: "In HubSpot, click More, then go to CRM > {object} (if More isn't there, go to CRM > {object} directly) and click the table view icon.",
    source: VIEWS,
    keyPhrases: ["If More doesn't appear in your account", "table view icon"],
    lastVerified: "2026-10-28",
  },
  advancedFilters: {
    text: "Click Advanced filters, then Add filter, and add each condition below to the same filter group, so a record must match all of them.",
    source: VIEWS,
    keyPhrases: ["click Advanced filters to set filters using the object's properties", "Click Add filter to add a filter"],
    lastVerified: "2026-10-28",
  },
  saveView: {
    text: "Click Save to keep the filters as a saved view. The view stays current, so it empties as records are fixed.",
    source: VIEWS,
    keyPhrases: ["click Save to save your filters as a saved view tab"],
    lastVerified: "2026-10-28",
  },
  ownerFilter: {
    text: "To split the work by rep, add a Deal owner condition to the filter, or save one view per owner.",
    source: DEAL_PROPS,
    keyPhrases: ["Deal owner: the user the deal is assigned to"],
    lastVerified: "2026-10-28",
  },
  contactOwnerFilter: {
    text: "Add a Contact owner condition, or save one view per owner, so each owner sees only their own contacts.",
    source: CONTACT_PROPS,
    keyPhrases: ["Contact owner: the contact's owner"],
    lastVerified: "2026-10-28",
  },
  companyOwnerFilter: {
    text: "Add an Owner condition (the company's owner), or save one view per owner, so each owner sees only their own companies.",
    source: COMPANY_PROPS,
    keyPhrases: ["Owner: the company's owner"],
    lastVerified: "2026-10-28",
  },

  // Fixing records in bulk.
  bulkEdit: {
    text: "Select the records, then click Edit to set one property on all of them at once.",
    source: BULK,
    keyPhrases: ["Edit: select to edit the values of a specific property in these records"],
    lastVerified: "2026-10-28",
  },
  bulkDelete: {
    text: "To delete records nobody needs, select them, click Delete, enter the number of records and click Delete. This needs the Bulk delete permission.",
    source: BULK,
    keyPhrases: ["enter the number of records and click Delete", "Bulk delete permission"],
    lastVerified: "2026-10-28",
  },
  deleteContactsLastResort: {
    text: "Delete only as a last resort, for contacts whose email can't be found and that nobody needs: select them, click Delete, enter the number of records and click Delete. This needs the Bulk delete permission.",
    source: BULK,
    keyPhrases: ["enter the number of records and click Delete", "Bulk delete permission"],
    lastVerified: "2026-10-28",
  },
  findMissingEmail: {
    text: "Before deleting anything, look for each contact's email in the system it came from (the form, import file or integration that created it), or ask the contact's owner, and add it to the record.",
    general: true,
    lastVerified: "2026-10-28",
  },
  bulkEditLifecycleBackward: {
    text: "If a contact isn't really a customer, move it back to the right stage: select the contacts, click Edit, choose Lifecycle stage, pick the stage (such as Lead) and click Update. Bulk edit can move a stage backward (tested in a HubSpot portal on 29 Oct 2026).",
    general: true,
    lastVerified: "2026-10-29",
  },
  lifecycleBackward: {
    text: "Imports, workflows and the API only move Lifecycle stage forward. To set an earlier stage with one of them, clear the value first.",
    source: LIFECYCLE,
    keyPhrases: [
      "can only be moved forward by HubSpot tools",
      "You must clear the value manually or via a workflow before using these tools to set an earlier value",
    ],
    lastVerified: "2026-10-28",
  },
  associateContacts: {
    text: "To link the company's contacts, open the company and, in the right sidebar, click + Add in the Contacts association card.",
    source: ASSOCIATE,
    keyPhrases: ["In the right sidebar, click +Add [object] in that object's association card"],
    lastVerified: "2026-10-28",
  },
  associateDeal: {
    text: "To link the won deal, open the contact and, in the right sidebar, click + Add in the Deals association card.",
    source: ASSOCIATE,
    keyPhrases: ["In the right sidebar, click +Add [object] in that object's association card"],
    lastVerified: "2026-10-28",
  },
  reviewStaleDeal: {
    text: "Review each deal with its owner, one at a time: move it forward to the stage it's really at, close it as lost, or update its close date. Don't change deal stages in bulk; each deal needs its owner's judgment.",
    general: true,
    lastVerified: "2026-10-28",
  },
  fixEachEmail: {
    text: "Open each contact in the imported segment and correct the address. Most are one-letter domain typos (gmial.com is almost always gmail.com); if you can't tell the right address, ask the contact's owner.",
    general: true,
    lastVerified: "2026-10-28",
  },

  // Duplicates.
  duplicatesTool: {
    text: "On the {object} index page, click the three vertical dots icon in the upper right and select Manage duplicates. Or go to Data Management > Data Quality and click the Manage Duplicates tab.",
    source: DUPLICATES,
    keyPhrases: ["three vertical dots icon, then select Manage duplicates", "Click the Manage Duplicates tab"],
    lastVerified: "2026-10-28",
  },
  mergeRecords: {
    text: "Review each pair and click Merge only when they are the same. Merged records cannot be reverted.",
    source: DUPLICATES,
    keyPhrases: ["Merged records cannot be reverted"],
    lastVerified: "2026-10-28",
  },
  duplicatesPlan: {
    text: "Manage duplicates needs a Professional or Enterprise subscription. On Free and Starter portals, the health check's groups are your duplicate check: merge them from the record (next step). On higher plans, use each group's match signals and confidence alongside HubSpot's own list.",
    source: DUPLICATES,
    keyPhrases: ["A Professional or Enterprise subscription is required to manage individual duplicates"],
    lastVerified: "2026-10-28",
  },
  mergeFromRecord: {
    text: "To merge from the record (any plan): open one record in the group, in the left panel click the Actions dropdown and select Merge, search for and select the other record, and click Merge. Merged records can't be unmerged.",
    source: MERGE,
    keyPhrases: [
      "In the left panel, click the Actions dropdown menu, then select Merge",
      "search for and select the record to merge into the primary record",
      "it is not possible to unmerge them",
    ],
    lastVerified: "2026-10-28",
  },
  duplicateReviewView: {
    text: "Once the file is imported with its Cleanup reason column, click Advanced filters and add Cleanup reason contains any of the check name (the text after the date in the CSV's Cleanup reason). Each record's Cleanup reason ends with its group number: records with the same number are the possible duplicates.",
    source: CRITERIA,
    keyPhrases: ["contains any of: for Text properties, enter your text"],
    lastVerified: "2026-10-28",
  },
  confirmContactWithOwner: {
    text: "Each owner opens the records in a group and decides whether they are the same person. If they are, merge them (next step). If not, clear their Cleanup reason so they drop out of the view.",
    general: true,
    lastVerified: "2026-10-28",
  },
  confirmCompanyWithOwner: {
    text: "Each owner opens the records in a group and decides whether they are the same company. If they are, merge them (next step). If not, clear their Cleanup reason so they drop out of the view.",
    general: true,
    lastVerified: "2026-10-28",
  },

  // Properties.
  openProperty: {
    text: "Click the settings icon in the top navigation bar, go to Properties in the left sidebar, select {object} from the Select an object dropdown, then hover over each property listed below and click Edit.",
    source: EDIT_PROPERTIES,
    keyPhrases: ["click the settings icon in the top navigation bar. In the left sidebar menu, navigate to Properties"],
    lastVerified: "2026-10-28",
  },
  documentationTab: {
    text: "Open the Documentation tab and describe what the property holds and who fills it in.",
    source: EDIT_PROPERTIES,
    keyPhrases: ["Click the Documentation tab to add optional descriptive context"],
    lastVerified: "2026-10-28",
  },
  usagesTab: {
    text: "Open the Usages tab to see where the property is used before changing it (needs a Data Hub Professional or Enterprise subscription).",
    source: EDIT_PROPERTIES,
    keyPhrases: ["Usages: view where the property is being used in the CRM"],
    lastVerified: "2026-10-28",
  },
  archiveProperty: {
    text: "To retire a property, hover over it, click More, then Archive, review where it's used and click Archive property. Archived properties are permanently deleted after 90 days.",
    source: ARCHIVE,
    keyPhrases: ["click the More dropdown menu, then click Archive", "Click Archive property to confirm", "permanently deleted after 90 days"],
    lastVerified: "2026-10-28",
  },
  exportPropertyDefinition: {
    text: "To keep a record first, hover over the property, click More and select Export property definition.",
    source: ARCHIVE,
    keyPhrases: ["click More and select Export property definition"],
    lastVerified: "2026-10-28",
  },
  copyPropertyValues: {
    text: "If both properties hold data, copy the values into the one you keep with a workflow's Edit record action (click Choose data token to use the other property's value), then archive the other.",
    source: WORKFLOW_EDIT,
    keyPhrases: ["copy values from one property to another", "click Choose data token"],
    lastVerified: "2026-10-28",
  },
  mergeOptions: {
    text: "Click the Field type tab, select the options to combine and click Merge, then choose which option the others merge into. Records move to the kept option, but segments, workflows and filters using the old value don't; update those by hand.",
    source: OPTIONS,
    keyPhrases: ["Click the Field type tab", "Which option should others be merged into?", "Merging will not update any segments, workflows, or filters"],
    lastVerified: "2026-10-28",
  },

  // Preventing new problems.
  autoAssociate: {
    text: "To stop new empty companies: click the settings icon, then Data Management > Objects, select Companies and, in the Automation section, select Create and associate companies with contacts.",
    source: AUTO_ASSOCIATE,
    keyPhrases: ["in the Data Management section, click Objects", "In the Automation section, select the Create and associate companies with contacts checkbox"],
    lastVerified: "2026-10-28",
  },
  requiredAtStage: {
    text: "To require the property from a stage on: click the settings icon, then Data Management > Objects, select Deals, open the Pipelines tab and click the pipeline. In the stage's row, hover over Conditional logic rules, click Add rule, add the property under Dependent properties and select Required.",
    source: PIPELINES,
    keyPhrases: ["hover over the Conditional logic rules column and click Add rule", "In the Dependent properties section, click Add property", "Select the Required checkbox to require a property"],
    lastVerified: "2026-10-28",
  },

  // Property labels used in filters.
  lifecycleStage: {
    text: "Lifecycle stage",
    source: CONTACT_PROPS,
    keyPhrases: ["Lifecycle stage: a property used to indicate at what point the contact is"],
    lastVerified: "2026-10-28",
  },
  recentDealCloseDate: {
    text: "Recent deal close date",
    source: CONTACT_PROPS,
    keyPhrases: ["Recent deal close date: the date of the last associated deal that was closed as won"],
    lastVerified: "2026-10-28",
  },
  email: {
    text: "Email",
    source: CONTACT_PROPS,
    keyPhrases: ["Email: the contact's primary email address"],
    lastVerified: "2026-10-28",
  },
  numberOfAssociatedContacts: {
    text: "Number of associated contacts",
    source: COMPANY_PROPS,
    keyPhrases: ["Number of associated contacts: the number of contacts associated with the company"],
    lastVerified: "2026-10-28",
  },
  amount: {
    text: "Amount",
    source: DEAL_PROPS,
    keyPhrases: ["Amount: the total value of the deal"],
    lastVerified: "2026-10-28",
  },
  closeDate: {
    text: "Close date",
    source: DEAL_PROPS,
    keyPhrases: ["Close date: the day the deal is expected to close"],
    lastVerified: "2026-10-28",
  },
  dealStage: {
    text: "Deal stage",
    source: DEAL_PROPS,
    keyPhrases: ["Deal stage: deal stages allow you to categorize"],
    lastVerified: "2026-10-28",
  },
  dateEnteredCurrentStage: {
    text: "Date entered current stage",
    source: DEAL_PROPS,
    keyPhrases: ["Date entered current stage: the date the deal entered its current pipeline stage"],
    lastVerified: "2026-10-28",
  },
  closedStages: {
    text: "Closed won, Closed lost (and any other closed stages in your pipelines)",
    source: PIPELINES,
    keyPhrases: ["Closed won (100%, Won), Closed lost (0%, Lost)"],
    lastVerified: "2026-10-28",
  },
  closedLostStage: {
    text: "Closed lost (and any other lost stages in your pipelines)",
    source: PIPELINES,
    keyPhrases: ["Closed lost (0%, Lost)"],
    lastVerified: "2026-10-28",
  },

  // Filter operators.
  isUnknown: {
    text: "is unknown",
    source: CRITERIA,
    keyPhrases: ["is unknown: all records that do not have a value for the property will be included"],
    lastVerified: "2026-10-28",
  },
  isAnyOf: {
    text: "is any of",
    source: CRITERIA,
    keyPhrases: ["is any of: for Enumeration properties"],
    lastVerified: "2026-10-28",
  },
  isNoneOf: {
    text: "is none of",
    source: CRITERIA,
    keyPhrases: ["is none of: for Enumeration properties"],
    lastVerified: "2026-10-28",
  },
  // For numbers, "is equal to 0" also matches an empty value.
  isEqualTo: {
    text: "is equal to",
    source: CRITERIA,
    keyPhrases: ["an entered value of 0 is equal to a property value of 0, as well as to an empty property value"],
    lastVerified: "2026-10-28",
  },
  isMoreThan: {
    text: "is more than",
    source: CRITERIA,
    keyPhrases: ["is more than: for Date picker properties, enter a number, select a unit of time, then select ago"],
    lastVerified: "2026-10-28",
  },

  // Importing a file by Record ID (the playbook's appendix).
  importStart: {
    text: "Click More, then go to Data Management > Data Integration and start an import, or click Import in the upper right of the {object} index page. Import one object's file at a time.",
    source: IMPORT,
    keyPhrases: ["navigate to Data Management > Data Integration", "You can also click Import in the upper ri"],
    lastVerified: "2026-10-28",
  },
  importUpdateOnly: {
    text: "Choose Update existing records only, so rows that don't match a record are ignored and nothing new is created.",
    source: IMPORT,
    keyPhrases: ["Update existing [records/activities] only: the import will only update existing records"],
    lastVerified: "2026-10-28",
  },
  importRecordId: {
    text: "In the Record ID row, click the HubSpot Property dropdown and select Record ID. Record ID takes priority over other identifiers such as email or domain.",
    source: IMPORT,
    keyPhrases: ["in the Record ID row, click the HubSpot Property dropdown menu and select Record ID", "it'll supersede any other unique identifiers"],
    lastVerified: "2026-10-28",
  },
  importSkipColumns: {
    text: "For every other column you don't want written to HubSpot, open the Import As dropdown and select Don't import column.",
    source: IMPORT,
    keyPhrases: ["click the dropdown menu in the Import As column, then select Don't import column"],
    lastVerified: "2026-10-28",
  },
  importContactSegment: {
    text: "Contacts: on the final step, select Create a contact segment to get a segment of exactly these contacts.",
    source: IMPORT,
    keyPhrases: ["Create a contact segment: automatically create a segment of the imported contacts"],
    lastVerified: "2026-10-28",
  },
  importNewProperty: {
    text: "Companies and deals, and duplicate files for any object: map the Cleanup reason column with Create new property and name the property Cleanup reason.",
    source: IMPORT,
    keyPhrases: ["Create a custom property: click Create new property, then set up your property in the right panel"],
    lastVerified: "2026-10-28",
  },
  singleLineText: {
    text: "Give it the field type Single-line text, then filter a view on Cleanup reason to see these records.",
    source: FIELD_TYPES,
    keyPhrases: ["Single-line text: stores a single string of any alphanumeric characters"],
    lastVerified: "2026-10-28",
  },
} satisfies Record<string, GuidanceEntry>;

export type GuidanceId = keyof typeof GUIDANCE;

// One filter condition: a property, an operator and, when needed, a value.
// A value that is itself a guidance entry (stage names) is checked too.
export type FilterCondition = { property: GuidanceId; operator: GuidanceId; value?: string | GuidanceId };

export type CheckGuide = {
  // The filter that finds this check's records on the index page. Absent
  // for property checks and for checks no filter can express.
  filter?: FilterCondition[];
  // "none": the filter finds every record, so the playbook says "No CSV
  // needed". "import": use the finding's import file; the playbook points to
  // the import steps in its appendix and cites their sources. "property":
  // the properties are listed in the playbook.
  csv: "none" | "import" | "property";
  // The fix, in order.
  steps: GuidanceId[];
  // Steps that stop the problem coming back.
  prevent?: GuidanceId[];
};

const OPEN_DEALS: FilterCondition = { property: "dealStage", operator: "isNoneOf", value: "closedStages" };

// How to fix each check in HubSpot. Every check must have one; a unit test
// enforces it.
export const CHECK_GUIDES: Record<string, CheckGuide> = {
  "contacts.missing-lifecycle-stage": {
    filter: [{ property: "lifecycleStage", operator: "isUnknown" }],
    csv: "none",
    steps: ["openIndex", "advancedFilters", "saveView", "bulkEdit"],
  },
  "contacts.customer-without-won-deal": {
    filter: [
      { property: "lifecycleStage", operator: "isAnyOf", value: "Customer" },
      { property: "recentDealCloseDate", operator: "isUnknown" },
    ],
    csv: "none",
    steps: ["openIndex", "advancedFilters", "saveView", "associateDeal", "bulkEditLifecycleBackward", "lifecycleBackward"],
  },
  "contacts.missing-email": {
    filter: [{ property: "email", operator: "isUnknown" }],
    csv: "none",
    steps: ["openIndex", "advancedFilters", "saveView", "findMissingEmail", "deleteContactsLastResort"],
  },
  "contacts.malformed-email": {
    csv: "import",
    steps: ["fixEachEmail"],
  },
  // High: merge-ready, in HubSpot's duplicate tool or from the record.
  "contacts.duplicates-high": {
    csv: "import",
    steps: ["duplicatesTool", "duplicatesPlan", "mergeRecords", "mergeFromRecord"],
  },
  "companies.duplicates-high": {
    csv: "import",
    steps: ["duplicatesTool", "duplicatesPlan", "mergeRecords", "mergeFromRecord"],
  },
  // Medium and Low: each owner confirms before anything is merged.
  "contacts.duplicates-medium": { csv: "import", steps: ["openIndex", "duplicateReviewView", "contactOwnerFilter", "saveView", "confirmContactWithOwner", "mergeFromRecord"] },
  "contacts.duplicates-low": { csv: "import", steps: ["openIndex", "duplicateReviewView", "contactOwnerFilter", "saveView", "confirmContactWithOwner", "mergeFromRecord"] },
  "companies.duplicates-medium": { csv: "import", steps: ["openIndex", "duplicateReviewView", "companyOwnerFilter", "saveView", "confirmCompanyWithOwner", "mergeFromRecord"] },
  "companies.duplicates-low": { csv: "import", steps: ["openIndex", "duplicateReviewView", "companyOwnerFilter", "saveView", "confirmCompanyWithOwner", "mergeFromRecord"] },
  "companies.no-contacts": {
    filter: [{ property: "numberOfAssociatedContacts", operator: "isEqualTo", value: "0" }],
    csv: "none",
    steps: ["openIndex", "advancedFilters", "saveView", "associateContacts", "bulkDelete"],
    prevent: ["autoAssociate"],
  },
  "deals.missing-amount": {
    filter: [
      { property: "amount", operator: "isUnknown" },
      { property: "dealStage", operator: "isNoneOf", value: "closedLostStage" },
    ],
    csv: "none",
    steps: ["openIndex", "advancedFilters", "ownerFilter", "saveView", "bulkEdit"],
    prevent: ["requiredAtStage"],
  },
  "deals.missing-close-date": {
    filter: [{ property: "closeDate", operator: "isUnknown" }, OPEN_DEALS],
    csv: "none",
    steps: ["openIndex", "advancedFilters", "ownerFilter", "saveView", "bulkEdit"],
    prevent: ["requiredAtStage"],
  },
  "deals.stale": {
    filter: [{ property: "dateEnteredCurrentStage", operator: "isMoreThan", value: "{staleDealDays} days ago" }, OPEN_DEALS],
    csv: "none",
    // Never a bulk edit: moving deal stages en masse would hide the problem.
    steps: ["openIndex", "advancedFilters", "ownerFilter", "saveView", "reviewStaleDeal"],
  },
  "properties.no-description": {
    csv: "property",
    steps: ["openProperty", "documentationTab"],
  },
  "properties.near-zero-fill": {
    csv: "property",
    steps: ["openProperty", "usagesTab", "exportPropertyDefinition", "archiveProperty"],
  },
  "properties.duplicate-labels": {
    csv: "property",
    steps: ["openProperty", "usagesTab", "copyPropertyValues", "archiveProperty"],
  },
  "properties.near-duplicate-labels": {
    csv: "property",
    steps: ["openProperty", "usagesTab", "copyPropertyValues", "archiveProperty"],
  },
  "properties.dropdown-variants": {
    csv: "property",
    steps: ["openProperty", "mergeOptions"],
  },
  "properties.dropdown-plural-variants": {
    csv: "property",
    steps: ["openProperty", "mergeOptions"],
  },
};

// The appendix's import steps, in order. A group prints as one step.
export const IMPORT_STEPS: (GuidanceId | GuidanceId[])[] = [
  "importStart",
  "importUpdateOnly",
  "importRecordId",
  "importSkipColumns",
  "importContactSegment",
  ["importNewProperty", "singleLineText"],
];

// Every entry the import steps use.
export const IMPORT_STEP_IDS: GuidanceId[] = IMPORT_STEPS.flat();

export const isGuidanceId = (value: string): value is GuidanceId => value in GUIDANCE;
