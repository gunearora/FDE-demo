# GR Automation – Delivery Notes / Shipping Notices Processing

An SAP BTP CAP application that automates Goods Receipt (GR) posting in S/4HANA by extracting line items from supplier delivery notes (PDF), matching them against open Purchase Orders, and posting GR documents via the S/4HANA OData API.

---

## Features

- **PDF Upload** – Drag & drop or browse to upload a delivery note / shipping notice PDF
- **Data Extraction** – Extracts PO number, line items, materials, quantities, plant and storage location from the PDF
- **S/4HANA Match** – Matches extracted items against open PO lines in S/4HANA (DED system via CF Destination `DED_HTTP_200`)
- **Tolerance Check** – Configurable quantity tolerance (%) to flag over/under deliveries
- **GR Posting** – Posts selected line items as Goods Receipt documents (movement type 101) in S/4HANA
- **Mock Mode** – Predefined test data for demos without a live PDF or S/4HANA connection

---

## Architecture

```
Browser (UI)
    │
    ▼
CAP Node.js Backend (my-btp-app-srv)
    │   ├── /api/upload-pdf       — PDF upload (multer)
    │   ├── /api/delivery/extractData   — PDF parsing + DB insert
    │   ├── /api/delivery/matchWithS4   — S/4HANA PO lookup
    │   └── /api/delivery/postGoodsReceipt — GR posting
    │
    ├── HANA Cloud (HDI container) — stores DeliveryNotes + ExtractedItems
    └── S/4HANA DED (via CF Destination DED_HTTP_200)
            ├── API_PURCHASEORDER_PROCESS_SRV  — PO item lookup
            └── API_MATERIAL_DOCUMENT_SRV      — GR posting
```

---

## Project Structure

```
├── app/webapp/         # Single-page UI (Bootstrap 5 + SAP Fiori styling)
├── srv/                # CAP service definition and handlers
│   ├── delivery-service.cds    # Service schema
│   ├── delivery-service.js     # Action handlers (extract, match, post)
│   └── lib/
│       ├── pdf-extractor.js    # PDF parsing + mock data
│       └── s4-connector.js     # S/4HANA OData calls
├── db/                 # CDS data model (DeliveryNotes, ExtractedItems)
├── approuter/          # SAP App Router for XSUAA authentication
├── mta.yaml            # MTA deployment descriptor for BTP
├── manifest.yml        # CF push manifest
└── xs-security.json    # XSUAA app security config
```

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | >= 20 | |
| `@sap/cds-dk` | >= 10 | `npm i -g @sap/cds-dk` |
| CF CLI v8 | v8+ | `cf8` |
| MBT | 1.2+ | `npm i -g mbt` |
| GNU make | any | Required by `mbt build` on Windows — install via BAS or `choco install make` |
| CF Multiapps plugin | 3.x | `cf8 install-plugin multiapps` |

---

## Local Development

```bash
git clone git@github.com:Deloitte-US-Consulting/FDE-GR-Automation-App.git
cd FDE-GR-Automation-App
npm install
cds watch
```

App runs at `http://localhost:4004`. Uses SQLite for local DB and mock S/4HANA data by default.

---

## Deploy to SAP BTP (Cloud Foundry)

### 1. Login and target your space
```bash
cf8 login -a https://api.cf.us10.hana.ondemand.com
cf8 target -o <your-org> -s <your-space>
```

### 2. Build the MTA archive
```bash
npm ci
mbt build
```
> On Windows, `mbt build` requires GNU `make`. Use SAP Business Application Studio or install make via Chocolatey (`choco install make`).

### 3. Deploy
```bash
cf8 deploy mta_archives/my-btp-app_1.0.0.mtar
```

This creates all required BTP services automatically:
- `my-btp-app-db` — HANA HDI container
- `my-btp-app-xsuaa` — XSUAA application security
- `my-btp-app-destination` — Destination service

### Required CF Destination
Create a destination named `DED_HTTP_200` in the BTP Destination service pointing to your S/4HANA system with BasicAuthentication credentials.

---

## Mock Data

The app always uses predefined mock PO data regardless of the uploaded PDF:

| Field | Line 1 | Line 2 |
|-------|--------|--------|
| PO Number | 4500292223 | 4500292223 |
| PO Item | 00010 | 00020 |
| Material | DAUTO813 | DAUTO814 |
| Qty / Unit | 1 EA | 1 EA |
| Plant | 1106 | 1106 |

To change mock data, edit `srv/lib/pdf-extractor.js` → `mockExtraction()`.

---

## BTP Services Used

| Service | Plan | Purpose |
|---------|------|---------|
| `hana` (HDI) | hdi-shared | HANA Cloud database |
| `xsuaa` | application | Authentication |
| `destination` | lite | S/4HANA connectivity |
| `connectivity` | lite | On-premise connectivity |
