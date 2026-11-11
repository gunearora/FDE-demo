'use strict';

// pdf-parse: Node.js-native PDF text extraction (no web worker, no browser APIs)
let _pdfParse;
function getPdfParse() {
  if (!_pdfParse) _pdfParse = require('pdf-parse');
  return _pdfParse;
}

// pdf2json: returns text items with x/y positions, enabling column reconstruction
let _PDFParser;
function getPDFParser() {
  if (!_PDFParser) _PDFParser = require('pdf2json');
  return _PDFParser;
}

function extractWithPdf2json(buffer) {
  return new Promise((resolve, reject) => {
    const PDFParser = getPDFParser();
    const parser = new PDFParser();

    parser.on('pdfParser_dataError', (err) => {
      reject(new Error(String((err && err.parserError) || err)));
    });

    parser.on('pdfParser_dataReady', (pdfData) => {
      try {
        const lines = [];
        for (const page of (pdfData.Pages || [])) {
          if (!page.Texts || !page.Texts.length) continue;

          // Group text items by y-position (round to 1 decimal for tolerance)
          const lineMap = {};
          for (const item of page.Texts) {
            const y = Math.round(item.y * 10) / 10;
            if (!lineMap[y]) lineMap[y] = [];
            const text = decodeURIComponent(item.R.map(r => r.T || '').join(''));
            if (text.trim()) lineMap[y].push({ x: item.x, text });
          }

          // Sort lines top-to-bottom, items within each line left-to-right
          // In pdf2json, y increases downward from the top of the page
          const sortedYs = Object.keys(lineMap).map(Number).sort((a, b) => a - b);
          for (const y of sortedYs) {
            const items = lineMap[y].sort((a, b) => a.x - b.x);

            // Reconstruct line preserving column spacing.
            // pdf2json x units ≈ tenths of an inch; typical 10pt char ≈ 0.6 units wide.
            const CHAR_W = 0.6;
            let line = '';
            let prevEnd = null;
            for (const { x, text } of items) {
              if (prevEnd !== null) {
                const gap = x - prevEnd;
                if (gap > 0.3) {
                  line += ' '.repeat(Math.min(40, Math.max(1, Math.round(gap / CHAR_W))));
                } else if (gap > 0.05) {
                  line += ' ';
                }
              }
              line += text;
              prevEnd = x + text.length * CHAR_W;
            }
            if (line.trim()) lines.push(line);
          }
          lines.push(''); // page separator
        }
        resolve(lines.join('\n'));
      } catch (e) {
        reject(e);
      }
    });

    parser.parseBuffer(buffer);
  });
}

async function extractPDFText(buffer) {
  // Attempt 1: pdf-parse (best quality, fails on some PDFs due to strict tokenizer)
  try {
    const data = await getPdfParse()(buffer);
    if (data && data.text && data.text.trim()) return data.text;
  } catch (err) {
    console.warn('[pdf-extractor] pdf-parse failed:', err.message, '— trying pdf2json');
  }

  // Attempt 2: pdf2json — returns x/y positioned text, properly decompresses streams
  try {
    const text = await extractWithPdf2json(buffer);
    if (text && text.trim().length > 20) {
      console.log('[pdf-extractor] pdf2json succeeded');
      return text;
    }
  } catch (err) {
    console.warn('[pdf-extractor] pdf2json failed:', err.message, '— trying zlib stream scan');
  }

  // Attempt 3: manual zlib decompression — bypasses the XRef reader entirely by
  // scanning the binary for /Length-prefixed stream objects and decompressing them
  // with Node.js built-in zlib.  Extracts Tj/TJ text with line-break tracking.
  try {
    const text = extractFromCompressedStreams(buffer);
    if (text && text.trim().length > 20) {
      console.log('[pdf-extractor] zlib stream scan succeeded');
      return text;
    }
  } catch (err) {
    console.warn('[pdf-extractor] zlib stream scan failed:', err.message);
  }

  // Attempt 4: raw ASCII scan — last resort, works only for uncompressed PDFs
  console.warn('[pdf-extractor] using raw ASCII scan (last resort)');
  const raw = buffer.toString('latin1');
  const sequences = raw.match(/[ -~]{4,}/g) || [];
  const text = sequences.join('\n');
  if (!text.trim()) {
    throw new Error('PDF appears to be image-only or encrypted — no text content could be extracted');
  }
  return text;
}

