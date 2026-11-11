# BTP Development – Guardrails & Environment

## CF CLI Note
The CF CLI v8 is installed as **`cf8`** (not `cf`) at:
`C:\Users\gunearora\AppData\Roaming\Cloud Foundry\cf8.exe`

Always use `cf8` for all Cloud Foundry commands.

## Target Environment
| Setting | Value |
|---------|-------|
| Region  | us10  |
| Org     | org_pocus |
| Space   | POC   |
| API     | https://api.cf.us10.hana.ondemand.com |

## Guardrails

1. **Target lock** – Only work in org `org_pocus`, space `POC`. Never run `cf8 target` to switch to a different org or space.

2. **No destructive service commands without approval** – Never run `cf8 delete`, `cf8 delete-service`, or `cf8 undeploy` without explicitly asking the user first and receiving confirmation.

3. **Show deploy command before running** – Always show the full `cf8 deploy` command to the user and wait for approval before executing it.

4. **No secrets in files** – Never ask for, print, or store passwords, service keys, client secrets, or any credentials in files. Use environment variables or CF service bindings instead.

5. **Local vs BTP database** – Use **SQLite** for local development and testing. Use **HANA Cloud** (hdi-shared HDI containers via the `hana` broker) when deploying to BTP.

## Installed Tools

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | v24.15.0 | |
| npm | 11.12.1 | |
| CF CLI | v8 (cf8.exe) | Installed at `C:\Users\gunearora\AppData\Roaming\Cloud Foundry\` |
| `@sap/cds-dk` (cds) | 10.2.1 | |
| `mbt` | 1.2.51 | Cloud MTA Build Tool |
| CF multiapps plugin | 3.12.0 | Adds `cf8 deploy`, `cf8 undeploy`, `cf8 mtas` commands |

## Available Services (Marketplace – org_pocus / space POC)

| Service | Plans | Status |
|---------|-------|--------|
| `hana-cloud` | hana-td, relational-data-lake-td, hana-cloud-connection-td | Available + instances exist |
| `hana` (HDI) | hdi-shared, sbss, schema, securestore | Available + instances exist |
| `xsuaa` | application, space, broker, apiaccess | Available + instances exist |
| `html5-apps-repo` | app-host, app-runtime | Available + instances exist |
| `destination` | lite | Available + instances exist |
| `connectivity` | lite, connectivity_proxy | Available + instances exist |
| `sdm` | standard | Document Management Service – available |
| Document AI | — | Not found in this marketplace |
