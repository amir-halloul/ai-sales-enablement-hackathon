@IsTest
public class AcmeTestData {
    public static final String PERMISSION_SET = 'Acme_Sales_Enablement';

    public static User createUser(String lastName, Boolean withPermissions) {
        Profile profile = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        String unique = EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(12);
        User user = new User(
            Alias = 'acmet',
            Email = 'acme.test@example.com',
            EmailEncodingKey = 'UTF-8',
            FirstName = 'Acme',
            LastName = lastName,
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = profile.Id,
            TimeZoneSidKey = 'America/New_York',
            Username = 'acme.' + unique + '@example.com.test'
        );
        insert user;
        if (withPermissions) {
            Id permissionSetId = [SELECT Id FROM PermissionSet WHERE Name = :PERMISSION_SET].Id;
            insert new PermissionSetAssignment(AssigneeId = user.Id, PermissionSetId = permissionSetId);
        }
        return user;
    }

    public static User findUser(String lastName) {
        return [SELECT Id FROM User WHERE LastName = :lastName AND FirstName = 'Acme' LIMIT 1];
    }

    // routes /v1/identify and /v1/enrich like the mock API
    public class EnrichmentMock implements HttpCalloutMock {
        public String identifyStatus = 'matched';
        public String completeness = 'complete';
        public Integer statusCode = 200;
        public String addressState = 'Washington';
        public Integer identifyCalls = 0;
        public Integer enrichCalls = 0;

        public HttpResponse respond(HttpRequest request) {
            HttpResponse response = new HttpResponse();
            response.setStatusCode(statusCode);
            response.setHeader('Content-Type', 'application/json');
            Map<String, Object> payload = (Map<String, Object>) JSON.deserializeUntyped(request.getBody());
            String entityType = (String) payload.get('entityType');
            if (request.getEndpoint().endsWith('/identify')) {
                identifyCalls++;
                response.setBody(JSON.serialize(new Map<String, Object>{
                    'entityType' => entityType,
                    'status' => identifyStatus,
                    'entityId' => identifyStatus == 'matched' ? 'ent_1' : null
                }));
            } else {
                enrichCalls++;
                response.setBody(enrichBody(entityType, completeness, addressState));
            }
            return response;
        }
    }

    public static String enrichBody(String entityType, String completeness) {
        return enrichBody(entityType, completeness, 'Washington');
    }

    public static String enrichBody(String entityType, String completeness, String addressState) {
        return JSON.serialize(new Map<String, Object>{
            'entityType' => entityType,
            'entityId' => 'ent_1',
            'completeness' => completeness,
            'retrievedAt' => '2026-01-15T10:00:00Z',
            'name' => attribute('Northwind Traders', 'high'),
            'industry' => attribute('Wholesale Distribution', 'high'),
            'description' => attribute('Food and beverage wholesaler.', 'very_high'),
            'headcount' => attribute(1200, 'medium'),
            'annualRevenueUsd' => attribute(250000000, 'high'),
            'tickerSymbol' => attribute('NWT', 'low'),
            'phone' => attribute('+1 206 555 0100', 'high'),
            'website' => attribute('https://northwind.example.com', 'high'),
            'jobTitle' => attribute('Chief Financial Officer', 'high'),
            'address' => attribute(new Map<String, Object>{
                'street' => '1 Pike Street',
                'city' => 'Seattle',
                'state' => addressState,
                'postalCode' => '98101',
                'country' => 'United States'
            }, 'high'),
            'warnings' => new List<Object>{ new Map<String, Object>{ 'code' => 'conflicting_values', 'attribute' => 'headcount' } },
            'providers' => new List<Object>{ 'mock' },
            'newsHeadlines' => new List<Object>{
                new Map<String, Object>{
                    'value' => 'Northwind opens an Austin distribution center',
                    'date' => '2026-01-05',
                    'confidence' => 'high',
                    'sources' => new List<Object>{
                        new Map<String, Object>{ 'sourceType' => 'news', 'sourceReference' => 'https://news.example.com/northwind' }
                    }
                }
            },
            'growthSignals' => new List<Object>{ attribute('Headcount up 15% this year', 'medium') },
            'openPositions' => new List<Object>{ attribute('Finance Systems Manager', 'high') },
            'competitors' => new List<Object>{ attribute('Contoso Foods', 'high') },
            'socialProfiles' => new List<Object>{ attribute('https://social.example.com/northwind', 'high') }
        });
    }

