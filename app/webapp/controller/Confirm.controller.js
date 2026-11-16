sap.ui.define(['sap/ui/core/mvc/Controller'], function (Controller) {
    'use strict';

    return Controller.extend('test_gr.controller.Confirm', {

        onNewUpload: function () {
            this.getOwnerComponent().getRouter().navTo('upload');
        },

        onViewLog: function () {
            // Navigate to GR log — open in new tab or modal (future enhancement)
            window.open('/delivery/GoodsReceiptLog', '_blank');
        }
    });
});
