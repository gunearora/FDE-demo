sap.ui.define([
    'sap/ui/core/mvc/Controller',
    'sap/m/MessageToast',
    'sap/m/MessageBox'
], function (Controller, MessageToast, MessageBox) {
    'use strict';

    return Controller.extend('test_gr.controller.Upload', {

        onRouteMatched: function () {
            this.getOwnerComponent().getModel('appState').setProperty('/extractedItems', []);
            this.getOwnerComponent().getModel('appState').setProperty('/selectedFile', null);
            this.byId('fileUploader').clear();
        },

        onInit: function () {
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute('upload').attachPatternMatched(this.onRouteMatched, this);
        },

        onFileChange: function (oEvent) {
            const oFiles = oEvent.getParameter('files');
            if (oFiles && oFiles.length > 0) {
                this.getOwnerComponent().getModel('appState').setProperty('/selectedFile', oFiles[0]);
            }
        },

        onFileTypeMismatch: function () {
            MessageBox.error('Only PDF files are supported.');
        },

        onFileSizeExceed: function () {
            MessageBox.error('File size exceeds the maximum limit of 10 MB.');
        },

        onUpload: async function () {
            const oModel = this.getOwnerComponent().getModel('appState');
            const oFile = oModel.getProperty('/selectedFile');

            if (!oFile) {
                MessageBox.error('Please select a PDF file first.');
                return;
            }

            oModel.setProperty('/busy', true);

            try {
                const base64 = await this._readFileAsBase64(oFile);
                const response = await fetch('/delivery/uploadDeliveryNote', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fileName: oFile.name,
                        fileContent: base64
                    })
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error?.message || 'Upload failed');
                }

                const data = result.value || result;
                oModel.setProperty('/deliveryNoteId', data.deliveryNoteId);
                oModel.setProperty('/extractedItems', data.items || []);
                MessageToast.show(`Extracted ${(data.items || []).length} item(s) from ${oFile.name}`);
            } catch (err) {
                MessageBox.error('Upload failed: ' + err.message);
            } finally {
                oModel.setProperty('/busy', false);
            }
        },

        onMatchPOs: async function () {
            const oModel = this.getOwnerComponent().getModel('appState');
            const deliveryNoteId = oModel.getProperty('/deliveryNoteId');

            oModel.setProperty('/busy', true);

            try {
                const response = await fetch('/delivery/matchPurchaseOrders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deliveryNoteId })
                });

                const result = await response.json();
                if (!response.ok) throw new Error(result.error?.message || 'Match failed');

                const data = result.value || result;
                oModel.setProperty('/matchedItems', (data.items || []).map(i => ({ ...i, _selected: false })));
                this.getOwnerComponent().getRouter().navTo('match', { deliveryNoteId });
            } catch (err) {
                MessageBox.error('PO matching failed: ' + err.message);
            } finally {
                oModel.setProperty('/busy', false);
            }
        },

        _readFileAsBase64: function (file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }
    });
});