    private static Map<String, Object> attribute(Object value, String confidence) {
        return new Map<String, Object>{ 'value' => value, 'confidence' => confidence };
    }

    /**
     * Account with contacts, an open and a lost opportunity, subscriptions, conversations, an Event on the open
     * opportunity and a Task on the account. Keys: account, contact, opportunity, event, task.
     */
    public static Map<String, Id> createBriefData() {
        Account account = new Account(
            Name = 'Northwind Traders',
            Website = 'https://northwind.example.com',
            BillingCountry = 'United States'
        );
        insert account;
        Contact buyer = new Contact(AccountId = account.Id, FirstName = 'Dana', LastName = 'Lee', Title = 'CFO');
        Contact itLead = new Contact(AccountId = account.Id, FirstName = 'Sam', LastName = 'Ortiz', Title = 'IT Director');
        insert new List<Contact>{ buyer, itLead };
        Opportunity renewal = new Opportunity(
            AccountId = account.Id,
            Name = 'Northwind Analytics Renewal',
            StageName = 'Prospecting',
            CloseDate = Date.today().addDays(20),
            Amount = 50000,
            NextStep = 'Send renewal quote',
            Description = 'Customer wants a multi-year discount.'
        );
        Opportunity lost = new Opportunity(
            AccountId = account.Id,
            Name = 'Northwind Field Service',
            StageName = 'Closed Lost',
            CloseDate = Date.today().addMonths(-6),
            Amount = 20000
        );
        insert new List<Opportunity>{ renewal, lost };
        insert new OpportunityContactRole(OpportunityId = renewal.Id, ContactId = buyer.Id, Role = 'Decision Maker', IsPrimary = true);
        insert new List<Product_Subscription__c>{
            new Product_Subscription__c(Account__c = account.Id, Product_Name__c = 'Acme Analytics', Quantity__c = 50,
                Start_Date__c = Date.today().addYears(-1), End_Date__c = Date.today().addDays(60)),
            new Product_Subscription__c(Account__c = account.Id, Product_Name__c = 'Acme Analytics', Quantity__c = 25,
                Start_Date__c = Date.today().addMonths(-6)),
            new Product_Subscription__c(Account__c = account.Id, Product_Name__c = 'Acme CRM Cloud', Quantity__c = 120,
                Start_Date__c = Date.today().addYears(-2), End_Date__c = Date.today().addYears(1)),
            new Product_Subscription__c(Account__c = account.Id, Product_Name__c = 'Acme Legacy Reports', Quantity__c = 10,
                Start_Date__c = Date.today().addYears(-3), End_Date__c = Date.today().addYears(-1))
        };
        insert new List<Conversation__c>{
            new Conversation__c(Account__c = account.Id, Contact__c = buyer.Id, Opportunity__c = renewal.Id,
                Start_Time__c = Datetime.now().addDays(-10), Type__c = 'Call', Direction__c = 'Outbound',
                Subject__c = 'Renewal pricing', Summary__c = 'Dana asked for a pricing review before renewing.',
                Sentiment__c = 'Neutral', Duration_Minutes__c = 25),
            new Conversation__c(Contact__c = itLead.Id, Start_Time__c = Datetime.now().addDays(-40), Type__c = 'Video Meeting',
                Subject__c = 'Dashboards demo', Summary__c = 'Sam liked the new dashboards.', Sentiment__c = 'Positive',
                Duration_Minutes__c = 45)
        };
        Event meeting = new Event(
            WhatId = renewal.Id,
            WhoId = buyer.Id,
            Subject = 'Renewal review',
            StartDateTime = Datetime.now().addDays(2),
            DurationInMinutes = 30
        );
        insert meeting;
        Task call = new Task(WhatId = account.Id, Subject = 'Check-in call', ActivityDate = Date.today().addDays(5));
        insert call;
        return new Map<String, Id>{
            'account' => account.Id,
            'contact' => buyer.Id,
            'opportunity' => renewal.Id,
            'event' => meeting.Id,
            'task' => call.Id
        };
    }
}
