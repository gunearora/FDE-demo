'use strict';

const cds = require('@sap/cds');
const log = cds.log('delivery-service');
const { extractFromPdf } = require('./lib/pdf-extractor');
const { getPurchaseOrder, postGoodsReceipt } = require('./lib/s4-connector');

const QTY_TOLERANCE_PCT = parseFloat(process.env.GR_QTY_TOLERANCE_PCT || '5');

module.exports = cds.service.impl(async function (srv) {
    const { DeliveryNotes, DeliveryNoteItems, GoodsReceiptLog } = srv.entities;

    // -------------------------------------------------------------------------
    // Action: uploadDeliveryNote
    // -------------------------------------------------------------------------
    srv.on('uploadDeliveryNote', async (req) => {
        const { fileName, fileContent } = req.data;

        if (!fileName || !fileContent) {
            return req.error(400, 'fileName and fileContent are required');
        }

        // Decode base64 PDF
        let pdfBuffer;
        try {
            pdfBuffer = Buffer.from(fileContent, 'base64');
        } catch (err) {
            return req.error(400, 'fileContent must be a base64-encoded PDF');
        }

        // Extract data from PDF
        let rawText, items;
        try {
            ({ rawText, items } = await extractFromPdf(pdfBuffer));
        } catch (err) {
            log.error('PDF extraction failed:', err.message);
            return req.error(422, `PDF extraction failed: ${err.message}`);
        }

        if (!items || items.length === 0) {
            return req.error(422, 'No PO line items found in the uploaded document');
        }

        // Persist to DB
        const noteId = cds.utils.uuid();
        await INSERT.into(DeliveryNotes).entries({
            ID: noteId,
            fileName,
            uploadedAt: new Date().toISOString(),
            status: 'PENDING',
            rawText
        });

        const noteItems = items.map(item => ({
            ID: cds.utils.uuid(),
            deliveryNote_ID: noteId,
            lineNumber: item.lineNumber,
            poNumber: item.poNumber,
            poItem: item.poItem,
            material: item.material,
            quantity: item.quantity,
            uom: item.uom,
            matchStatus: 'PENDING',
            selected: false
        }));

        await INSERT.into(DeliveryNoteItems).entries(noteItems);

        log.info(`Delivery note ${noteId} created with ${items.length} items`);

        return {
            deliveryNoteId: noteId,
            status: 'SUCCESS',
            message: `Extracted ${items.length} line item(s) from ${fileName}`,
            items
        };
    });

    // -------------------------------------------------------------------------
    // Action: matchPurchaseOrders
    // -------------------------------------------------------------------------
    srv.on('matchPurchaseOrders', async (req) => {
        const { deliveryNoteId } = req.data;

        const noteItems = await SELECT.from(DeliveryNoteItems)
            .where({ deliveryNote_ID: deliveryNoteId });

        if (!noteItems || noteItems.length === 0) {
            return req.error(404, `No items found for delivery note ${deliveryNoteId}`);
        }

        // Group by PO number to minimise S/4HANA calls
        const poGroups = {};
        for (const item of noteItems) {
            if (!poGroups[item.poNumber]) poGroups[item.poNumber] = [];
            poGroups[item.poNumber].push(item);
        }

        const results = [];

        for (const [poNumber, poItems] of Object.entries(poGroups)) {
            let s4Data;
            try {
                s4Data = await getPurchaseOrder(poNumber);
            } catch (err) {
                log.warn(`PO ${poNumber} not found in S/4HANA: ${err.message}`);
                for (const item of poItems) {
                    await UPDATE(DeliveryNoteItems, item.ID)
                        .set({ matchStatus: 'NO_MATCH', tolerancePct: QTY_TOLERANCE_PCT });
                    results.push({ ...item, matchStatus: 'NO_MATCH', matchedQty: null });
                }
                continue;
            }

            for (const item of poItems) {
                const s4Item = (s4Data.items || []).find(
                    i => i.PurchaseOrderItem === item.poItem && i.Material === item.material
                );

                if (!s4Item) {
                    await UPDATE(DeliveryNoteItems, item.ID)
                        .set({ matchStatus: 'NO_MATCH', tolerancePct: QTY_TOLERANCE_PCT });
                    results.push({ itemId: item.ID, ...item, matchStatus: 'NO_MATCH', matchedQty: null });
                    continue;
                }

                const openQty = parseFloat(s4Item.OrderQuantity || s4Item.QuantityInPurchaseOrderUnit || 0);
                const delta = Math.abs(item.quantity - openQty) / (openQty || 1) * 100;
                const matchStatus = delta <= QTY_TOLERANCE_PCT ? 'MATCH' : 'WARNING';

                await UPDATE(DeliveryNoteItems, item.ID).set({
                    matchedQty: openQty,
                    tolerancePct: QTY_TOLERANCE_PCT,
                    matchStatus
                });

                results.push({
                    itemId: item.ID,
                    poNumber: item.poNumber,
                    poItem: item.poItem,
                    material: item.material,
                    quantity: item.quantity,
                    matchedQty: openQty,
                    uom: item.uom,
                    tolerancePct: QTY_TOLERANCE_PCT,
                    matchStatus
                });
            }
        }

        await UPDATE(DeliveryNotes, deliveryNoteId).set({ status: 'MATCHED' });

        return {
            status: 'SUCCESS',
            message: `Matched ${results.length} item(s)`,
            items: results
        };
    });

    // -------------------------------------------------------------------------
    // Action: postGoodsReceipt
    // -------------------------------------------------------------------------
    srv.on('postGoodsReceipt', async (req) => {
        const { deliveryNoteId, selectedItems } = req.data;

        if (!selectedItems || selectedItems.length === 0) {
            return req.error(400, 'No items selected for goods receipt');
        }

        const items = await SELECT.from(DeliveryNoteItems)
            .where({ ID: { in: selectedItems } });

        if (items.length === 0) {
            return req.error(404, 'Selected items not found');
        }

        const today = new Date().toISOString().slice(0, 10);
        const grPayload = items.map(i => ({
            poNumber: i.poNumber,
            poItem: i.poItem,
            material: i.material,
            quantity: i.quantity,
            uom: i.uom
        }));

        let grDocNumber, grYear;
        try {
            ({ grDocNumber, grYear } = await postGoodsReceipt(grPayload, today));
        } catch (err) {
            log.error('GR posting failed:', err.message);
            await UPDATE(DeliveryNotes, deliveryNoteId).set({ status: 'ERROR', errorMessage: err.message });
            return req.error(500, `Goods receipt posting failed: ${err.message}`);
        }

        // Update items with GR document
        for (const item of items) {
            await UPDATE(DeliveryNoteItems, item.ID).set({ grDocNumber, grYear, selected: true });
        }

        // Log GR
        await INSERT.into(GoodsReceiptLog).entries({
            ID: cds.utils.uuid(),
            deliveryNote_ID: deliveryNoteId,
            grDocNumber,
            grYear,
            postedAt: new Date().toISOString(),
            postedBy: req.user?.id || 'anonymous',
            itemCount: items.length,
            status: 'SUCCESS',
            message: `GR ${grDocNumber}/${grYear} posted for ${items.length} item(s)`
        });

        await UPDATE(DeliveryNotes, deliveryNoteId).set({ status: 'POSTED' });

        log.info(`GR ${grDocNumber}/${grYear} posted successfully`);

        return {
            status: 'SUCCESS',
            grDocNumber,
            grYear,
            message: `Goods receipt ${grDocNumber}/${grYear} created for ${items.length} item(s)`
        };
    });
});