// ============================================================
// Manual FlateDecode stream extractor (no XRef reader needed)
// ============================================================
function extractFromCompressedStreams(buffer) {
  const zlib = require('zlib');
  const str  = buffer.toString('binary'); // preserves every byte as latin-1
  const allLines = [];

  // Debug: count raw occurrences of key PDF markers
  const rawStreamCount = (str.match(/\bstream\b/g) || []).length;
  const rawEndstreamCount = (str.match(/\bendstream\b/g) || []).length;
  const rawFlateCount = (str.match(/FlateDecode/g) || []).length;
  console.log(`[pdf-extractor] raw binary: ${rawStreamCount} 'stream', ${rawEndstreamCount} 'endstream', ${rawFlateCount} 'FlateDecode', buffer size=${buffer.length}`);

  // Find stream start positions by scanning for the 'stream' keyword.
  // We do NOT rely on /Length because in PDF 1.5+ the length is often stored
  // inside a compressed object stream, making it unresolvable without a full
  // XRef parser.  Instead we find the matching 'endstream' marker.
  const streamKeyRe = /\bstream\r?\n/g;
  let sk;
  let streamsFound = 0;
  let streamsDecoded = 0;

  // Also try without word boundary in case binary bytes prevent \b from firing
  const streamIndexFallback = (() => {
    const positions = [];
    let p = 0;
    while (true) {
      const i = str.indexOf('stream\n', p);
      const j = str.indexOf('stream\r\n', p);
      const next = (i === -1 ? Infinity : i) < (j === -1 ? Infinity : j) ? i : j;
      if (next === Infinity || next === -1) break;
      positions.push(next);
      p = next + 1;
    }
    return positions;
  })();
  console.log(`[pdf-extractor] streamKeyRe indexOf fallback: ${streamIndexFallback.length} positions`);

  while ((sk = streamKeyRe.exec(str)) !== null) {
    const dataStart = sk.index + sk[0].length;

    // Look back up to 1500 bytes for the stream dictionary
    const lookback = Math.max(0, sk.index - 1500);
    const pre = str.slice(lookback, sk.index);
    const dictStart = pre.lastIndexOf('<<');
    if (dictStart === -1) continue;
    const dict = pre.slice(dictStart);

    // Skip XRef and image streams — they carry no readable text
    if (/\/Type\s*\/XRef|\/Subtype\s*\/Image/i.test(dict)) continue;

    // Determine stream data length.
    // Priority 1: /Length with a direct integer in the dict (most reliable — exact bytes).
    // Priority 2: endstream boundary scan (fallback when /Length is an indirect ref).
    // The negative lookahead rejects "/Length 50 0 R" (indirect ref) while accepting
    // "/Length 1800" (direct integer).
    let dataLen;
    const lenDirect = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s*R\b)/);
    if (lenDirect) {
      dataLen = parseInt(lenDirect[1], 10);
    } else {
      // Indirect /Length or missing — fall back to scanning for the endstream marker.
      const endIdx = (() => {
        let pos = dataStart;
        while (pos < str.length) {
          const ni = str.indexOf('endstream', pos);
          if (ni === -1) return -1;
          // endstream must be preceded by CR, LF, or CRLF (PDF spec)
          if (ni > 0 && (str[ni - 1] === '\n' || str[ni - 1] === '\r')) return ni;
          pos = ni + 1;
        }
        return -1;
      })();
      if (endIdx === -1) continue;
      dataLen = endIdx - dataStart;
    }
    // Sanity bounds: skip empty / absurdly large streams
    if (dataLen < 10 || dataLen > 2000000) continue;

    streamsFound++;
    const bytes = buffer.slice(dataStart, dataStart + dataLen);
    const isFlate = /\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode)/i.test(dict);
    const usedLen = lenDirect ? `L=${dataLen}` : `ES=${dataLen}`;
    console.log(`[pdf-extractor] stream#${streamsFound} ${usedLen} isFlate=${isFlate} dict=${dict.replace(/\s+/g,' ').slice(0,80)}`);

    let content;
    if (isFlate) {
      try {
        content = zlib.inflateSync(bytes).toString('latin1');
        console.log(`[pdf-extractor] stream#${streamsFound} inflate OK len=${content.length} sample=${content.slice(0,80).replace(/[^\x20-\x7e]/g,'.')}`);
      } catch (e1) {
        try {
          content = zlib.inflateRawSync(bytes).toString('latin1');
          console.log(`[pdf-extractor] stream#${streamsFound} inflateRaw OK len=${content.length}`);
        } catch (e2) {
          console.log(`[pdf-extractor] stream#${streamsFound} inflate FAILED: ${e1.message}`);
          continue;
        }
      }
    } else {
      content = bytes.toString('latin1');
    }

    const hasTj = /\bTj\b|\bTJ\b|'(?=\s)/.test(content);
    console.log(`[pdf-extractor] stream#${streamsFound} hasTj=${hasTj}`);
    if (!hasTj) continue;

    streamsDecoded++;
    const lineTexts = [];
    let cur = [];
    const opRe = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+T[dD]|T\*|\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")|\[([\s\S]*?)\]\s*TJ|T\*\s*\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*'/g;
    let op;
    while ((op = opRe.exec(content)) !== null) {
      if (op[1] !== undefined) {
        if (parseFloat(op[2]) < -1 && cur.length) { lineTexts.push(cur.join(' ')); cur = []; }
      } else if (op[0] === 'T*') {
        if (cur.length) { lineTexts.push(cur.join(' ')); cur = []; }
      } else if (op[3] !== undefined) {
        const t = op[3]
          .replace(/\\\(/g,'(').replace(/\\\)/g,')').replace(/\\\\/g,'\\')
          .replace(/\\n/g,' ').replace(/\\r/g,' ')
          .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
        if (t.trim()) cur.push(t.trim());
      } else if (op[4] !== undefined) {
        const parts = [];
        for (let pRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g, pm; (pm = pRe.exec(op[4])); ) parts.push(pm[1]);
        const j = parts.join('');
        if (j.trim()) cur.push(j.trim());
      }
    }
    if (cur.length) lineTexts.push(cur.join(' '));
    allLines.push(...lineTexts);
  }
  console.log(`[pdf-extractor] zlib: ${streamsFound} streams found, ${streamsDecoded} decoded text`);
  return allLines.join('\n');
}

