'use strict';

const cds = require('@sap/cds');
const log = cds.log('pdf-extractor');

/**
 * Extracts PO data from PDF text using pattern matching.
 * Falls back to Claude AI if patterns don't yield results.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Array<{ poNumber, poItem, material, quantity, uom }>>}
 */
async function extractFromPdf(pdfBuffer) {
    let rawText = '';

    try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(pdfBuffer);
        rawText = data.text;
        log.info(`PDF extracted, ${rawText.length} chars`);
    } catch (err) {
        log.error('pdf-parse failed:', err.message);
        throw new Error('Failed to read PDF: ' + err.message);
    }

    // Try pattern-based extraction first
    const items = extractWithPatterns(rawText);
    if (items.length > 0) {
        log.info(`Pattern extraction found ${items.length} items`);
        return { rawText, items };
    }

    // Fallback: Claude AI extraction
    log.info('Falling back to Claude AI for extraction');
    const aiItems = await extractWithClaude(rawText);
    return { rawText, items: aiItems };
}

/**
 * Regex-based extraction for common delivery note formats.
 */
function extractWithPatterns(text) {
    const items = [];

    // Pattern: PO Number (10 digits), PO Item (up to 5 digits)
    // Matches lines like: "4500012345  00010  MAT001  100.000  EA"
    const linePattern = /(\d{10})\s+(\d{3,5})\s+([A-Z0-9\-]{1,40})\s+([\d,\.]+)\s+([A-Z]{2,3})/gm;
    let match;
    let lineNum = 1;

    while ((match = linePattern.exec(text)) !== null) {
        const qty = parseFloat(match[4].replace(',', '.'));
        if (qty > 0) {
            items.push({
                lineNumber: lineNum++,
                poNumber: match[1],
                poItem: match[2].padStart(5, '0'),
                material: match[3],
                quantity: qty,
                uom: match[5]
            });
        }
    }

    return items;
}

/**
 * Uses Claude claude-sonnet-4-6 to extract PO data from unstructured PDF text.
 */
async function extractWithClaude(rawText) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const prompt = `You are an SAP procurement expert. Extract purchase order line items from this delivery note text.

Return ONLY a JSON array with objects having exactly these fields:
- lineNumber (integer, starting at 1)
- poNumber (string, 10-digit SAP PO number)
- poItem (string, 5-digit SAP PO item, zero-padded)
- material (string, SAP material number)
- quantity (number)
- uom (string, SAP unit of measure, e.g. EA, KG, ST, PC)

Delivery Note Text:
${rawText.substring(0, 8000)}

Respond with ONLY the JSON array, no explanation.`;

    const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text.trim();

    // Strip markdown code fences if present
    const jsonText = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/, '');

    try {
        return JSON.parse(jsonText);
    } catch (err) {
        log.error('Claude response not valid JSON:', responseText.substring(0, 200));
        throw new Error('AI extraction failed: could not parse response');
    }
}

module.exports = { extractFromPdf };
