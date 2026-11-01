/**
 * Synchronous record enrichment for Leads and Accounts: identify (when needed), enrich, then write blank fields
 * and the enrichment status in one transaction. All callouts run before the DML.
 */
public with sharing class EnrichmentService {
    public class EnrichmentException extends Exception {}

    public static final String STATUS_SUCCEEDED = 'Succeeded';
    public static final String STATUS_PARTIAL = 'Partial';
    public static final String STATUS_NO_MATCH = 'No Match';
    public static final String STATUS_AMBIGUOUS = 'Ambiguous Match';
    public static final String STATUS_FAILED = 'Failed';

    private static final String PERMISSION = 'Request_Record_Enrichment';

    public class Result {
        @AuraEnabled public Id recordId;
        @AuraEnabled public String recordName;
        @AuraEnabled public String status;
        @AuraEnabled public String message;
        @AuraEnabled public List<String> updatedFields = new List<String>();
    }

    @AuraEnabled
    public static Result enrichRecord(Id recordId) {
        try {
            return enrich(recordId);
        } catch (EnrichmentException e) {
            AuraHandledException error = new AuraHandledException(e.getMessage());
            error.setMessage(e.getMessage());
            throw error;
        }
    }

    public static Result enrich(Id recordId) {
        if (!FeatureManagement.checkPermission(PERMISSION)) {
            throw new EnrichmentException('You do not have permission to enrich records.');
        }
        if (recordId == null
            || (recordId.getSObjectType() != Lead.SObjectType && recordId.getSObjectType() != Account.SObjectType)) {
            throw new EnrichmentException('Only Leads and Accounts can be enriched.');
        }
        Schema.SObjectType type = recordId.getSObjectType();
        List<Enrichment_Field_Mapping__mdt> mappings = EnrichmentFieldMapper.selectMappings(type);
        SObject target = load(recordId, mappings);
        if (!hasEditAccess(recordId)) {
            throw new EnrichmentException('You do not have edit access to this record.');
        }

        String entityType = AcmeEnrichmentClient.entityTypeOf(target);
        String entityId = (String) target.get('Enrichment_Entity_Id__c');
        String status;
        String body;
        String error;
        try {
            if (String.isBlank(entityId)) {
                AcmeEnrichmentClient.Identification identification = AcmeEnrichmentClient.identify(target);
                if (identification.status == AcmeEnrichmentClient.STATUS_AMBIGUOUS) {
                    status = STATUS_AMBIGUOUS;
                } else if (AcmeEnrichmentClient.NO_MATCH_STATUSES.contains(identification.status)) {
                    status = STATUS_NO_MATCH;
                } else {
                    entityId = identification.entityId;
                }
            }
            if (status == null) {
                AcmeEnrichmentClient.Enrichment enrichment = AcmeEnrichmentClient.enrich(entityId, entityType);
                body = enrichment.body;
                status = enrichment.completeness == 'partial' ? STATUS_PARTIAL : STATUS_SUCCEEDED;
            }
        } catch (AcmeEnrichmentClient.ProviderException e) {
            status = STATUS_FAILED;
            error = e.getMessage();
        }

        // callouts are done, DML from here on
        SObject changes = body == null
            ? type.newSObject(recordId)
            : EnrichmentFieldMapper.buildUpdate(target, mappings, body);
        Result result = new Result();
        result.recordId = recordId;
        result.recordName = (String) target.get('Name');
        result.status = status;
        Map<String, Schema.SObjectField> fields = type.getDescribe().fields.getMap();
        for (String field : changes.getPopulatedFieldsAsMap().keySet()) {
            if (field != 'Id') {
                result.updatedFields.add(fields.get(field).getDescribe().getLabel());
            }
        }
        result.message = message(status, entityType, result.updatedFields, error);

        changes.put('Enrichment_Status__c', status);
        changes.put('Enrichment_Message__c', result.message.abbreviate(255));
        if (String.isNotBlank(entityId)) {
            changes.put('Enrichment_Entity_Id__c', entityId);
        }
        if (status == STATUS_SUCCEEDED || status == STATUS_PARTIAL) {
            changes.put('Last_Enriched_On__c', Datetime.now());
        }
        // edit access was checked above and mapped fields are limited to editable ones
        Database.update(changes, AccessLevel.SYSTEM_MODE);
        return result;
    }

    /**
     * Company data for a meeting brief: identifies the account when needed and returns the raw enrich response,
     * or null when the company is unknown or the provider fails. Makes callouts only, no DML.
     */
    public static String fetchCompanyData(Account account) {
        try {
            String entityId = account.Enrichment_Entity_Id__c;
            if (String.isBlank(entityId)) {
                AcmeEnrichmentClient.Identification identification = AcmeEnrichmentClient.identify(account);
                if (identification.status != AcmeEnrichmentClient.STATUS_MATCHED) {
                    return null;
                }
                entityId = identification.entityId;
            }
            return AcmeEnrichmentClient.enrich(entityId, 'company').body;
        } catch (AcmeEnrichmentClient.ProviderException e) {
            System.debug(LoggingLevel.WARN, 'Company data unavailable for the meeting brief: ' + e.getMessage());
            return null;
        }
    }

    private static SObject load(Id recordId, List<Enrichment_Field_Mapping__mdt> mappings) {
        Set<String> fields = new Set<String>{ 'Id', 'Name', 'Website', 'Enrichment_Entity_Id__c' };
        if (recordId.getSObjectType() == Lead.SObjectType) {
            fields.add('Company');
        } else {
            fields.addAll(new List<String>{ 'BillingCountry', 'ShippingCountry' });
        }
        for (Enrichment_Field_Mapping__mdt mapping : mappings) {
            fields.add(mapping.Field__c);
        }
        String query = 'SELECT ' + String.join(new List<String>(fields), ', ')
            + ' FROM ' + recordId.getSObjectType() + ' WHERE Id = :recordId';
        List<SObject> records;
        try {
            records = Database.queryWithBinds(query, new Map<String, Object>{ 'recordId' => recordId }, AccessLevel.USER_MODE);
        } catch (QueryException e) {
            throw new EnrichmentException('You do not have access to the fields needed for enrichment.');
        }
        if (records.isEmpty()) {
            throw new EnrichmentException('The record was not found or you do not have access to it.');
        }
        return records[0];
    }

    private static Boolean hasEditAccess(Id recordId) {
        List<UserRecordAccess> access = [
            SELECT RecordId, HasEditAccess
            FROM UserRecordAccess
            WHERE UserId = :UserInfo.getUserId() AND RecordId = :recordId
        ];
        return !access.isEmpty() && access[0].HasEditAccess;
    }

    private static String message(String status, String entityType, List<String> updatedFields, String error) {
        String subject = entityType == 'person' ? 'person' : 'company';
        String updated = updatedFields.isEmpty()
            ? 'No blank fields needed new values.'
            : 'Updated: ' + String.join(updatedFields, ', ') + '.';
        if (status == STATUS_SUCCEEDED) {
            return 'Enrichment completed. ' + updated;
        }
        if (status == STATUS_PARTIAL) {
            return 'Enrichment partially completed; the provider had limited data. ' + updated;
        }
        if (status == STATUS_NO_MATCH) {
            return entityType == 'person'
                ? 'No matching person was found. Check the name, company and website, then try again.'
                : 'No matching company was found. Check the name, website and country, then try again.';
        }
        if (status == STATUS_AMBIGUOUS) {
            return 'More than one ' + subject + ' matches. Add the website'
                + (entityType == 'person' ? ' or company' : ' or country') + ', then try again.';
        }
        return 'Enrichment failed: ' + error;
    }
}
