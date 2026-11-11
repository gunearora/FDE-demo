'use strict';
const cds = require('@sap/cds');
const { extractFromPDF } = require('./lib/pdf-extractor');
const { getPurchaseOrderItems, postGoodsReceipt } = require('./lib/s4-connector');

module.exports = cds.service.impl(async function (srv) {

  // --------------------------------------------------------------------------
  // ACTION: extractData
  // --------------------------------------------------------------------------
  srv.on('extractData', async (req) => {
    const { deliveryNoteId, useMock } = req.data;
    const db = await cds.connect.to('db');
    const { DeliveryNotes: DN, ExtractedItems: EI } = cds.entities('com.gr.automation');

    const note = await db.run(SELECT.one.from(DN).where({ ID: deliveryNoteId }));
    if (!note) return req.error(404, `Delivery note ${deliveryNoteId} not found`);
    if (!note.rawText) return req.error(400, 'No PDF content found for this delivery note');

    const pdfBuffer = Buffer.from(note.rawText, 'base64');
    const extracted = await extractFromPDF(pdfBuffer, useMock === true);

    // Clear any previously extracted items for idempotent re-runs
    await db.run(DELETE.from(EI).where({ deliveryNote_ID: deliveryNoteId }));

    if (extracted.items.length > 0) {
      await db.run(
        INSERT.into(EI).entries(
          extracted.items.map((item) => ({
            ID:              cds.utils.uuid(),
            deliveryNote_ID: deliveryNoteId,
            lineNo:          item.lineNo,
            poNumber:        item.poNumber,
            poItem:          item.poItem || '00010',
            material:        item.material,
            description:     item.description,
            deliveredQty:    item.deliveredQty,
            unit:            item.unit,
            plant:           item.plant,
            storageLocation: item.storageLocation || '0001',
          }))
        )
      );
    }

    await db.run(
      UPDATE(DN)
        .set({
          deliveryNumber: extracted.deliveryNumber,
          supplierName:   extracted.supplierName,
          deliveryDate:   extracted.deliveryDate,
          rawText:        extracted.rawText,
          status:         'EXTRACTED',
        })
        .where({ ID: deliveryNoteId })
    );

    return {
      deliveryNoteId,
      deliveryNumber: extracted.deliveryNumber,
      supplierName:   extracted.supplierName,
      deliveryDate:   extracted.deliveryDate,
      itemCount:      extracted.items.length,
      rawSnippet:     extracted.rawSnippet,
    };
  });

  // --------------------------------------------------------------------------
  // ACTION: matchWithS4
  // --------------------------------------------------------------------------
  srv.on('matchWithS4', async (req) => {
    const { deliveryNoteId, tolerancePct = 5 } = req.data;
    const db = await cds.connect.to('db');
    const { ExtractedItems: EI } = cds.entities('com.gr.automation');

    const items = await db.run(SELECT.from(EI).where({ deliveryNote_ID: deliveryNoteId }).orderBy('lineNo asc'));
    if (!items.length) return req.error(404, 'No extracted items found. Run extractData first.');

    const jwt = req.headers?.authorization?.split(' ')[1];
    const results = [];
    const s4Cache = {};  // cache per PO to avoid duplicate S/4 calls

    // Normalize PO item to 5-digit padded string for comparison (S/4 may return '10' or '00010')
    const normItem = v => String(parseInt(v || '0', 10)).padStart(5, '0');

    for (const item of items) {
      if (!item.poNumber) {
        results.push({ ...item, s4Matched: false, withinTolerance: false, diffPct: null });
        continue;
      }

      if (!s4Cache[item.poNumber]) {
        try {
          s4Cache[item.poNumber] = await getPurchaseOrderItems(item.poNumber, jwt);
        } catch (err) {
          req.warn(`Could not reach S/4 for PO ${item.poNumber}: ${err.message}`);
          s4Cache[item.poNumber] = [];
        }
      }
      const s4Items = s4Cache[item.poNumber];

      const s4Item = s4Items.find(s => normItem(s.PurchaseOrderItem) === normItem(item.poItem));
      const s4Matched      = !!s4Item;
      const s4OpenQty      = s4Item ? parseFloat(s4Item.OrderQuantity) : null;
      const s4Material     = s4Item?.Material || null;
      const s4Plant        = s4Item?.Plant    || null;
      const s4Unit         = s4Item?.PurchaseOrderQuantityUnit || null;
      let withinTolerance  = false;
      let diffPct          = null;

      if (s4Matched && s4OpenQty !== null && s4OpenQty > 0) {
        diffPct = Math.abs((item.deliveredQty - s4OpenQty) / s4OpenQty) * 100;
        withinTolerance = diffPct <= (tolerancePct || 5);
      }

      await db.run(
        UPDATE(EI)
          .set({ s4Material, s4OpenQty, s4Unit, s4Plant, s4Matched, withinTolerance,
                 tolerancePct: tolerancePct || 5,
                 poItem: s4Item?.PurchaseOrderItem || item.poItem })
          .where({ ID: item.ID })
      );

      results.push({
        id:              item.ID,
        lineNo:          item.lineNo,
        poNumber:        item.poNumber,
        poItem:          s4Item?.PurchaseOrderItem || item.poItem,
        material:        item.material,
        deliveredQty:    item.deliveredQty,
        unit:            item.unit || s4Unit,
        plant:           item.plant || s4Plant,
        s4OpenQty,
        s4Material,
        s4Plant,
        s4Matched,
        withinTolerance,
        diffPct: diffPct !== null ? Math.round(diffPct * 100) / 100 : null,
      });
    }

    const { DeliveryNotes: DN } = cds.entities('com.gr.automation');
    await db.run(UPDATE(DN).set({ status: 'MATCHED' }).where({ ID: deliveryNoteId }));
    return results;
  });

  // --------------------------------------------------------------------------
  // ACTION: postGoodsReceipt
  // --------------------------------------------------------------------------
  srv.on('postGoodsReceipt', async (req) => {
    const { deliveryNoteId, selectedIds } = req.data;
    const db = await cds.connect.to('db');
    const { ExtractedItems: EI } = cds.entities('com.gr.automation');

    if (!selectedIds || selectedIds.length === 0)
      return req.error(400, 'No items selected for GR posting');

    const items    = await db.run(SELECT.from(EI).where({ deliveryNote_ID: deliveryNoteId, s4Matched: true }));
    const selected = items.filter(i => selectedIds.includes(i.ID));
    if (!selected.length) return req.error(404, 'No matched items found for the selected IDs');

    const jwt = req.headers?.authorization?.split(' ')[1];
    const grResults = await postGoodsReceipt(selected, jwt);

    for (const r of grResults) {
      await db.run(
        UPDATE(EI)
          .set({ grDocumentNo: r.grDocumentNo, grDocumentYear: r.grDocumentYear,
                 grPosted: r.success, grError: r.success ? null : r.message })
          .where({ ID: r.id })
      );
    }

    const { DeliveryNotes: DN } = cds.entities('com.gr.automation');
    if (grResults.every(r => r.success))
      await db.run(UPDATE(DN).set({ status: 'POSTED' }).where({ ID: deliveryNoteId }));

    return grResults;
  });
});
