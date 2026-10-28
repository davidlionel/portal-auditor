# Portal Health Auditor

A web app that connects to a HubSpot portal with a read-only service key, scans it for data and configuration problems, and returns a health score with a ranked fix list.

**Status:** early build. The app runs property and record checks on contacts, companies and deals.

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

Each finding shows a severity, a count, up to 10 samples (property names, or record IDs linked to HubSpot), why it matters and how to fix it. Sensitive and highly sensitive properties are not audited.

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

Unit tests run each property check against hand-built fixtures, with no HubSpot key or network. They use Node's built-in test runner through [tsx](https://tsx.is). They cover known false positives that must stay unflagged (Japanese / Javanese dropdown options, "Region 1" / "Region 2" labels), the cases that must be caught (Webinar / webinar), and the 30-day age rule for fill rate. Each check takes an optional config, so tests can try other thresholds without changing the ones the app uses.

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
- **Record checks** (missing lifecycle stage, missing email, Customer with no won deal, companies with no contacts, deals missing amount or close date, stale deals): one search each. The same call returns the total and up to 10 sample record IDs.

Duplicate and email checks need field values, so they read a **window of the most recently created records**: up to 10,000 contacts and 10,000 companies (200 per call), requesting only the fields they compare. Records are grouped by a normalized key in one pass, not compared pair by pair. Field values stay in server memory during the scan; the report shows record IDs only.

Search calls run one at a time, at least 250ms apart, to stay under HubSpot's limit of 5 search requests per second per account. Each report shows the number of API calls and the scan time.

**Estimated calls for a 250K-contact portal** (30K companies, 15K deals, 300 custom properties):

| Part | Calls |
|---|---|
| Account details and property lists | 4 |
| Record totals and fill rates | about 303 |
| Record count checks | 7 |
| Contact and company windows (10,000 ÷ 200 each) | 100 |
| **Total** | **about 414**, roughly 1 minute 45 seconds of paced search |

The window keeps duplicate checks at a fixed cost, so a portal with 1 million contacts still uses 50 calls for them.

## What the record checks can miss

- **Duplicates outside the window.** In a 250K-contact portal the window is the newest 4% of contacts, so a duplicate is only found when both records are recent. The report states the coverage on every scan. HubSpot's own duplicate tool (CRM > Contacts or Companies, ⋮ menu > Manage duplicates) scans the whole portal and is where duplicates should be merged.
- **Near-matches.** Contact duplicates match on exact first name, last name and company name after normalizing case and punctuation (names also ignore spaces, so O'Neil matches oneil) and dropping company suffixes like Inc or Ltd. Jon / John, nicknames, typos, and "Acme Corp" vs "Acme Holdings" aren't matched. Contacts with a blank name or company name aren't checked.
- **Subdomains.** `eu.acme.com` and `acme.com` count as different domains.
- **Won deals on the company only.** "Customer with no closed-won deal" only sees deals associated with the contact.
- **Email formats HubSpot already rejects.** Most bad formats never get in, so the malformed check mostly finds typo domains from a fixed list.
- **Stale deals on lower tiers.** The check uses HubSpot's "date entered current stage" property; if the portal doesn't have it, the check is skipped with a note.
- **Not yet checked:** contacts sharing only a phone number, and free-text fields that should be dropdowns.
