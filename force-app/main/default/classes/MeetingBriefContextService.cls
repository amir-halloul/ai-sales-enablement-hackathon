/**
 * Collects the grounding data of one meeting brief section as JSON with citation refs (PPL-n, PRD-n, OPP-n, CONV-n,
 * CMP-1, ENR-n, CAT-n). Used by the prompt grounding classes and by MeetingBriefService, which run in the same
 * transaction, so both see the same refs. The meeting and company data are primed by MeetingBriefService before the
 * prompts run; without them (e.g. in a Prompt Builder preview) the brief is built from CRM data only.
 */
public with sharing class MeetingBriefContextService {
    public class ContextException extends Exception {}

    public class SectionContext {
        public String promptText;
        // { "OPP-1": { recordId, label, date, type } } or { "ENR-1": { url, label, date, type } }
        public Map<String, Map<String, Object>> references = new Map<String, Map<String, Object>>();
        // [{ source, label, status, count, period }]
        public List<Map<String, Object>> coverage = new List<Map<String, Object>>();
        // full record lists shown under the AI summary, e.g. { products: [...] }
        public Map<String, Object> lists = new Map<String, Object>();
    }

    public static final String COVERAGE_AVAILABLE = 'Available';
    public static final String COVERAGE_EMPTY = 'Empty';
    public static final String COVERAGE_UNAVAILABLE = 'Unavailable';

    private static final Integer PRODUCT_ROW_LIMIT = 1000;
    private static final Integer PRODUCT_LIMIT = 60;
    private static final Integer LAPSED_PRODUCT_LIMIT = 30;
    private static final Integer EXPIRED_PRODUCT_YEARS = 5;
    private static final Integer RENEWAL_WINDOW_DAYS = 180;
    private static final Integer OPEN_OPPORTUNITY_LIMIT = 50;
    private static final Integer CLOSED_OPPORTUNITY_LIMIT = 10;
    private static final Integer CLOSED_OPPORTUNITY_YEARS = 3;
    private static final Integer CONVERSATION_LIMIT = 30;
    private static final Integer CONVERSATION_MONTHS = 12;
    private static final Decimal CONVERSATION_MIN_MINUTES = 1;
    private static final Integer PEOPLE_LIMIT = 3;
    private static final Integer LIST_LIMIT = 200;
    private static final Integer SUMMARY_MAX_LENGTH = 1500;
    private static final Integer DETAIL_MAX_LENGTH = 300;
    private static final Integer LABEL_MAX_LENGTH = 120;
    @TestVisible private static String catalogResource = 'Acme_Product_Catalog';

    private static final List<String> SIGNAL_LISTS = new List<String>{ 'newsHeadlines', 'growthSignals', 'openPositions' };
    // enrichment lists whose items get ENR-n refs, in numbering order
    private static final List<String> LINKED_ENRICHMENT_LISTS = new List<String>{
        'newsHeadlines', 'growthSignals', 'openPositions', 'competitors'
    };
    private static final Map<String, String> LINKED_ENRICHMENT_TYPES = new Map<String, String>{
        'newsHeadlines' => 'News',
        'growthSignals' => 'Growth Signal',
        'openPositions' => 'Open Position',
        'competitors' => 'Competitor'
    };
    private static final Set<String> DROPPED_ENRICHMENT_KEYS = new Set<String>{
        'sources', 'providers', 'warnings', 'entityId', 'entityType'
    };
    private static final List<String> SNAPSHOT_ATTRIBUTES = new List<String>{
        'name', 'industry', 'headcount', 'annualRevenueUsd', 'website', 'tickerSymbol', 'foundedYear', 'description'
    };

    private class Inputs {
        SObject meeting;
        Map<String, Object> companyData;
    }

    private static final Map<Id, Inputs> PRIMED = new Map<Id, Inputs>();
    private static final Map<String, SectionContext> CACHE = new Map<String, SectionContext>();

    /**
     * @param meeting Task or Event queried with Subject, ActivityDate, WhatId, WhoId and Who.Name; may be null.
     * @param enrichmentBody Raw enrich response; null when company data is unavailable.
     */
    public static void prime(Id accountId, SObject meeting, String enrichmentBody) {
        Inputs inputs = new Inputs();
        inputs.meeting = meeting;
        inputs.companyData = parseObject(enrichmentBody);
        PRIMED.put(accountId, inputs);
        for (String key : new List<String>(CACHE.keySet())) {
            if (key.startsWith(accountId + ':')) {
                CACHE.remove(key);
            }
        }
    }

    public static SectionContext forSection(Id accountId, String sectionKey) {
        if (accountId == null) {
            throw new ContextException('An account Id is required.');
        }
        MeetingBriefSections.Section section = MeetingBriefSections.get(sectionKey);
        String cacheKey = accountId + ':' + section.key;
        if (!CACHE.containsKey(cacheKey)) {
            CACHE.put(cacheKey, build(accountId, section));
        }
        return CACHE.get(cacheKey);
    }

    // { crmAsOf, meeting { recordId, subject, date, type, contact }, company { asOf, name, industry, headcount, ... } }
    public static String buildSnapshot(Id accountId) {
        Inputs inputs = PRIMED.get(accountId);
        Map<String, Object> snapshot = new Map<String, Object>{ 'crmAsOf' => Datetime.now() };
        if (inputs?.meeting != null) {
            Map<String, Object> meeting = meetingInfo(inputs.meeting);
            meeting.put('recordId', inputs.meeting.Id);
            snapshot.put('meeting', meeting);
        }
        if (inputs?.companyData != null) {
            Map<String, Object> company = new Map<String, Object>{ 'asOf' => inputs.companyData.get('retrievedAt') };
            for (String key : SNAPSHOT_ATTRIBUTES) {
                Object value = attributeValue(inputs.companyData.get(key));
                if (value != null) {
                    company.put(key, value);
                }
            }
            snapshot.put('company', company);
        }
        return JSON.serialize(snapshot, true);
    }

    private static SectionContext build(Id accountId, MeetingBriefSections.Section section) {
        List<Account> accounts = [SELECT Name FROM Account WHERE Id = :accountId WITH USER_MODE];
        if (accounts.isEmpty()) {
            throw new ContextException('The account was not found or you do not have access to it.');
        }
        Inputs inputs = PRIMED.containsKey(accountId) ? PRIMED.get(accountId) : new Inputs();
        SObject meeting = inputs.meeting;
        Id meetingOpportunityId = meetingOpportunityId(meeting);
        Boolean keepLists = section.key == MeetingBriefSections.ACCOUNT_HEALTH;

        SectionContext context = new SectionContext();
        Map<String, Object> payload = new Map<String, Object>{
            'section' => section.key,
            'today' => Date.today(),
            'account' => new Map<String, Object>{ 'name' => accounts[0].Name }
        };
        if (meeting != null) {
            payload.put('meeting', meetingInfo(meeting));
        }
        Set<String> sources = section.sources;
        if (sources.contains(MeetingBriefSections.SOURCE_PEOPLE)) {
            addPeople(accountId, meeting, meetingOpportunityId, context, payload);
        }
        if (sources.contains(MeetingBriefSections.SOURCE_PRODUCTS)) {
            addProducts(accountId, keepLists, context, payload);
        }
        if (sources.contains(MeetingBriefSections.SOURCE_OPPORTUNITIES)) {
            addOpportunities(accountId, meetingOpportunityId, keepLists, context, payload);
        }
        if (sources.contains(MeetingBriefSections.SOURCE_CONVERSATIONS)) {
            addConversations(accountId, context, payload);
        }
        if (sources.contains(MeetingBriefSections.SOURCE_ENRICHMENT)) {
            addEnrichment(inputs.companyData, section.key == MeetingBriefSections.COMPANY_SIGNALS, context, payload);
        }
        if (sources.contains(MeetingBriefSections.SOURCE_CATALOG)) {
            addCatalog(context, payload);
        }
        context.promptText = JSON.serialize(payload, true);
        return context;
    }

    private static Map<String, Object> meetingInfo(SObject meeting) {
        return new Map<String, Object>{
            'subject' => meeting.get('Subject'),
            'date' => meeting.get('ActivityDate'),
            'type' => meeting.getSObjectType() == Event.SObjectType ? 'Event' : 'Task',
            'contact' => (String) meeting.getSObject('Who')?.get('Name')
        };
    }

    private static Id meetingOpportunityId(SObject meeting) {
        Id whatId = meeting == null ? null : (Id) meeting.get('WhatId');
        return whatId != null && whatId.getSObjectType() == Opportunity.SObjectType ? whatId : null;
    }

    // the meeting contact, then the contact roles of the meeting opportunity; without either, the most called contacts
    private static void addPeople(Id accountId, SObject meeting, Id meetingOpportunityId, SectionContext context,
        Map<String, Object> payload) {
        List<Id> contactIds = new List<Id>();
        Id whoId = meeting == null ? null : (Id) meeting.get('WhoId');
        Id meetingContactId = whoId != null && whoId.getSObjectType() == Contact.SObjectType ? whoId : null;
        if (meetingContactId != null) {
            contactIds.add(meetingContactId);
        }
        Map<Id, OpportunityContactRole> roles = new Map<Id, OpportunityContactRole>();
        Map<Id, Contact> contacts;
        try {
            if (meetingOpportunityId != null) {
                for (OpportunityContactRole role : [
                    SELECT ContactId, Role, IsPrimary
                    FROM OpportunityContactRole
                    WHERE OpportunityId = :meetingOpportunityId
                    WITH USER_MODE
                    ORDER BY IsPrimary DESC, CreatedDate, Id
                    LIMIT 50
                ]) {
                    if (!roles.containsKey(role.ContactId)) {
                        roles.put(role.ContactId, role);
                    }
                    if (contactIds.size() < PEOPLE_LIMIT && !contactIds.contains(role.ContactId)) {
                        contactIds.add(role.ContactId);
                    }
                }
            }
            if (contactIds.isEmpty()) {
                for (AggregateResult row : [
                    SELECT Contact__c contactId, COUNT(Id) calls
                    FROM Conversation__c
                    WHERE Contact__r.AccountId = :accountId
                    WITH USER_MODE
                    GROUP BY Contact__c
                    ORDER BY COUNT(Id) DESC
                    LIMIT :PEOPLE_LIMIT
                ]) {
                    contactIds.add((Id) row.get('contactId'));
                }
            }
            contacts = new Map<Id, Contact>([
                SELECT Id, Name, Title, Department FROM Contact WHERE Id IN :contactIds WITH USER_MODE
            ]);
        } catch (QueryException e) {
            addCoverage(context, MeetingBriefSections.SOURCE_PEOPLE, 'People', null, null);
            return;
        }
        Map<Id, AggregateResult> calls = callsByContact(contacts.keySet());

        List<Map<String, Object>> people = new List<Map<String, Object>>();
        for (Id contactId : contactIds) {
            Contact person = contacts.get(contactId);
            if (person == null) {
                continue;
            }
            OpportunityContactRole role = roles.get(contactId);
            AggregateResult callRow = calls?.get(contactId);
            Integer callCount = calls == null ? null : (callRow == null ? 0 : (Integer) callRow.get('calls'));
            Datetime lastCall = callRow == null ? null : (Datetime) callRow.get('lastCall');

            String ref = 'PPL-' + (people.size() + 1);
            Map<String, Object> reference = recordReference(contactId, person.Name, lastCall, 'Contact');
            reference.put('title', person.Title);
            reference.put('role', role?.Role);
            reference.put('primary', role?.IsPrimary == true);
            reference.put('calls', callCount);
            context.references.put(ref, reference);

            people.add(new Map<String, Object>{
                'ref' => ref,
                'name' => person.Name,
                'title' => person.Title,
                'department' => person.Department,
                'opportunityRole' => role?.Role,
                'isPrimaryOnOpportunity' => role?.IsPrimary == true,
                'isMeetingContact' => contactId == meetingContactId,
                'callsLast12Months' => callCount,
                'lastCallDate' => lastCall
            });
        }
        payload.put('people', people);
        addCoverage(context, MeetingBriefSections.SOURCE_PEOPLE, 'People', people.size(), null);
    }

    // null when conversations are not readable
    private static Map<Id, AggregateResult> callsByContact(Set<Id> contactIds) {
        Map<Id, AggregateResult> calls = new Map<Id, AggregateResult>();
        if (contactIds.isEmpty()) {
            return calls;
        }
        Datetime since = Datetime.now().addMonths(-CONVERSATION_MONTHS);
        try {
            for (AggregateResult row : [
                SELECT Contact__c contactId, COUNT(Id) calls, MAX(Start_Time__c) lastCall
                FROM Conversation__c
                WHERE Contact__c IN :contactIds
                AND Start_Time__c >= :since
                AND Duration_Minutes__c >= :CONVERSATION_MIN_MINUTES
                WITH USER_MODE
                GROUP BY Contact__c
            ]) {
                calls.put((Id) row.get('contactId'), row);
            }
        } catch (QueryException e) {
            return null;
        }
        return calls;
    }

    // subscriptions are merged by product name: owned = any active row, lapsed = only rows that ended in the last 5 years
    private static void addProducts(Id accountId, Boolean keepLists, SectionContext context, Map<String, Object> payload) {
        Date today = Date.today();
        Date expiredSince = today.addYears(-EXPIRED_PRODUCT_YEARS);
        List<Product_Subscription__c> rows;
        try {
            rows = [
                SELECT Id, Name, Product_Name__c, Quantity__c, Start_Date__c, End_Date__c
                FROM Product_Subscription__c
                WHERE Account__c = :accountId AND (End_Date__c = null OR End_Date__c >= :expiredSince)
                WITH USER_MODE
                ORDER BY Product_Name__c, End_Date__c DESC NULLS FIRST, Id
                LIMIT :PRODUCT_ROW_LIMIT
            ];
        } catch (QueryException e) {
            addCoverage(context, MeetingBriefSections.SOURCE_PRODUCTS, 'Products', null, null);
            return;
        }

        Map<String, ProductGroup> ownedByName = new Map<String, ProductGroup>();
        Map<String, ProductGroup> expiredByName = new Map<String, ProductGroup>();
        for (Product_Subscription__c row : rows) {
            String name = String.isBlank(row.Product_Name__c) ? row.Name : row.Product_Name__c.trim();
            Boolean active = row.End_Date__c == null || row.End_Date__c >= today;
            Map<String, ProductGroup> groups = active ? ownedByName : expiredByName;
            String key = name.toLowerCase();
            if (!groups.containsKey(key)) {
                groups.put(key, new ProductGroup(name, row.Id));
            }
            groups.get(key).add(row, active);
        }
        for (String key : ownedByName.keySet()) {
            expiredByName.remove(key);
        }
        List<ProductGroup> owned = sortByEndDate(ownedByName.values(), true);
        List<ProductGroup> lapsed = sortByEndDate(expiredByName.values(), false);

        Integer endingSoon = 0;
        Date renewalWindowEnd = today.addDays(RENEWAL_WINDOW_DAYS);
        for (ProductGroup product : owned) {
            if (product.endDate != null && product.endDate <= renewalWindowEnd) {
                endingSoon++;
            }
        }

        Integer index = 0;
        List<Map<String, Object>> ownedItems = new List<Map<String, Object>>();
        for (ProductGroup product : firstGroups(owned, PRODUCT_LIMIT)) {
            String ref = 'PRD-' + (++index);
            context.references.put(ref, recordReference(product.recordId, product.name, product.endDate, 'Product'));
            ownedItems.add(new Map<String, Object>{
                'ref' => ref,
                'product' => product.name,
                'licenses' => product.licenses,
                'startDate' => product.startDate,
                'nextEndDate' => product.endDate,
                'rows' => product.rows
            });
        }
        List<Map<String, Object>> lapsedItems = new List<Map<String, Object>>();
        for (ProductGroup product : firstGroups(lapsed, LAPSED_PRODUCT_LIMIT)) {
            String ref = 'PRD-' + (++index);
            context.references.put(ref, recordReference(product.recordId, product.name, product.endDate, 'Lapsed Product'));
            lapsedItems.add(new Map<String, Object>{
                'ref' => ref,
                'product' => product.name,
                'licenses' => product.licenses,
                'endedOn' => product.endDate
            });
        }
        payload.put('products', new Map<String, Object>{
            'owned' => ownedItems,
            'ownedCount' => owned.size(),
            'endingWithin180Days' => endingSoon,
            'lapsed' => lapsedItems,
            'lapsedCount' => lapsed.size()
        });
        if (keepLists) {
            context.lists.put('products', productList(owned));
            context.lists.put('lapsedProducts', productList(lapsed));
        }
        addCoverage(context, MeetingBriefSections.SOURCE_PRODUCTS, 'Products', owned.size() + lapsed.size(), null);
    }

    private class ProductGroup {
        String name;
        Id recordId;
        Integer rows = 0;
        Decimal licenses = 0;
        Date startDate;
        // owned: the next end date of its active rows; lapsed: the last end date
        Date endDate;

        ProductGroup(String name, Id recordId) {
            this.name = name;
            this.recordId = recordId;
        }

        void add(Product_Subscription__c row, Boolean active) {
            rows++;
            Decimal quantity = row.Quantity__c == null ? 0 : row.Quantity__c;
            if (active) {
                licenses += quantity;
                if (row.Start_Date__c != null && (startDate == null || row.Start_Date__c < startDate)) {
                    startDate = row.Start_Date__c;
                }
                if (row.End_Date__c != null && (endDate == null || row.End_Date__c < endDate)) {
                    endDate = row.End_Date__c;
                }
            } else if (endDate == null || row.End_Date__c > endDate) {
                // licenses of the last term, not the sum of all past terms
                endDate = row.End_Date__c;
                licenses = quantity;
                startDate = row.Start_Date__c;
            }
        }
    }

    // soonestFirst: no end date last; otherwise latest first
    private static List<ProductGroup> sortByEndDate(List<ProductGroup> groups, Boolean soonestFirst) {
        Map<String, ProductGroup> byKey = new Map<String, ProductGroup>();
        for (ProductGroup product : groups) {
            String dateKey = product.endDate == null ? '9999-12-31' : String.valueOf(product.endDate);
            byKey.put(dateKey + '|' + product.name.toLowerCase(), product);
        }
        List<String> keys = new List<String>(byKey.keySet());
        keys.sort();
        List<ProductGroup> sorted = new List<ProductGroup>();
        for (Integer i = 0; i < keys.size(); i++) {
            sorted.add(byKey.get(keys[soonestFirst ? i : keys.size() - 1 - i]));
        }
        return sorted;
    }

    private static List<ProductGroup> firstGroups(List<ProductGroup> groups, Integer max) {
        List<ProductGroup> result = new List<ProductGroup>();
        for (Integer i = 0; i < Math.min(max, groups.size()); i++) {
            result.add(groups[i]);
        }
        return result;
    }

    private static List<Map<String, Object>> productList(List<ProductGroup> groups) {
        List<Map<String, Object>> items = new List<Map<String, Object>>();
        for (ProductGroup product : firstGroups(groups, LIST_LIMIT)) {
            items.add(new Map<String, Object>{
                'recordId' => product.recordId,
                'name' => product.name,
                'licenses' => product.licenses,
                'startDate' => product.startDate,
                'endDate' => product.endDate
            });
        }
        return items;
    }

    private static void addOpportunities(Id accountId, Id meetingOpportunityId, Boolean keepLists, SectionContext context,
        Map<String, Object> payload) {
        String fields = 'Id, Name, StageName, FORMAT(Amount) formattedAmount, CloseDate, Type, NextStep, IsWon, Description';
        Map<String, Object> binds = new Map<String, Object>{
            'accountId' => accountId,
            'meetingOpportunityId' => meetingOpportunityId,
            'closedSince' => Date.today().addYears(-CLOSED_OPPORTUNITY_YEARS),
            'openLimit' => OPEN_OPPORTUNITY_LIMIT,
            'closedLimit' => CLOSED_OPPORTUNITY_LIMIT
        };
        List<Opportunity> current;
        List<Opportunity> previous;
        try {
            current = Database.queryWithBinds(
                'SELECT ' + fields + ' FROM Opportunity'
                + ' WHERE AccountId = :accountId AND (IsClosed = false OR Id = :meetingOpportunityId)'
                + ' ORDER BY CloseDate, Id LIMIT :openLimit',
                binds, AccessLevel.USER_MODE
            );
            previous = Database.queryWithBinds(
                'SELECT ' + fields + ' FROM Opportunity'
                + ' WHERE AccountId = :accountId AND IsClosed = true AND CloseDate >= :closedSince'
                + ' AND Id != :meetingOpportunityId'
                + ' ORDER BY CloseDate DESC, Id LIMIT :closedLimit',
                binds, AccessLevel.USER_MODE
            );
        } catch (QueryException e) {
            addCoverage(context, MeetingBriefSections.SOURCE_OPPORTUNITIES, 'Opportunities', null, null);
            return;
        }

        Integer index = 0;
        List<Map<String, Object>> currentItems = new List<Map<String, Object>>();
        for (Opportunity opp : current) {
            String ref = 'OPP-' + (++index);
            context.references.put(ref, recordReference(opp.Id, opp.Name, opp.CloseDate, 'Opportunity'));
            Map<String, Object> item = opportunityItem(opp, ref);
            item.put('nextStep', opp.NextStep);
            item.put('isMeetingOpportunity', opp.Id == meetingOpportunityId);
            currentItems.add(item);
        }
        List<Map<String, Object>> previousItems = new List<Map<String, Object>>();
        for (Opportunity opp : previous) {
            String ref = 'OPP-' + (++index);
            context.references.put(ref, recordReference(opp.Id, opp.Name, opp.CloseDate, 'Opportunity'));
            Map<String, Object> item = opportunityItem(opp, ref);
            item.put('outcome', opp.IsWon ? 'Won' : 'Lost');
            previousItems.add(item);
        }
        payload.put('currentOpportunities', currentItems);
        payload.put('previousOpportunities', previousItems);
        if (keepLists) {
            context.lists.put('openOpportunities', opportunityList(current, false));
            context.lists.put('closedOpportunities', opportunityList(previous, true));
        }
        addCoverage(context, MeetingBriefSections.SOURCE_OPPORTUNITIES, 'Opportunities', index, null);
    }

    private static Map<String, Object> opportunityItem(Opportunity opp, String ref) {
        return new Map<String, Object>{
            'ref' => ref,
            'name' => opp.Name,
            'stage' => opp.StageName,
            'amount' => opp.get('formattedAmount'),
            'closeDate' => opp.CloseDate,
            'type' => opp.Type,
            'notes' => shorten(opp.Description, DETAIL_MAX_LENGTH)
        };
    }

    private static List<Map<String, Object>> opportunityList(List<Opportunity> opportunities, Boolean closed) {
        List<Map<String, Object>> items = new List<Map<String, Object>>();
        for (Opportunity opp : opportunities) {
            items.add(new Map<String, Object>{
                'recordId' => opp.Id,
                'name' => opp.Name,
                'stage' => opp.StageName,
                'amount' => opp.get('formattedAmount'),
                'closeDate' => opp.CloseDate,
                'outcome' => closed ? (opp.IsWon ? 'Won' : 'Lost') : null
            });
        }
        return items;
    }

    private static void addConversations(Id accountId, SectionContext context, Map<String, Object> payload) {
        Datetime since = Datetime.now().addMonths(-CONVERSATION_MONTHS);
        List<Conversation__c> rows;
        try {
            rows = [
                SELECT Id, Name, Start_Time__c, Type__c, Direction__c, Disposition__c, Subject__c, Summary__c,
                       Sentiment__c, Duration_Minutes__c, Contact__r.Name, Opportunity__r.Name
                FROM Conversation__c
                WHERE Start_Time__c >= :since
                AND Duration_Minutes__c >= :CONVERSATION_MIN_MINUTES
                AND (
                    Account__c = :accountId
                    OR Contact__r.AccountId = :accountId
                    OR Opportunity__r.AccountId = :accountId
                )
                WITH USER_MODE
                ORDER BY Start_Time__c DESC, Id
                LIMIT :CONVERSATION_LIMIT
            ];
        } catch (QueryException e) {
            addCoverage(context, MeetingBriefSections.SOURCE_CONVERSATIONS, 'Conversations', null, null);
            return;
        }

        List<Map<String, Object>> conversations = new List<Map<String, Object>>();
        for (Conversation__c row : rows) {
            String subject = String.isBlank(row.Subject__c) ? row.Name : row.Subject__c;
            String type = String.isBlank(row.Type__c) ? 'Conversation' : row.Type__c;
            String ref = 'CONV-' + (conversations.size() + 1);
            Map<String, Object> reference = recordReference(row.Id, shorten(subject, LABEL_MAX_LENGTH), row.Start_Time__c, type);
            reference.put('contact', row.Contact__r?.Name);
            context.references.put(ref, reference);
            conversations.add(new Map<String, Object>{
                'ref' => ref,
                'date' => row.Start_Time__c,
                'type' => type,
                'direction' => row.Direction__c,
                'disposition' => row.Disposition__c,
                'subject' => subject,
                'contact' => row.Contact__r?.Name,
                'opportunity' => row.Opportunity__r?.Name,
                'durationMinutes' => row.Duration_Minutes__c,
                'sentiment' => row.Sentiment__c,
                'summary' => shorten(row.Summary__c, SUMMARY_MAX_LENGTH)
            });
        }
        payload.put('conversations', conversations);
        addCoverage(context, MeetingBriefSections.SOURCE_CONVERSATIONS, 'Conversations', conversations.size(),
            'last ' + CONVERSATION_MONTHS + ' months');
    }

    private static void addEnrichment(Map<String, Object> raw, Boolean keepLists, SectionContext context,
        Map<String, Object> payload) {
        if (raw == null) {
            addCoverage(context, MeetingBriefSections.SOURCE_ENRICHMENT, 'Company data', null, null);
            return;
        }
        Map<String, Object> data = (Map<String, Object>) trimNode(raw);
        List<String> conflicts = conflictingFields(raw.get('warnings'));
        if (!conflicts.isEmpty()) {
            data.put('conflictingFields', conflicts);
        }

        // company attributes such as industry or headcount are cited with the company data itself
        data.put('ref', 'CMP-1');
        String companyName = valueText(raw.get('name'));
        context.references.put('CMP-1', new Map<String, Object>{
            'label' => companyName != null ? companyName : 'Company profile',
            'date' => raw.get('retrievedAt'),
            'type' => 'Company Data'
        });
        Integer index = 0;
        for (String listKey : LINKED_ENRICHMENT_LISTS) {
            if (!(data.get(listKey) instanceof List<Object>)) {
                continue;
            }
            List<Object> rawItems = (List<Object>) raw.get(listKey);
            List<Object> items = (List<Object>) data.get(listKey);
            String type = LINKED_ENRICHMENT_TYPES.get(listKey);
            for (Integer i = 0; i < items.size(); i++) {
                if (!(items[i] instanceof Map<String, Object>)) {
                    continue;
                }
                Map<String, Object> entry = (Map<String, Object>) items[i];
                String ref = 'ENR-' + (++index);
                entry.put('ref', ref);
                String value = valueText(entry);
                context.references.put(ref, new Map<String, Object>{
                    'url' => firstUrl(((Map<String, Object>) rawItems[i]).get('sources')),
                    'label' => value != null ? shorten(value, LABEL_MAX_LENGTH) : type,
                    'date' => entry.get('date'),
                    'type' => type
                });
            }
        }
        if (keepLists) {
            for (String listKey : SIGNAL_LISTS) {
                if (data.get(listKey) instanceof List<Object>) {
                    context.lists.put(listKey, data.get(listKey));
                }
            }
        }
        data.remove('socialProfiles');
        payload.put('companyData', data);
        context.coverage.add(new Map<String, Object>{
            'source' => MeetingBriefSections.SOURCE_ENRICHMENT,
            'label' => 'Company data',
            'status' => COVERAGE_AVAILABLE
        });
    }

    // acmeProducts: the Acme Cloud catalog static resource { url, products [{ name, area, whatItIs, ... }] }
    private static void addCatalog(SectionContext context, Map<String, Object> payload) {
        List<StaticResource> resources = [
            SELECT Body FROM StaticResource WHERE Name = :catalogResource AND NamespacePrefix = null LIMIT 1
        ];
        Map<String, Object> catalog = resources.isEmpty() ? null : parseObject(resources[0].Body.toString());
        if (catalog == null || !(catalog.get('products') instanceof List<Object>)) {
            return;
        }
        String url = catalog.get('url') instanceof String ? (String) catalog.get('url') : null;
        List<Object> products = new List<Object>();
        Integer index = 0;
        for (Object item : (List<Object>) catalog.get('products')) {
            if (!(item instanceof Map<String, Object>)) {
                continue;
            }
            Map<String, Object> product = (Map<String, Object>) item;
            String ref = 'CAT-' + (++index);
            product.put('ref', ref);
            context.references.put(ref, new Map<String, Object>{
                'url' => url,
                'label' => product.get('name'),
                'type' => 'Acme Product'
            });
            products.add(product);
        }
        payload.put('acmeProducts', products);
    }

    private static Object trimNode(Object node) {
        if (node instanceof List<Object>) {
            List<Object> items = new List<Object>();
            for (Object item : (List<Object>) node) {
                items.add(trimNode(item));
            }
            return items;
        }
        if (node instanceof Map<String, Object>) {
            Map<String, Object> source = (Map<String, Object>) node;
            Map<String, Object> result = new Map<String, Object>();
            for (String key : source.keySet()) {
                if (!DROPPED_ENRICHMENT_KEYS.contains(key)) {
                    result.put(key, trimNode(source.get(key)));
                }
            }
            return result;
        }
        return node;
    }

    private static List<String> conflictingFields(Object warnings) {
        List<String> fields = new List<String>();
        if (!(warnings instanceof List<Object>)) {
            return fields;
        }
        for (Object warning : (List<Object>) warnings) {
            if (warning instanceof Map<String, Object>) {
                Map<String, Object> entry = (Map<String, Object>) warning;
                if ('conflicting_values'.equals(entry.get('code')) && entry.get('attribute') instanceof String) {
                    fields.add((String) entry.get('attribute'));
                }
            }
        }
        return fields;
    }

    private static Object attributeValue(Object attribute) {
        return attribute instanceof Map<String, Object> ? ((Map<String, Object>) attribute).get('value') : attribute;
    }

    private static String valueText(Object attribute) {
        Object value = attributeValue(attribute);
        return value instanceof String ? (String) value : null;
    }

    private static String firstUrl(Object sources) {
        if (!(sources instanceof List<Object>)) {
            return null;
        }
        for (Object source : (List<Object>) sources) {
            if (source instanceof Map<String, Object>) {
                Object reference = ((Map<String, Object>) source).get('sourceReference');
                if (reference instanceof String && ((String) reference).startsWithIgnoreCase('https://')) {
                    return (String) reference;
                }
            }
        }
        return null;
    }

    private static Map<String, Object> recordReference(Id recordId, String label, Object dateValue, String type) {
        return new Map<String, Object>{ 'recordId' => recordId, 'label' => label, 'date' => dateValue, 'type' => type };
    }

    private static void addCoverage(SectionContext context, String source, String label, Integer count, String period) {
        String status = count == null ? COVERAGE_UNAVAILABLE : (count == 0 ? COVERAGE_EMPTY : COVERAGE_AVAILABLE);
        context.coverage.add(new Map<String, Object>{
            'source' => source,
            'label' => label,
            'status' => status,
            'count' => count,
            'period' => period
        });
    }

    private static Map<String, Object> parseObject(String text) {
        if (String.isBlank(text)) {
            return null;
        }
        try {
            Object parsed = JSON.deserializeUntyped(text);
            return parsed instanceof Map<String, Object> ? (Map<String, Object>) parsed : null;
        } catch (JSONException e) {
            return null;
        }
    }

    private static String shorten(String text, Integer maxLength) {
        if (String.isBlank(text)) {
            return null;
        }
        String trimmed = text.normalizeSpace();
        return trimmed.length() <= maxLength ? trimmed : trimmed.left(maxLength - 3).trim() + ' […]';
    }
}
