'use strict';
const path   = require('path');
const cds    = require('@sap/cds');
const express = require('express');
const multer  = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

cds.on('bootstrap', (app) => {
  // Serve UI from app/webapp at /app
  app.use('/app', express.static(path.join(__dirname, 'app/webapp')));
  app.get('/', (_req, res) => res.redirect('/app/index.html'));

  // PDF upload endpoint — must be before CDS middleware
  app.post('/api/upload-pdf', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No PDF file received' });
      if (req.file.mimetype !== 'application/pdf')
        return res.status(400).json({ error: 'Only PDF files are accepted' });

      const db = await cds.connect.to('db');
      const { DeliveryNotes } = cds.entities('com.gr.automation');
      const id = cds.utils.uuid();

      await db.run(
        INSERT.into(DeliveryNotes).entries({
          ID:       id,
          fileName: req.file.originalname,
          status:   'UPLOADED',
          rawText:  req.file.buffer.toString('base64'),
        })
      );

      return res.status(201).json({
        deliveryNoteId: id,
        fileName: req.file.originalname,
        message: 'PDF uploaded. Call extractData to parse.',
      });
    } catch (err) {
      console.error('[upload-pdf]', err);
      return res.status(500).json({ error: err.message });
    }
  });
});

module.exports = cds.server;
