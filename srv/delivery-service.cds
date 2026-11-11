using com.gr.automation as db from '../db/schema';

service DeliveryService @(path: '/api/delivery') {

  // ---- Projections --------------------------------------------------------
  entity DeliveryNotes  as projection on db.DeliveryNotes
    excluding { rawText };

  entity ExtractedItems as projection on db.ExtractedItems;

  // ---- Actions ------------------------------------------------------------

  /**
   * Step 2 – Parse PDF text and populate ExtractedItems.
   * The actual PDF bytes arrive via the custom /api/upload-pdf REST route
   * (see delivery-service.js bootstrap); this action is called after upload
   * to trigger extraction on an already-persisted DeliveryNote record.
   */
  action extractData(deliveryNoteId : UUID, useMock : Boolean) returns {
    deliveryNoteId : UUID;
    deliveryNumber : String;
    supplierName   : String;
    deliveryDate   : String;
    itemCount      : Integer;
    rawSnippet     : String;
  };

  /**
   * Step 3 – Match extracted PO items against DED S/4HANA via DED_HTTP_200.
   * tolerancePct defaults to 5 (%).
   */
  action matchWithS4(deliveryNoteId : UUID, tolerancePct : Decimal(5,2)) returns array of {
    id              : UUID;
    lineNo          : Integer;
    poNumber        : String;
    poItem          : String;
    material        : String;
    deliveredQty    : Decimal;
    unit            : String;
    plant           : String;
    s4OpenQty       : Decimal;
    s4Material      : String;
    s4Plant         : String;
    s4Matched       : Boolean;
    withinTolerance : Boolean;
    diffPct         : Decimal;
  };

  /**
   * Step 4 – Post Goods Receipt (movement type 101) for selected items.
   * selectedIds is the list of ExtractedItem IDs the user confirmed.
   */
  action postGoodsReceipt(deliveryNoteId : UUID, selectedIds : array of UUID) returns array of {
    id            : UUID;
    poNumber      : String;
    poItem        : String;
    material      : String;
    plant         : String;
    grDocumentNo  : String;
    grDocumentYear: String;
    success       : Boolean;
    message       : String;
  };
}
