# Portal Health Auditor

A web app that connects to a HubSpot portal with a read-only service key, scans it for data and configuration problems, and returns a health score with a ranked fix list.

**Status:** early build. The app runs property and record checks on contacts, companies and deals, scores the portal out of 100, lists the top 5 fixes, and exports CSVs.

**Properties**
- Custom properties with no description
- Custom properties filled on under 1% of records
- Duplicate or near-duplicate property labels
- Dropdown options on custom properties that differ only by case, spacing or punctuation, or are singular/plural of each other

**Contacts**
- Missing lifecycle stage
- Lifecycle stage Customer with no closed-won deal
- Missing email
- Malformed or mistyped email (e.g. `gmial.com`)
- Likely duplicates: same first name, last name and company name

**Companies**
- Duplicate domains
- Companies with no associated contacts

**Deals**
- Open or won deals with no amount
- Open deals with no close date
- Open deals with no stage change in 30+ days

Each finding shows a severity, a count, its rate (how many of the records or properties checked were affected), the points fixing it would add to the score, up to 10 samples (property names, or record IDs linked to HubSpot), why it matters and how to fix it. Sensitive and highly sensitive properties are not audited.

## Health score

The report opens with a score out of 100, a score for each category, and the top 5 fixes.

- **Each check scores by rate, not count.** Rate = records (or properties) affected ÷ records (or properties) checked. A check scores 100 at 0% and loses points in a straight line until it reaches 0 at 10% for high-severity checks, 25% for medium and 50% for low. Because it's a rate, a 250,000-contact portal isn't marked down for being big: 2% of contacts missing an email scores the same at any size.
- **What each rate is measured against.** All contacts or companies for presence checks; Customers for "Customer with no closed-won deal"; open deals for missing close date and stale deals; open or won deals for missing amount; the recent-records window for duplicate and email checks; custom properties for property checks. Duplicate checks count records in duplicate groups, so a group of six weighs more than a pair.
- **Categories** average their checks, weighting high, medium and low severity 3:2:1. **The overall score** weights Contacts 35, Deals 25, Companies 20 and Properties 20. Automation (lists and workflows) isn't checked yet, so it isn't scored.
- **Skipped checks don't count.** A check that can't run (a missing scope, a property the portal doesn't have, no records yet) is left out, its weight is shared among the checks that ran, and the report lists it as not scored.
- **Top 5 fixes** are ranked by points recovered: how much the overall score would rise if that problem were fixed.

All weights and zero-points live in `src/config/scoring.ts`. The one-line explanation on the report is built from that file, so it always matches.

## Exports

Two CSV downloads, built in the browser from the report on the page. Nothing is sent to the server or stored.

- **Findings summary:** one row per finding with check, object, category, severity, count, records affected, population, rate, points recovered, why it matters and how to fix it.
- **Records work list:** one file per object with record ID, object type, check, severity, duplicate group, HubSpot record link and a capped marker. Record IDs only: no names, emails or other field values. Records in the same duplicate group share a group number.

Count checks page through the matching records during the scan, 200 per call, up to 1,000 per check (`records.workListCap` in `src/config/checks.ts`). When a check matches more, its rows say "first 1,000 of N" and the report notes it. The service key is discarded after the scan, so IDs can't be fetched later. Duplicate and email checks use the IDs already read from the recent-records window.

## Using the work list in HubSpot

HubSpot can import the work list by Record ID to find or tag these records. Imports write to the portal, unlike the auditor, so try it on a test portal first. Steps, per HubSpot's [import guide](https://knowledge.hubspot.com/import-and-export/import-records-for-a-single-object):

1. Go to **Data Management > Data Integration** and start an import, or click **Import** on the contacts, companies or deals index page. Import one object's file at a time.
2. Map the **Record ID** column to the **Record ID** property. Record ID takes priority over other identifiers such as email or domain.
3. Choose **Update existing records only**, so rows that don't match an existing record are ignored and nothing new is created.
4. Set columns you don't want written to **Don't import**.
5. Then either:
   - **Contacts:** on the final step, tick **Create a contact segment** to get a segment (list) of exactly these contacts.
   - **Any object:** first create a single-line text property such as "Cleanup reason", then map the Check column to it during the import. Then filter a view or build a segment on that property.

Remove the property or segment when the cleanup is done.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000 and paste a service key from a HubSpot **developer test portal**. Don't use real client data.

## Tests

```bash
npm test
```

Unit tests run each check, the scoring and the CSV exports against hand-built fixtures, with no HubSpot key or network. They use Node's built-in test runner through [tsx](https://tsx.is). They cover known false positives that must stay unflagged (Japanese / Javanese dropdown options, "Region 1" / "Region 2" labels), the cases that must be caught (Webinar / webinar), and the 30-day age rule for fill rate. Each check takes an optional config, so tests can try other thresholds without changing the ones the app uses.

## Why a service key

HubSpot recommends service keys for single-account API access, and legacy private apps no longer get new scopes or features. Create one in HubSpot under **Development > Keys > Service keys** and tick only the scopes in the table below. Service keys work for REST API calls only, which is all this app makes.

## Key handling

The service key is sent to the server for a single request, used to call HubSpot, and discarded. It is not stored in a cookie, database or log, and it is never returned to the browser.

## Scopes to tick on the service key

| Scope | Used for | Why |
|---|---|---|
| `crm.schemas.contacts.read`, `crm.schemas.companies.read`, `crm.schemas.deals.read` | `GET /crm/properties/2026-09/{object}` | List property definitions: labels, descriptions, dropdown options |
| `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read` | `POST /crm/objects/2026-09/{object}/search` | Count records for fill rates and record checks; read name, company, email and domain on recent records for duplicate and email checks |
| none listed in HubSpot's docs | `GET /account-info/2026-09/details` | Confirms which portal is connected (Hub ID, account type, data center) |

Every scope is read-only. If one is missing, the scan skips that object or check and says so in the report.

## API usage

Everything that is a count uses the CRM Search API's `total`, so no records are downloaded to count them:

- **Fill rate:** one search per custom property (`HAS_PROPERTY`, page size 1), plus one per object for the total.
- **Record checks** (missing lifecycle stage, missing email, Customer with no won deal, companies with no contacts, deals missing amount or close date, stale deals): one search each returns the total, the first 10 IDs as samples, and up to 200 IDs for the work list. Checks with more matches page on, up to 1,000 IDs (5 calls).
- **Populations** for the score: the object totals above, plus one search each for Customers, open deals, and open or won deals.

Duplicate and email checks need field values, so they read a **window of the most recently created records**: up to 10,000 contacts and 10,000 companies (200 per call), requesting only the fields they compare. Records are grouped by a normalized key in one pass, not compared pair by pair. Field values stay in server memory during the scan; the report shows record IDs only.

Search calls run one at a time, at least 250ms apart, to stay under HubSpot's limit of 5 search requests per second per account. Each report shows the number of API calls and the scan time.

**Estimated calls for a 250K-contact portal** (30K companies, 15K deals, 300 custom properties):

| Part | Calls |
|---|---|
| Account details and property lists | 4 |
| Record totals and fill rates | about 303 |
| Record count checks, including work-list paging (7 checks × up to 5 calls) | up to 35 |
| Score populations (Customers, open deals, open or won deals) | 3 |
| Contact and company windows (10,000 ÷ 200 each) | 100 |
| **Total** | **about 445**, roughly 1 minute 50 seconds of paced search |

The window keeps duplicate checks at a fixed cost, so a portal with 1 million contacts still uses 50 calls for them.

## What the record checks can miss

- **Duplicates outside the window.** In a 250K-contact portal the window is the newest 4% of contacts, so a duplicate is only found when both records are recent. The report states the coverage on every scan. HubSpot's own duplicate tool (CRM > Contacts or Companies, ⋮ menu > Manage duplicates) scans the whole portal and is where duplicates should be merged.
- **Near-matches.** Contact duplicates match on exact first name, last name and company name after normalizing case and punctuation (names also ignore spaces, so O'Neil matches oneil) and dropping company suffixes like Inc or Ltd. Jon / John, nicknames, typos, and "Acme Corp" vs "Acme Holdings" aren't matched. Contacts with a blank name or company name aren't checked.
- **Subdomains.** `eu.acme.com` and `acme.com` count as different domains.
- **Won deals on the company only.** "Customer with no closed-won deal" only sees deals associated with the contact.
- **Recently closed deals.** HubSpot updates a contact's deal close date, and its search index, a short while after a deal closes, so a deal won in the last few minutes can still show its contact under "Customer with no closed-won deal".
- **Email formats HubSpot already rejects.** Most bad formats never get in, so the malformed check mostly finds typo domains from a fixed list.
- **Stale deals on lower tiers.** The check uses HubSpot's "date entered current stage" property; if the portal doesn't have it, the check is skipped with a note.
- **Not yet checked:** contacts sharing only a phone number, and free-text fields that should be dropdowns.
