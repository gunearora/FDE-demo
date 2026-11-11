namespace com.gr.automation;

entity DeliveryNotes {
  key ID              : UUID;
  fileName            : String(255);
  uploadedAt          : Timestamp @cds.on.insert: $now;
  status              : String(20) default 'UPLOADED';
  // Status flow: UPLOADED -> EXTRACTED -> MATCHED -> POSTED
  deliveryNumber      : String(50);
  supplierName        : String(255);
  deliveryDate        : String(50);
  rawText             : LargeString;
  items               : Composition of many ExtractedItems on items.deliveryNote = $self;
}

entity ExtractedItems {
  key ID              : UUID;
  deliveryNote        : Association to DeliveryNotes;
  lineNo              : Integer;
  poNumber            : String(20);
  poItem              : String(5) default '00010';
  material            : String(40);
  description         : String(255);
  deliveredQty        : Decimal(13,3);
  unit                : String(10);
  plant               : String(50);
  storageLocation     : String(10) default '0001';

  // Populated after S/4HANA match
  s4Material          : String(40);
  s4OpenQty           : Decimal(13,3);
  s4Unit              : String(10);
  s4Plant             : String(50);
  s4Matched           : Boolean default false;
  withinTolerance     : Boolean default false;
  tolerancePct        : Decimal(5,2) default 5;
  selected            : Boolean default true;

  // Populated after GR posting
  grDocumentNo        : String(20);
  grDocumentYear      : String(4);
  grPosted            : Boolean default false;
  grError             : String(500);
}
