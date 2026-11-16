sap.ui.define([
    'sap/ui/core/UIComponent',
    'sap/ui/Device',
    'sap/ui/model/json/JSONModel'
], function (UIComponent, Device, JSONModel) {
    'use strict';

    return UIComponent.extend('test_gr.Component', {
        metadata: {
            manifest: 'json'
        },

        init: function () {
            UIComponent.prototype.init.apply(this, arguments);

            // Device model
            const oDeviceModel = new JSONModel(Device);
            oDeviceModel.setDefaultBindingMode('OneWay');
            this.setModel(oDeviceModel, 'device');

            // App state model
            this.setModel(new JSONModel({
                busy: false,
                deliveryNoteId: null,
                extractedItems: [],
                matchedItems: []
            }), 'appState');

            this.getRouter().initialize();
        }
    });
});
