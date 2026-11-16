using test_gr.db as db from '../db/schema';

service DeliveryService @(path: '/delivery') {

    // Expose staging entities
    entity DeliveryNotes     as projection on db.DeliveryNotes;
    entity DeliveryNoteItems as projection on db.DeliveryNoteItems;
    entity GoodsReceiptLog   as projection on db.GoodsReceiptLog;

    // Upload a PDF and extract data
    action uploadDeliveryNote(
        fileName    : String,
        fileContent : LargeString  // base64-encoded PDF
    ) returns {
        deliveryNoteId : UUID;
        status         : String;
        message        : String;
        items          : array of {
            lineNumber : Integer;
            poNumber   : String;
            poItem     : String;
            material   : String;
            quantity   : Decimal;
            uom        : String;
        };
    };

    // Match extracted items against S/4HANA POs
    action matchPurchaseOrders(
        deliveryNoteId : UUID
    ) returns {
        status  : String;
        message : String;
        items   : array of {
            itemId      : UUID;
            poNumber    : String;
            poItem      : String;
            material    : String;
            quantity    : Decimal;
            matchedQty  : Decimal;
            uom         : String;
            tolerancePct: Decimal;
            matchStatus : String;
        };
    };

    // Confirm selected items and post goods receipt
    action postGoodsReceipt(
        deliveryNoteId : UUID,
        selectedItems  : array of UUID
    ) returns {
        status      : String;
        grDocNumber : String;
        grYear      : String;
        message     : String;
    };
}
