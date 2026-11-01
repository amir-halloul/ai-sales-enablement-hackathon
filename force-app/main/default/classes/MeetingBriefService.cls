/**
 * Generates a meeting brief synchronously: company data callouts first, then one prompt per selected section,
 * then a single insert of the brief and the link from the meeting activity.
 */
public with sharing class MeetingBriefService {
    public class BriefException extends Exception {}

    public static final String STATUS_READY = 'Ready';
    public static final String STATUS_INCOMPLETE = 'Incomplete';
    public static final String STATUS_FAILED = 'Failed';
    public static final String SECTION_READY = 'Ready';
    public static final String SECTION_ERROR = 'Error';
    public static final String SECTION_SKIPPED = 'Skipped';

    private static final String PERMISSION = 'Generate_Meeting_Brief';

    public class Result {
        @AuraEnabled public Id briefId;
        @AuraEnabled public Id accountId;
        @AuraEnabled public String status;
        @AuraEnabled public String message;
    }

    /**
     * @param recordId Account, Task or Event; a Task or Event is the meeting the brief prepares for.
     * @param sectionKeys Sections to generate; empty means all.
     */
    @AuraEnabled
    public static Result generateBrief(Id recordId, List<String> sectionKeys) {
        try {
            Set<String> keys = sectionKeys == null || sectionKeys.isEmpty()
                ? MeetingBriefSections.parse(null)
                : MeetingBriefSections.parse(String.join(sectionKeys, ','));
            Boolean isActivity = recordId != null
                && (recordId.getSObjectType() == Task.SObjectType || recordId.getSObjectType() == Event.SObjectType);
            return generate(isActivity ? null : recordId, isActivity ? recordId : null, keys);
        } catch (BriefException e) {
            throw auraError(e.getMessage());
        } catch (MeetingBriefSections.SectionException e) {
            throw auraError(e.getMessage());
        } catch (MeetingBriefContextService.ContextException e) {
            throw auraError(e.getMessage());
        }
    }

    /**
     * @param accountId Optional when activityId is given; the meeting's account is used then.
     * @param activityId Optional Task or Event Id of the meeting.
     */
    public static Result generate(Id accountId, Id activityId, Set<String> sectionKeys) {
        if (!FeatureManagement.checkPermission(PERMISSION)) {
            throw new BriefException('You do not have permission to generate meeting briefs.');
        }
        if (sectionKeys == null || sectionKeys.isEmpty()) {
            throw new BriefException('Select at least one section.');
        }
        SObject meeting = activityId == null ? null : loadMeeting(activityId);
        if (meeting != null) {
            Id meetingAccountId = (Id) meeting.get('AccountId');
            if (meetingAccountId == null) {
                throw new BriefException('The meeting is not related to an account.');
            }
            if (accountId != null && accountId != meetingAccountId) {
                throw new BriefException('The meeting belongs to a different account.');
            }
            accountId = meetingAccountId;
        }
        if (accountId == null || accountId.getSObjectType() != Account.SObjectType) {
            throw new BriefException('An account or a meeting (Task or Event) is required.');
        }
        Account account = loadAccount(accountId);

        // callouts: company data, then one prompt per section; no DML before the last prompt
        Boolean needsCompanyData = false;
        for (String key : sectionKeys) {
            needsCompanyData |= MeetingBriefSections.get(key).sources.contains(MeetingBriefSections.SOURCE_ENRICHMENT);
        }
        String companyData = needsCompanyData ? EnrichmentService.fetchCompanyData(account) : null;
        MeetingBriefContextService.prime(accountId, meeting, companyData);

        Meeting_Brief__c brief = new Meeting_Brief__c(Account__c = accountId);
        List<String> failed = new List<String>();
        String firstError;
        Integer ready = 0;
        for (MeetingBriefSections.Section section : MeetingBriefSections.ALL) {
            if (!sectionKeys.contains(section.key)) {
                brief.put(section.statusField, SECTION_SKIPPED);
                continue;
            }
            try {
                brief.put(section.contentField, MeetingBriefGenerator.generateSection(accountId, section.key));
                brief.put(section.statusField, SECTION_READY);
                ready++;
            } catch (Exception e) {
                brief.put(section.statusField, SECTION_ERROR);
                failed.add(section.label);
                firstError = firstError == null ? e.getMessage() : firstError;
                System.debug(LoggingLevel.ERROR, 'Meeting brief section ' + section.key + ' failed: ' + e.getMessage());
            }
        }
        brief.Context_Snapshot__c = MeetingBriefContextService.buildSnapshot(accountId);

        Result result = new Result();
        result.accountId = accountId;
        if (failed.isEmpty()) {
            result.status = STATUS_READY;
            result.message = 'The meeting brief for ' + account.Name + ' is ready.';
        } else if (ready > 0) {
            result.status = STATUS_INCOMPLETE;
            result.message = 'Some sections could not be generated: ' + String.join(failed, ', ') + '.';
        } else {
            result.status = STATUS_FAILED;
            result.message = 'The meeting brief could not be generated: ' + firstError;
        }
        brief.Status__c = result.status;
        brief.Status_Message__c = result.message.abbreviate(255);

        // users get read-only access to briefs; record access was checked when the account was loaded
        Database.insert(brief, AccessLevel.SYSTEM_MODE);
        if (meeting != null) {
            SObject link = meeting.getSObjectType().newSObject(meeting.Id);
            link.put('Meeting_Brief__c', brief.Id);
            Database.update(link, AccessLevel.SYSTEM_MODE);
        }
        result.briefId = brief.Id;
        return result;
    }

    @AuraEnabled
    public static Meeting_Brief__c getLatestBrief(Id recordId) {
        return findLatest(recordId);
    }

    /**
     * @param recordId A Meeting_Brief__c, the Task or Event it was generated for, or an Account (its newest brief).
     * @return The brief with MeetingBriefFormatter.BRIEF_FIELDS, or null.
     */
    public static Meeting_Brief__c findLatest(Id recordId) {
        if (recordId == null) {
            return null;
        }
        Schema.SObjectType type = recordId.getSObjectType();
        Map<String, Object> binds = new Map<String, Object>{ 'recordId' => recordId };
        String filter;
        if (type == Meeting_Brief__c.SObjectType) {
            filter = 'Id = :recordId';
        } else if (type == Account.SObjectType) {
            filter = 'Account__c = :recordId';
        } else if (type == Task.SObjectType || type == Event.SObjectType) {
            List<SObject> activities = Database.queryWithBinds(
                'SELECT Meeting_Brief__c FROM ' + type + ' WHERE Id = :recordId', binds, AccessLevel.USER_MODE
            );
            if (activities.isEmpty() || activities[0].get('Meeting_Brief__c') == null) {
                return null;
            }
            binds.put('recordId', activities[0].get('Meeting_Brief__c'));
            filter = 'Id = :recordId';
        } else {
            return null;
        }
        List<Meeting_Brief__c> briefs = Database.queryWithBinds(
            'SELECT ' + MeetingBriefFormatter.BRIEF_FIELDS + ' FROM Meeting_Brief__c WHERE ' + filter
            + ' ORDER BY CreatedDate DESC, Id DESC LIMIT 1',
            binds, AccessLevel.USER_MODE
        );
        return briefs.isEmpty() ? null : briefs[0];
    }

    private static SObject loadMeeting(Id activityId) {
        Schema.SObjectType type = activityId.getSObjectType();
        if (type != Task.SObjectType && type != Event.SObjectType) {
            throw new BriefException('The meeting must be a Task or an Event.');
        }
        List<SObject> rows = Database.queryWithBinds(
            'SELECT Id, AccountId, Subject, ActivityDate, WhatId, WhoId, Who.Name FROM ' + type
            + ' WHERE Id = :activityId',
            new Map<String, Object>{ 'activityId' => activityId },
            AccessLevel.USER_MODE
        );
        if (rows.isEmpty()) {
            throw new BriefException('The meeting was not found or you do not have access to it.');
        }
        return rows[0];
    }

    private static Account loadAccount(Id accountId) {
        List<Account> accounts = [
            SELECT Id, Name, Website, BillingCountry, ShippingCountry, Enrichment_Entity_Id__c
            FROM Account
            WHERE Id = :accountId
            WITH USER_MODE
        ];
        if (accounts.isEmpty()) {
            throw new BriefException('The account was not found or you do not have access to it.');
        }
        return accounts[0];
    }

    private static AuraHandledException auraError(String message) {
        AuraHandledException error = new AuraHandledException(message);
        error.setMessage(message);
        return error;
    }
}
