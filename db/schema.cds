namespace test_gr.db;

using { cuid, managed } from '@sap/cds/common';

// Staging table for PDF-extracted data
entity DeliveryNotes : cuid, managed {
    fileName        : String(255);
    uploadedAt      : Timestamp;
    status          : String(20) default 'PENDING'; // PENDING, MATCHED, POSTED, ERROR
    rawText         : LargeString;
    errorMessage    : String(500);
    items           : Composition of many DeliveryNoteItems on items.deliveryNote = $self;
}

entity DeliveryNoteItems : cuid {
    deliveryNote    : Association to DeliveryNotes;
    lineNumber      : Integer;
    poNumber        : String(10);
    poItem          : String(5);
    material        : String(40);
    quantity        : Decimal(13,3);
    uom             : String(3);
    // S/4HANA matched data
    matchedQty      : Decimal(13,3);
    tolerancePct    : Decimal(5,2);
    matchStatus     : String(20); // MATCH, WARNING, NO_MATCH
    // GR posting result
    grDocNumber     : String(10);
    grYear          : String(4);
    selected        : Boolean default false;
}

// Goods Receipt log
entity GoodsReceiptLog : cuid, managed {
    deliveryNote    : Association to DeliveryNotes;
    grDocNumber     : String(10);
    grYear          : String(4);
    postedAt        : Timestamp;
    postedBy        : String(255);
    itemCount       : Integer;
    status          : String(20); // SUCCESS, PARTIAL, FAILED
    message         : String(500);
}
