# CLAUDE.md — test_gr

## Project Overview
**test_gr** is an SAP Cloud Application Programming (CAP) application that automates goods receipt creation by extracting purchase order data from delivery notes (PDF), matching it against S/4HANA purchase orders, and posting movement type 101 goods receipt documents.

## Application Flow
1. User uploads a PDF delivery note or shipping notice
2. App extracts: PO Number, PO Item, Material, Quantity, Unit of Measure
3. App queries S/4HANA via BTP destination `DED_HTTP_200` to match PO line items
4. Quantity tolerance is applied; matched items are listed for user review
5. User selects confirmed PO line items
6. App posts goods receipt (movement type 101) to S/4HANA BAPI/OData

## Tech Stack
- **Backend**: SAP CAP (Node.js)
- **Frontend**: SAPUI5 / Fiori Elements
- **BTP Services**: Destination Service, XSUAA
- **S/4HANA Integration**: OData V2/V4 via destination `DED_HTTP_200`
- **PDF Extraction**: pdf-parse npm library + Claude AI (via Anthropic SDK)
- **Deployment Target**: SAP BTP Cloud Foundry (BAIP landscape)

## Key Files
| File | Purpose |
|------|---------|
| `db/schema.cds` | Data model for staging extracted PDF data |
| `srv/delivery-service.cds` | Service definition exposing entities and actions |
| `srv/delivery-service.js` | Business logic: PDF extraction, PO matching, GR posting |
| `app/webapp/` | SAPUI5 frontend |
| `mta.yaml` | Multi-target application deployment descriptor |
| `xs-security.json` | XSUAA security configuration |

## BTP Destination
- **Name**: `DED_HTTP_200`
- **Type**: HTTP
- **Purpose**: Connects to S/4HANA system for PO lookup and GR posting

## S/4HANA APIs Used
- `API_PURCHASEORDER_PROCESS_SRV` — Read purchase orders and items
- `API_GOODSMOVEMENT_SRV` or `BAPI_GOODSMVT_CREATE` via RFC — Post GR movement type 101

## Quantity Tolerance
- Default tolerance: ±5% (configurable via environment variable `GR_QTY_TOLERANCE_PCT`)
- Items within tolerance are shown as "Match"; outside as "Warning"

## Development Commands
```bash
# Install dependencies
npm install

# Start local development server
cds watch

# Deploy to BTP
mbt build
cf deploy mta_archives/test_gr_1.0.0.mtar

# Run tests
npm test
```

## Git & GitHub
- **Repository**: `https://github.com/Deloitte-US-Consulting/test_gr`
- **Branch strategy**: `main` (production), `develop` (integration), feature branches

## Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `GR_QTY_TOLERANCE_PCT` | Quantity tolerance percentage | `5` |
| `ANTHROPIC_API_KEY` | Claude API key for PDF extraction fallback | — |

## Coding Conventions
- Use async/await throughout service handlers
- Log with `cds.log` — never `console.log` in production code
- All S/4HANA calls go through the `connectToS4` helper in `srv/lib/s4-connector.js`
- Error responses follow CAP error format: `{ error: { code, message } }`
