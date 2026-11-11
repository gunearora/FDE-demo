'use strict';

/**
 * S/4HANA connector via CF Destination DED_HTTP_200.
 *
 * On BTP: uses @sap-cloud-sdk executeHttpRequest → picks up Destination Service
 *         binding automatically from VCAP_SERVICES.
 *
 * Local dev: set env var MOCK_S4=true to return synthetic data so you can
 *            work without a live S/4 connection.
 */

const DESTINATION = 'DED_HTTP_200';
const PO_SRV     = '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV';
const MATDOC_SRV = '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV';

// Extract the human-readable error detail from an Axios/SDK error response.
// SAP OData v2: top-level message is generic; real detail is in innererror.errordetails[].
function s4ErrorMessage(err) {
  const d = err.response?.data;
  const top = d?.error?.message?.value || d?.message || null;

  // Collect all inner error messages (severity=error|warning)
  const details = (d?.error?.innererror?.errordetails || [])
    .filter(e => e.message)
    .map(e => e.message);

  const combined = details.length
    ? details.join('; ')
    : (top || (typeof d === 'string' ? d.slice(0, 300) : null));

  return combined ? `${err.message} — S/4: ${combined}` : err.message;
}

// ---- Lazy SDK import (SDK is not needed in mock mode) ----------------------
let executeHttpRequest, getDestination;
function getSDK() {
  if (!executeHttpRequest) {
    ({ executeHttpRequest } = require('@sap-cloud-sdk/http-client'));
    ({ getDestination } = require('@sap-cloud-sdk/connectivity'));
  }
  return executeHttpRequest;
}

// ---- Mock data for local development ---------------------------------------
function mockPOItems(poNumber) {
  return [
    {
      PurchaseOrder:            poNumber,
      PurchaseOrderItem:        '00010',
      Material:                 'TEST264LLR-C_FG_P',
      OrderQuantity:            '1.000',
      PurchaseOrderQuantityUnit:'EA',
      Plant:                    'JP10',
      StorageLocation:          '0001',
    },
  ];
}

function mockGRResult(items) {
  return items.map((item, idx) => ({
    id: item.id,
    poNumber: item.poNumber,
    poItem: item.poItem,
    material: item.material,
    plant: item.plant,
    grDocumentNo: `4900${String(Date.now()).slice(-6)}${idx}`,
    grDocumentYear: new Date().getFullYear().toString(),
    success: true,
    message: 'Mock GR posted successfully',
  }));
}

// ---- Real S/4HANA calls ----------------------------------------------------

async function fetchPOItems(poNumber, jwt) {
  const exec = getSDK();

  // getDestination resolves credentials; pass the full dest object so the SDK
  // builds Authorization internally from dest.username/password.
  // Do NOT set Authorization in custom headers — it takes higher merge priority
  // than the SDK-generated header and causes a conflict.
  const dest = await getDestination({ destinationName: DESTINATION, jwt });

  const filter = `$filter=PurchaseOrder%20eq%20%27${encodeURIComponent(poNumber)}%27`;
  const select = `$select=PurchaseOrder,PurchaseOrderItem,Material,PurchaseOrderItemText,OrderQuantity,PurchaseOrderQuantityUnit,Plant,StorageLocation`;
  const format = `$format=json`;
  const url    = `${PO_SRV}/A_PurchaseOrderItem?${filter}&${select}&${format}`;

  const resp = await exec(dest, { method: 'GET', url, headers: { 'Accept': 'application/json', 'sap-client': '200' } });
  return resp.data?.d?.results ?? [];
}

async function fetchCSRFToken(jwt) {
  const exec = getSDK();
  const resp = await exec(
    { destinationName: DESTINATION, jwt },
    {
      method: 'GET',
      url: `${MATDOC_SRV}/$metadata?sap-client=200`,
      headers: { 'X-CSRF-Token': 'Fetch', 'sap-client': '200' },
    }
  );
  const token  = resp.headers['x-csrf-token'];
  const cookie = Array.isArray(resp.headers['set-cookie'])
    ? resp.headers['set-cookie'].join('; ')
    : (resp.headers['set-cookie'] || '');
  console.log(`[s4] CSRF token=${token ? token.slice(0,8)+'...' : 'MISSING'} cookie=${cookie ? cookie.slice(0,40)+'...' : 'MISSING'}`);
  if (!token) throw new Error('Could not obtain CSRF token from S/4HANA');
  return { token, cookie };
}

function toODataDate(d) {
  return `/Date(${d.getTime()})/`;
}