// ============================================================
// Column header definitions
// ============================================================
const PO_RE = /^4[5-9]\d{8}$/;
function isPO(s)  { return PO_RE.test((s || '').trim()); }

const HEADER_COLS = [
  // "Item" in a SAP delivery note = the PO line item number (00010, 00020 …)
  { key: 'poItem',          re: /^(?:item|pos(?:ition)?|lfd\.?nr\.?|line\s*no\.?|s\.?\s*no\.?|sr\.?\s*no\.?|seq\.?|po\s*item|item\s*no\.?|line\s*item|po\s*line|schedule\s*line)$/i },
  { key: 'poNumber',        re: /^(?:p\.?o\.?(?:\s*(?:number|no\.?|#))?|purchase\s*order(?:\s*(?:no\.?|number|#))?|bestellung(?:snr)?|order\s*(?:no\.?|number|#)?|po\s*#)$/i },
  { key: 'material',        re: /^(?:material(?:\s*(?:no\.?|number|#|code))?|article(?:\s*(?:no\.?|number))?|matnr|mat\.?(?:\s*(?:no\.?|#))?|part\s*(?:no\.?|number|#)?|item\s*(?:code|no\.?|#)?|product\s*(?:code|no\.?)?)$/i },
  { key: 'description',     re: /^(?:desc(?:ription)?|text|bezeichnung|item\s*desc(?:ription)?|mat(?:erial)?\s*desc(?:ription)?|product\s*(?:name|desc(?:ription)?)|short\s*text)$/i },
  { key: 'deliveredQty',    re: /^(?:del(?:ivered)?\s*\.?\s*qty\.?|qty\.?|quantity|menge|order(?:ed)?\s*qty\.?|ship(?:ped)?\s*qty\.?|delivered\s*quantity|rcvd\.?\s*qty\.?|received\s*qty\.?)$/i },
  { key: 'unit',            re: /^(?:unit(?:\s*of\s*meas(?:ure)?)?|uom|u\.?\s*o\.?\s*m\.?|me|um|base\s*unit)$/i },
  { key: 'plant',           re: /^(?:plant(?:\s*(?:code|no\.?|id))?|werk|receiving\s*plant)$/i },
  { key: 'storageLocation', re: /^(?:sloc|s\.?\s*loc\.?|stor(?:age)?\s*loc(?:ation)?|lgort|storage\s*location|whse\.?\s*(?:no\.?|location)?)$/i },
];

// ============================================================
// Find character positions of column headers in a text line
// ============================================================
function findColumnPositions(line) {
  const result = {};
  const lineLC = line.toLowerCase();
  for (const hc of HEADER_COLS) {
    // Strip ^ and $ anchors so the pattern matches anywhere within the line
    const src = hc.re.source.replace(/^\^/, '').replace(/\$$/, '');
    const re  = new RegExp(src, 'i');
    const m   = re.exec(lineLC);
    if (m) result[hc.key] = m.index;
  }
  return result;
}

// Extract value from a data line at a column's character range
function extractAtPosition(line, startPos, nextPos) {
  const segment = nextPos !== undefined
    ? line.substring(startPos, nextPos)
    : line.substring(startPos);
  // Return first non-empty token in the segment
  return segment.trim().split(/\s{2,}/)[0]?.trim() || segment.trim().split(/\s+/)[0]?.trim() || '';
}

// ============================================================
// Text-based extraction using character-position columns
// ============================================================
function extractWithText(text) {
  const lines = text.split('\n').filter(l => l.trim());

  // Header-level fields from full text
  const deliveryNumber = firstMatchRe(text, [
    /(?:delivery\s*(?:note|number|no|advice)|lieferschein|shipping\s*notice)[:\s#\-]+([A-Z0-9\-]{4,25})/gi,
    /\b(?:DN|LFS|DS|DEL)[:\s#]?\s*([A-Z0-9\-]{4,25})/gi,
  ]);
  const supplierName = firstMatchRe(text, [
    /(?:from|supplier|vendor|lieferant|sold\s*by)[:\s\-]+(.{3,60}?)(?:\n|,\s*\d|\bLtd\b|\bGmbH\b|\bInc\b)/gi,
  ]);
  const deliveryDate = firstMatchRe(text, [
    /(?:delivery\s*date|ship(?:ment)?\s*date|lieferdatum)[:\s\-]+(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/gi,
    /(?:delivery\s*date)[:\s\-]+(\d{4}-\d{2}-\d{2})/gi,
  ]);

  const allPOs = [...new Set([...text.matchAll(/\b(4[5-9]\d{8})\b/g)].map(m => m[1]))];

  // Log first 20 lines so we can see what the extractor produced
  console.log('[pdf-extractor] extracted lines (first 20):');
  lines.slice(0, 20).forEach((l, i) => console.log(`  [${i}] ${l.slice(0, 120)}`));

  // Find the header line
  let headerIdx = -1;
  let colPositions = {};

  for (let i = 0; i < lines.length; i++) {
    // Skip lines that are data (contain a SAP PO number) or binary garbage (too
    // long, or column positions unrealistically far from the left margin).
    if (/\b4[5-9]\d{8}\b/.test(lines[i])) continue;
    if (lines[i].length > 200) continue;
    const cp = findColumnPositions(lines[i]);
    const positions = Object.values(cp);
    if (positions.length >= 3 && Math.max(...positions) > 150) continue;
    if (Object.keys(cp).length >= 3) {
      headerIdx = i;
      colPositions = cp;
      console.log(`[pdf-extractor] header at line ${i}: ${lines[i].slice(0, 120)}`);
      console.log('[pdf-extractor] colPositions:', JSON.stringify(colPositions));
      break;
    }
  }

  if (headerIdx === -1 || Object.keys(colPositions).length < 3) {
    // No recognizable table header — stub rows from PO numbers found in text
    return {
      deliveryNumber, supplierName, deliveryDate,
      items: allPOs.map((po, idx) => ({
        lineNo: idx + 1, poNumber: po, poItem: '00010',
        material: null,
        description: 'Please verify — table structure not detected in PDF',
        deliveredQty: 0, unit: 'EA', plant: null, storageLocation: '0001',
      })),
    };
  }

  // Sort columns by character start position
  const sortedCols = Object.entries(colPositions).sort((a, b) => a[1] - b[1]);

  const items = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^[-=\s.]+$/.test(line)) continue;
    if (/(?:total|subtotal|page\s*\d|grand\s*total)/i.test(line) && line.trim().split(/\s+/).length <= 3) break;

    const rec = {};
    for (let ci = 0; ci < sortedCols.length; ci++) {
      const [key, pos] = sortedCols[ci];
      const nextPos = ci < sortedCols.length - 1 ? sortedCols[ci + 1][1] : undefined;
      const val = extractAtPosition(line, pos, nextPos);
      if (val) rec[key] = val;
    }

    if (!Object.keys(rec).length) continue;

    const poNumber = rec.poNumber && isPO(rec.poNumber) ? rec.poNumber : allPOs[0] || null;
    const material = rec.material && !isPO(rec.material) ? rec.material : null;
    const qtyRaw = (rec.deliveredQty || '').replace(',', '.');
    const deliveredQty = parseFloat(qtyRaw) || 0;

    if (!poNumber && !material && !deliveredQty) continue;

    items.push({
      lineNo:          items.length + 1,
      poNumber,
      poItem:          rec.poItem ? String(rec.poItem).padStart(5, '0') : '00010',
      material:        material || null,
      description:     rec.description || line.trim().slice(0, 80),
      deliveredQty,
      unit:            rec.unit?.toUpperCase() || 'EA',
      plant:           rec.plant || null,
      storageLocation: rec.storageLocation || '0001',
    });
  }

  return { deliveryNumber, supplierName, deliveryDate, items };
}

function firstMatchRe(text, patterns) {
  for (const p of patterns) {
    p.lastIndex = 0;
    const m = p.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

// ============================================================
// Claude-based extraction (used when ANTHROPIC_API_KEY is set)
// ============================================================
let _anthropic;
function getAnthropic() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic();
  }
  return _anthropic;
}

const CLAUDE_JSON_PROMPT = `You are a data extraction assistant for SAP ERP. Extract structured fields from this delivery note.

The PDF table uses these column names — map them as shown:
  "Item"        → poItem  (the PO line item number, e.g. 1 → "00010", 2 → "00020")
  "PO Number"   → poNumber  (10-digit SAP PO number starting with 45–47)
  "Plant"       → plant
  "Material"    → material  (SAP material/article code, NOT the PO number)
  "Description" → description
  "Qty"         → deliveredQty  (numeric)
  "UoM"         → unit  (unit of measure, e.g. EA, KG, PC)

Return ONLY a valid JSON object — no explanation, no markdown, no code fences — in exactly this shape:
{
  "deliveryNumber":  "<delivery note / shipping notice number, or null>",
  "supplierName":    "<supplier / vendor name, or null>",
  "deliveryDate":    "<delivery date as printed, or null>",
  "items": [
    {
      "lineNo":          <integer row position starting at 1>,
      "poNumber":        "<10-digit SAP PO number, or null>",
      "poItem":          "<PO line item padded to 5 digits e.g. 00010, or null>",
      "material":        "<SAP material code, or null>",
      "description":     "<short item description, or null>",
      "deliveredQty":    <numeric quantity, 0 if unknown>,
      "unit":            "<unit e.g. EA KG PC, or null>",
      "plant":           "<4-char SAP plant code, or null>",
      "storageLocation": "<storage location, or null>"
    }
  ]
}

Rules:
- PO numbers are exactly 10 digits starting with 45, 46, or 47.
- Material codes are NEVER the same as the PO number.
- deliveredQty must be a number, not a string.
- If unsure about a field, set it to null.`;

async function extractWithClaude(text) {
  const client  = getAnthropic();
  const snippet = text.slice(0, 8000);

  const response = await client.messages.create({
    model:      'claude-haiku-5-5',
    max_tokens: 2048,
    messages:   [{ role: 'user', content: `${CLAUDE_JSON_PROMPT}\n\nDelivery note text:\n${snippet}` }],
  });

  const raw     = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); }
  catch { throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`); }
}

// Send the raw PDF bytes directly to Claude — works even when all text parsers fail.
// Requires ANTHROPIC_API_KEY and a model that supports the document content type.
async function extractWithClaudePDF(buffer) {
  const client = getAnthropic();
  const base64 = buffer.toString('base64');

  console.log('[pdf-extractor] sending PDF directly to Claude (document mode)...');
  const response = await client.messages.create({
    model:      'claude-haiku-5-5',
    max_tokens: 2048,
    messages:   [{
      role:    'user',
      content: [
        {
          type:   'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        { type: 'text', text: CLAUDE_JSON_PROMPT },
      ],
    }],
  });

  const raw     = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let result;
  try { result = JSON.parse(cleaned); }
  catch { throw new Error(`Claude PDF extraction returned non-JSON: ${raw.slice(0, 200)}`); }

  result.items = (result.items || []).map((item, idx) => ({
    lineNo:          item.lineNo  ?? idx + 1,
    poNumber:        item.poNumber  || null,
    poItem:          item.poItem    ? String(item.poItem).padStart(5, '0') : '00010',
    material:        item.material  || null,
    description:     item.description || '',
    deliveredQty:    parseFloat(item.deliveredQty) || 0,
    unit:            item.unit       || 'EA',
    plant:           item.plant      || null,
    storageLocation: item.storageLocation || '0001',
  }));

  return {
    deliveryNumber: result.deliveryNumber || null,
    supplierName:   result.supplierName   || null,
    deliveryDate:   result.deliveryDate   || null,
    rawText:        '[Claude document extraction — text layer not available]',
    rawSnippet:     '[Claude PDF]',
    items:          result.items,
  };
}

// ============================================================
// Mock data for predefined data mode
// ============================================================
function mockExtraction() {
  return {
    deliveryNumber: 'DN-TEST-2024',
    supplierName:   'Test Supplier Co.',
    deliveryDate:   '2024-11-06',
    rawText:        '[MOCK PDF — test data]',
    rawSnippet:     '[MOCK PDF — test data]',
    items: [
      {
        lineNo:          1,
        poNumber:        '4500292223',
        poItem:          '00010',
        material:        'DAUTO813',
        description:     'Deloitte Reimagine Auto',
        deliveredQty:    1,
        unit:            'EA',
        plant:           '1106',
        storageLocation: '0001',
      },
      {
        lineNo:          2,
        poNumber:        '4500292223',
        poItem:          '00020',
        material:        'DAUTO814',
        description:     'Deloitte Reimagine Auto',
        deliveredQty:    1,
        unit:            'EA',
        plant:           '1106',
        storageLocation: '0001',
      },
    ],
  };
}

// ============================================================
// Main export
// ============================================================
async function extractFromPDF(buffer, useMock = false) {
  if (useMock || process.env.MOCK_PDF === 'true') {
    console.log('[pdf-extractor] mock mode — returning predefined test data');
    return mockExtraction();
  }

  let text;
  try {
    text = await extractPDFText(buffer);
  } catch (err) {
    // All text parsers failed — if Claude API key is available, send the PDF directly
    if (process.env.ANTHROPIC_API_KEY) {
      return await extractWithClaudePDF(buffer);
    }
    throw new Error(`PDF parse failed: ${err.message}`);
  }

  if (!text || !text.trim()) {
    if (process.env.ANTHROPIC_API_KEY) {
      return await extractWithClaudePDF(buffer);
    }
    throw new Error('PDF appears to be empty or image-only (no extractable text)');
  }

  let result;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      result = await extractWithClaude(text);
    } catch (err) {
      console.warn('[pdf-extractor] Claude failed, using text fallback:', err.message);
      result = extractWithText(text);
    }
  } else {
    result = extractWithText(text);
  }

  // Normalise every item
  result.items = (result.items || []).map((item, idx) => ({
    lineNo:          item.lineNo  ?? idx + 1,
    poNumber:        item.poNumber  || null,
    poItem:          item.poItem    ? String(item.poItem).padStart(5, '0') : '00010',
    material:        item.material  || null,
    description:     item.description || '',
    deliveredQty:    parseFloat(item.deliveredQty) || 0,
    unit:            item.unit       || 'EA',
    plant:           item.plant      || null,
    storageLocation: item.storageLocation || '0001',
  }));

  return {
    deliveryNumber: result.deliveryNumber || null,
    supplierName:   result.supplierName   || null,
    deliveryDate:   result.deliveryDate   || null,
    rawText:        text,
    rawSnippet:     text.slice(0, 500).replace(/\n+/g, ' '),
    items:          result.items,
  };
}

module.exports = { extractFromPDF };
