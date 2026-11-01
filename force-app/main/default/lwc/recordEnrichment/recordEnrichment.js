import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import enrichRecord from '@salesforce/apex/EnrichmentService.enrichRecord';

const STATUS_ICONS = {
    Succeeded: { name: 'utility:success', variant: 'success' },
    Partial: { name: 'utility:warning', variant: 'warning' }
};

export default class RecordEnrichment extends LightningElement {
    result;
    errorMessage;
    isWorking = true;

    _recordId;
    _requested = false;

    @api
    get recordId() {
        return this._recordId;
    }

    // quick actions set recordId after the component is created
    set recordId(value) {
        this._recordId = value;
        if (value && !this._requested) {
            this._requested = true;
            this.enrich();
        }
    }

    get statusIcon() {
        return STATUS_ICONS[this.result?.status] || { name: 'utility:info', variant: '' };
    }

    get hasUpdatedFields() {
        return this.result?.updatedFields?.length > 0;
    }

    get updatedFieldsText() {
        return this.result.updatedFields.join(', ');
    }

    async enrich() {
        try {
            this.result = await enrichRecord({ recordId: this._recordId });
            await notifyRecordUpdateAvailable([{ recordId: this._recordId }]);
        } catch (error) {
            this.errorMessage = error?.body?.message || error?.message || 'The record could not be enriched.';
        } finally {
            this.isWorking = false;
        }
    }

    handleClose() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}