async function postGRDocument(items, jwt) {
  const exec = getSDK();
  const { token, cookie } = await fetchCSRFToken(jwt);

  const now = new Date();
  const payload = {
    DocumentDate:      toODataDate(now),
    PostingDate:       toODataDate(now),
    GoodsMovementCode: '01',
    to_MaterialDocumentItem: {
      results: items.map(item => ({
        GoodsMovementType:       '101',
        GoodsMovementRefDocType: 'B',
        PurchaseOrder:           item.poNumber,
        PurchaseOrderItem:       String(parseInt(item.poItem || '10', 10)),
        Material:                item.s4Material || item.material,
        QuantityInEntryUnit:     String(item.deliveredQty),
        EntryUnit:               item.s4Unit || item.unit || 'EA',
        Plant:                   item.s4Plant || item.plant,
        StorageLocation:         item.storageLocation || '0001',
      })),
    },
  };

  console.log(`[s4] GR POST payload=${JSON.stringify(payload).slice(0,300)}`);
  let resp;
  try {
    // fetchCsrfToken: false — we fetched manually above; SDK default (true) would
    // do an extra GET and inject Accept: application/json, causing 406 on this endpoint.
    resp = await exec(
      { destinationName: DESTINATION, jwt },
      {
        method: 'POST',
        url: `${MATDOC_SRV}/A_MaterialDocumentHeader?sap-client=200`,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          'Cookie':       cookie,
          'sap-client':   '200',
        },
        data: payload,
      },
      { fetchCsrfToken: false }
    );
  } catch (e) {
    console.log(`[s4] GR POST failed status=${e.response?.status} body=${JSON.stringify(e.response?.data).slice(0,1000)}`);
    throw e;
  }

  // S/4 OData v2 may return Atom XML or JSON depending on system version.
  // Extract MaterialDocument and MaterialDocumentYear from whichever format arrives.
  let grDocumentNo, grDocumentYear;
  if (resp.data && typeof resp.data === 'object') {
    grDocumentNo   = resp.data?.d?.MaterialDocument;
    grDocumentYear = resp.data?.d?.MaterialDocumentYear;
  } else if (typeof resp.data === 'string') {
    grDocumentNo   = resp.data.match(/<d:MaterialDocument>(.*?)<\/d:MaterialDocument>/)?.[1]
                  || resp.data.match(/MaterialDocument['"]\s*[>:]\s*['"]?(\d+)/)?.[1];
    grDocumentYear = resp.data.match(/<d:MaterialDocumentYear>(.*?)<\/d:MaterialDocumentYear>/)?.[1]
                  || new Date().getFullYear().toString();
  }
  return {
    grDocumentNo:   grDocumentNo  || '',
    grDocumentYear: grDocumentYear || new Date().getFullYear().toString(),
  };
}

// ---- Public API ------------------------------------------------------------

async function getPurchaseOrderItems(poNumber, jwt) {
  if (process.env.MOCK_S4 === 'true') return mockPOItems(poNumber);
  return fetchPOItems(poNumber, jwt);
}

async function postGoodsReceipt(items, jwt) {
  if (process.env.MOCK_S4 === 'true') return mockGRResult(items);

  // S/4HANA accepts one material document per call; post each selected item
  // as a separate document (one GR document per PO is the common pattern).
  // Group by PO number so each PO gets one GR document.
  const byPO = {};
  for (const item of items) {
    if (!byPO[item.poNumber]) byPO[item.poNumber] = [];
    byPO[item.poNumber].push(item);
  }

  const results = [];
  for (const [poNumber, poItems] of Object.entries(byPO)) {
    try {
      const { grDocumentNo, grDocumentYear } = await postGRDocument(poItems, jwt);
      for (const item of poItems) {
        results.push({
          id:            item.id,
          poNumber,
          poItem:        item.poItem,
          material:      item.s4Material || item.material,
          plant:         item.plant || item.s4Plant,
          grDocumentNo,
          grDocumentYear,
          success:       true,
          message:       `GR document ${grDocumentNo} posted`,
        });
      }
    } catch (err) {
      const message = s4ErrorMessage(err);
      for (const item of poItems) {
        results.push({
          id:            item.id,
          poNumber,
          poItem:        item.poItem,
          material:      item.material,
          plant:         item.plant,
          grDocumentNo:  '',
          grDocumentYear:'',
          success:       false,
          message,
        });
      }
    }
  }
  return results;
}

module.exports = { getPurchaseOrderItems, postGoodsReceipt };
