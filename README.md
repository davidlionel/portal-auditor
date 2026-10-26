# Portal Health Auditor

A web app that connects to a HubSpot portal with a read-only service key, scans it for data and configuration problems, and returns a health score with a ranked fix list.

**Status:** early build. The app runs four property checks on contacts, companies and deals:

- Custom properties with no description
- Custom properties filled on under 1% of records
- Duplicate or near-duplicate property labels
- Dropdown options on custom properties that differ only by case, spacing or punctuation, or are singular/plural of each other

Each finding shows a severity, a count, up to 10 sample property names, why it matters and how to fix it. Sensitive and highly sensitive properties are not audited.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000 and paste a service key from a HubSpot **developer test portal**. Don't use real client data.

## Why a service key

HubSpot recommends service keys for single-account API access, and legacy private apps no longer get new scopes or features. Create one in HubSpot under **Development > Keys > Service keys** and tick only the scopes in the table below. Service keys work for REST API calls only, which is all this app makes.

## Key handling

The service key is sent to the server for a single request, used to call HubSpot, and discarded. It is not stored in a cookie, database or log, and it is never returned to the browser.

## Scopes to tick on the service key

| Scope | Used for | Why |
|---|---|---|
| `crm.schemas.contacts.read`, `crm.schemas.companies.read`, `crm.schemas.deals.read` | `GET /crm/properties/2026-09/{object}` | List property definitions: labels, descriptions, dropdown options |
| `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read` | `POST /crm/objects/2026-09/{object}/search` | Count records that fill each custom property. Only totals are read |
| none listed in HubSpot's docs | `GET /account-info/2026-09/details` | Confirms which portal is connected (Hub ID, account type, data center) |

Every scope is read-only. If one is missing, the scan skips that object or check and says so in the report.

## API usage

Fill rates are counted with the CRM Search API (`HAS_PROPERTY` filter, page size 1), so no records are downloaded. That costs one search call per custom property, plus one per object for the total. Search calls run one at a time, at least 250ms apart, to stay under HubSpot's limit of 5 search requests per second per account. Each report shows the number of API calls and the scan time.
