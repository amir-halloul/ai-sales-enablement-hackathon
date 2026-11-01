import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import canGenerateBriefs from '@salesforce/customPermission/Generate_Meeting_Brief';
import getLatestBrief from '@salesforce/apex/MeetingBriefService.getLatestBrief';
import generateBrief from '@salesforce/apex/MeetingBriefService.generateBrief';
import { SECTIONS, buildSections } from './briefView';

const STATUS_ICONS = { Ready: 'utility:success', Incomplete: 'utility:warning', Failed: 'utility:error' };

export default class MeetingBrief extends LightningElement {
    @api objectApiName;

    brief;
    sections = [];
    coverage = [];
    errorMessage;
    isLoading = true;
    isGenerating = false;
    showOptions = false;
    selectedSections = SECTIONS.map((section) => section.key);
    sectionOptions = SECTIONS.map((section) => ({ label: section.label, value: section.key }));

    _recordId;

    @api
    get recordId() {
        return this._recordId;
    }

    set recordId(value) {
        this._recordId = value;
        this.load();
    }

    get canGenerate() {
        return canGenerateBriefs && this.objectApiName !== 'Meeting_Brief__c';
    }

    get generateLabel() {
        return this.brief ? 'Regenerate' : 'Generate brief';
    }

    get isGenerateDisabled() {
        return this.isGenerating || this.selectedSections.length === 0;
    }

    get hasBrief() {
        return !!this.brief;
    }

    get isEmpty() {
        return !this.isLoading && !this.isGenerating && !this.brief && !this.errorMessage;
    }

    get briefUrl() {
        return this.brief ? `/lightning/r/Meeting_Brief__c/${this.brief.Id}/view` : null;
    }

    get statusIcon() {
        return STATUS_ICONS[this.brief?.Status__c] || 'utility:info';
    }

    get showStatusMessage() {
        return this.brief && this.brief.Status__c !== 'Ready' && this.brief.Status_Message__c;
    }

    get hasCoverage() {
        return this.coverage.length > 0;
    }

    async load() {
        if (!this._recordId) {
            return;
        }
        this.isLoading = true;
        this.errorMessage = null;
        try {
            this.setBrief(await getLatestBrief({ recordId: this._recordId }));
        } catch (error) {
            this.errorMessage = messageOf(error);
        } finally {
            this.isLoading = false;
        }
    }

    setBrief(brief) {
        this.brief = brief || null;
        const view = brief ? buildSections(brief) : { sections: [], coverage: [] };
        this.sections = view.sections;
        this.coverage = view.coverage;
    }

    handleToggleOptions() {
        this.showOptions = !this.showOptions;
    }

    handleSectionChange(event) {
        this.selectedSections = event.detail.value;
    }

    async handleGenerate() {
        this.isGenerating = true;
        this.errorMessage = null;
        try {
            const result = await generateBrief({ recordId: this._recordId, sectionKeys: this.selectedSections });
            this.setBrief(await getLatestBrief({ recordId: result.briefId }));
            this.showOptions = false;
            this.toast(result.status === 'Ready' ? 'success' : 'warning', `Meeting brief ${result.status}`, result.message);
            if (this.objectApiName === 'Task' || this.objectApiName === 'Event') {
                notifyRecordUpdateAvailable([{ recordId: this._recordId }]);
            }
        } catch (error) {
            this.toast('error', 'Meeting brief not generated', messageOf(error));
        } finally {
            this.isGenerating = false;
        }
    }

    toast(variant, title, message) {
        this.dispatchEvent(new ShowToastEvent({ variant, title, message }));
    }
}

function messageOf(error) {
    return error?.body?.message || error?.message || 'Something went wrong.';
}
