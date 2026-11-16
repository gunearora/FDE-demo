sap.ui.define([
    'sap/ui/core/mvc/Controller',
    'sap/m/MessageBox',
    'sap/m/MessageToast'
], function (Controller, MessageBox, MessageToast) {
    'use strict';

    return Controller.extend('test_gr.controller.Match', {

        onInit: function () {
            this.getOwnerComponent().getRouter()
                .getRoute('match')
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function (oEvent) {
            this._deliveryNoteId = oEvent.getParameter('arguments').deliveryNoteId;
            this._updatePostButton();
        },

        onNavBack: function () {
            this.getOwnerComponent().getRouter().navTo('upload');
        },

        onSelectionChange: function () {
            this._updatePostButton();
        },

        _updatePostButton: function () {
            const oTable = this.byId('matchTable');
            const selected = oTable ? oTable.getSelectedItems().length : 0;
            const oBtn = this.byId('postBtn');
            if (oBtn) oBtn.setEnabled(selected > 0);
            const oInfo = this.byId('selectionInfo');
            if (oInfo) oInfo.setText(`${selected} item(s) selected`);
        },

        onPostGR: async function () {
            const oTable = this.byId('matchTable');
            const selectedItems = oTable.getSelectedItems();

            if (selectedItems.length === 0) {
                MessageBox.warning('Please select at least one item.');
                return;
            }

            // Warn if any selected item has WARNING status
            const hasWarnings = selectedItems.some(oItem => {
                const ctx = oItem.getBindingContext('appState');
                return ctx && ctx.getProperty('matchStatus') === 'WARNING';
            });

            const proceed = async () => {
                const oModel = this.getOwnerComponent().getModel('appState');
                oModel.setProperty('/busy', true);

                const selectedIds = selectedItems.map(oItem => {
                    const ctx = oItem.getBindingContext('appState');
                    return ctx.getProperty('itemId');
                });

                try {
                    const response = await fetch('/delivery/postGoodsReceipt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            deliveryNoteId: this._deliveryNoteId,
                            selectedItems: selectedIds
                        })
                    });

                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error?.message || 'GR posting failed');

                    const data = result.value || result;
                    oModel.setProperty('/grDocNumber', data.grDocNumber);
                    oModel.setProperty('/grYear', data.grYear);
                    oModel.setProperty('/grItemCount', selectedIds.length);

                    this.getOwnerComponent().getRouter().navTo('confirm', {
                        deliveryNoteId: this._deliveryNoteId
                    });
                } catch (err) {
                    MessageBox.error('Goods receipt posting failed: ' + err.message);
                } finally {
                    oModel.setProperty('/busy', false);
                }
            };

            if (hasWarnings) {
                MessageBox.warning(
                    'Some selected items are outside the quantity tolerance. Post goods receipt anyway?',
                    {
                        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                        onClose: action => { if (action === MessageBox.Action.OK) proceed(); }
                    }
                );
            } else {
                await proceed();
            }
        }
    });
});
