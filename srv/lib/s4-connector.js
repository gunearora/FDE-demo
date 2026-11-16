'use strict';

const cds = require('@sap/cds');
const log = cds.log('s4-connector');

const DESTINATION = 'DED_HTTP_200';

/**
 * Returns an HTTP client bound to the DED_HTTP_200 BTP destination.
 */
async function getDestinationClient() {
    const { getDestination } = cds.env.requires?.['btp-destination']
        ? require('@sap-cloud-sdk/connectivity')
        : { getDestination: null };

    if (getDestination) {
        const dest = await getDestination({ destinationName: DESTINATION });
        return dest;
    }
    // Fallback: use CAP's built-in remote service connectivity
    return null;
}

/**
 * Fetch Purchase Order header + items from S/4HANA.
 * @param {string} poNumber
 * @returns {Promise<Object>} PO data
 */
async function getPurchaseOrder(poNumber) {
    try {
        const po = await cds.connect.to(DESTINATION);
        const { A_PurchaseOrder, A_PurchaseOrderItem } = po.entities('API_PURCHASEORDER_PROCESS_SRV');

        const header = await po.run(
            SELECT.one.from(A_PurchaseOrder)
                .where({ PurchaseOrder: poNumber })
        );

        const items = await po.run(
            SELECT.from(A_PurchaseOrderItem)
                .where({ PurchaseOrder: poNumber })
                .columns('PurchaseOrder', 'PurchaseOrderItem', 'Material',
                    'OrderQuantity', 'PurchaseOrderQuantityUnit',
                    'QuantityInPurchaseOrderUnit')
        );

        return { header, items };
    } catch (err) {
        log.error('Error fetching PO from S/4HANA:', err.message);
        throw err;
    }
}

/**
 * Post a goods receipt (movement type 101) to S/4HANA.
 * Uses the GOODSMOVT OData API.
 * @param {Array} grItems  - Array of { poNumber, poItem, material, quantity, uom }
 * @param {string} postingDate
 * @returns {Promise<{ grDocNumber: string, grYear: string }>}
 */
async function postGoodsReceipt(grItems, postingDate) {
    try {
        const s4 = await cds.connect.to(DESTINATION);

        // Build MIGO-style OData payload for API_GOODSMOVEMENT_SRV
        const payload = {
            GoodsMovementCode: '01',          // Goods Receipt for PO
            DocumentDate: postingDate,
            PostingDate: postingDate,
            to_GoodsMovementItem: grItems.map((item, idx) => ({
                GoodsMovementItemNumber: String(idx + 1).padStart(4, '0'),
                GoodsMovementType: '101',
                PurchaseOrder: item.poNumber,
                PurchaseOrderItem: item.poItem.padStart(5, '0'),
                Material: item.material,
                Quantity: String(item.quantity),
                QuantityUnit: item.uom,
                StorageLocation: item.storageLocation || '0001',
                Plant: item.plant || '1000'
            }))
        };

        const { A_GoodsMovement } = s4.entities('API_GOODSMOVEMENT_SRV');
        const result = await s4.run(INSERT.into(A_GoodsMovement).entries(payload));

        const grDocNumber = result?.MaterialDocumentYear
            ? result.MaterialDocument
            : (result?.d?.MaterialDocument || 'SIMULATED');
        const grYear = result?.MaterialDocumentYear || new Date().getFullYear().toString();

        log.info(`GR posted: ${grDocNumber}/${grYear}`);
        return { grDocNumber, grYear };
    } catch (err) {
        log.error('Error posting GR to S/4HANA:', err.message);
        throw err;
    }
}

module.exports = { getPurchaseOrder, postGoodsReceipt };
