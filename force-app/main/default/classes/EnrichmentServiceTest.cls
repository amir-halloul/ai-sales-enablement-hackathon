@IsTest
private class EnrichmentServiceTest {
    private static final String TESTER = 'EnrichTester';
    private static final String NO_ACCESS = 'EnrichNoAccess';

    @TestSetup
    static void setup() {
        AcmeTestData.createUser(TESTER, true);
        AcmeTestData.createUser(NO_ACCESS, false);
    }

    @IsTest
    static void enrichesBlankAccountFieldsAndKeepsPartialAddresses() {
        AcmeTestData.EnrichmentMock mock = new AcmeTestData.EnrichmentMock();
        Test.setMock(HttpCalloutMock.class, mock);
        System.runAs(AcmeTestData.findUser(TESTER)) {
            Account account = new Account(Name = 'Northwind Traders', BillingCountry = 'United States', Phone = '555-0000');
            insert account;

            Test.startTest();
            EnrichmentService.Result result = EnrichmentService.enrichRecord(account.Id);
            Test.stopTest();

            Assert.areEqual(EnrichmentService.STATUS_SUCCEEDED, result.status);
            Assert.areEqual(1, mock.identifyCalls);
            account = [
                SELECT Description, NumberOfEmployees, AnnualRevenue, TickerSymbol, Phone, Website, BillingCity,
                       Enrichment_Status__c, Enrichment_Entity_Id__c, Last_Enriched_On__c
                FROM Account WHERE Id = :account.Id
            ];
            Assert.areEqual('Food and beverage wholesaler.', account.Description);
            Assert.areEqual(1200, account.NumberOfEmployees, 'Medium confidence values are written');
            Assert.areEqual('https://northwind.example.com', account.Website);
            Assert.areEqual('555-0000', account.Phone, 'Filled fields are never overwritten');
            Assert.isNull(account.TickerSymbol, 'Low confidence values are skipped');
            Assert.isNull(account.BillingCity, 'A partly filled address group is skipped');
            Assert.areEqual('ent_1', account.Enrichment_Entity_Id__c);
            Assert.isNotNull(account.Last_Enriched_On__c);
            Assert.isTrue(result.message.startsWith('Enrichment completed.'));
        }
    }

    @IsTest
    static void enrichesLeadWithKnownEntityWithoutIdentify() {
        AcmeTestData.EnrichmentMock mock = new AcmeTestData.EnrichmentMock();
        mock.completeness = 'partial';
        Test.setMock(HttpCalloutMock.class, mock);
        User tester = AcmeTestData.findUser(TESTER);
        Lead lead = new Lead(LastName = 'Lee', Company = 'Northwind Traders', Enrichment_Entity_Id__c = 'ent_1', OwnerId = tester.Id);
        Database.insert(lead, AccessLevel.SYSTEM_MODE);
        System.runAs(tester) {
            Test.startTest();
            List<AgentEnrichRecord.Response> responses = AgentEnrichRecord.enrich(new List<AgentEnrichRecord.Request>{ request(lead.Id) });
            Test.stopTest();

            Assert.areEqual(EnrichmentService.STATUS_PARTIAL, responses[0].status);
            Assert.areEqual(0, mock.identifyCalls);
            lead = [SELECT Title, City, Country FROM Lead WHERE Id = :lead.Id];
            Assert.areEqual('Chief Financial Officer', lead.Title);
            Assert.areEqual('Seattle', lead.City);
        }
    }

    @IsTest
    static void dropsStatesOutsideTheStatePicklist() {
        AcmeTestData.EnrichmentMock mock = new AcmeTestData.EnrichmentMock();
        mock.addressState = 'Atlantis';
        Test.setMock(HttpCalloutMock.class, mock);
        User tester = AcmeTestData.findUser(TESTER);
        Lead lead = new Lead(LastName = 'Lee', Company = 'Northwind Traders', Enrichment_Entity_Id__c = 'ent_1', OwnerId = tester.Id);
        Database.insert(lead, AccessLevel.SYSTEM_MODE);
        System.runAs(tester) {
            Test.startTest();
            EnrichmentService.Result result = EnrichmentService.enrichRecord(lead.Id);
            Test.stopTest();

            Assert.areEqual(EnrichmentService.STATUS_SUCCEEDED, result.status, result.message);
            lead = [SELECT City, State, Country FROM Lead WHERE Id = :lead.Id];
            Assert.areEqual('Seattle', lead.City);
            Assert.areEqual('United States', lead.Country);
            if (Schema.SObjectType.Lead.fields.getMap().containsKey('StateCode')) {
                Assert.isNull(lead.State, 'Unknown states are dropped when state picklists are enabled');
            }
        }
    }

    @IsTest
    static void reportsNoMatch() {
        EnrichmentService.Result result = enrichWith('no_match', 200);
        Assert.areEqual(EnrichmentService.STATUS_NO_MATCH, result.status);
        Assert.isTrue(result.message.startsWith('No matching company'));
    }

    @IsTest
    static void reportsAmbiguousMatch() {
        Assert.areEqual(EnrichmentService.STATUS_AMBIGUOUS, enrichWith('ambiguous', 200).status);
    }

    @IsTest
    static void reportsProviderFailures() {
        EnrichmentService.Result result = enrichWith('matched', 500);
        Assert.areEqual(EnrichmentService.STATUS_FAILED, result.status);
        Assert.isTrue(result.message.contains('HTTP 500'));
        Assert.areEqual(EnrichmentService.STATUS_FAILED,
            [SELECT Enrichment_Status__c FROM Account WHERE Id = :result.recordId WITH SYSTEM_MODE].Enrichment_Status__c);
    }

    private static EnrichmentService.Result enrichWith(String identifyStatus, Integer statusCode) {
        AcmeTestData.EnrichmentMock mock = new AcmeTestData.EnrichmentMock();
        mock.identifyStatus = identifyStatus;
        mock.statusCode = statusCode;
        Test.setMock(HttpCalloutMock.class, mock);
        EnrichmentService.Result result;
        System.runAs(AcmeTestData.findUser(TESTER)) {
            Account account = new Account(Name = 'Summit');
            insert account;
            Test.startTest();
            result = EnrichmentService.enrich(account.Id);
            Test.stopTest();
        }
        return result;
    }

    @IsTest
    static void rejectsUsersWithoutPermissionAndInvalidIds() {
        Account account = new Account(Name = 'Northwind Traders');
        insert account;
        System.runAs(AcmeTestData.findUser(NO_ACCESS)) {
            try {
                EnrichmentService.enrichRecord(account.Id);
                Assert.fail('Expected a permission error');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('permission'));
            }
        }
        System.runAs(AcmeTestData.findUser(TESTER)) {
            List<AgentEnrichRecord.Response> responses = AgentEnrichRecord.enrich(new List<AgentEnrichRecord.Request>{
                request('not-an-id'), request(UserInfo.getUserId())
            });
            Assert.areEqual(EnrichmentService.STATUS_FAILED, responses[0].status);
            Assert.areEqual(EnrichmentService.STATUS_FAILED, responses[1].status);
        }
    }

    @IsTest
    static void fetchesCompanyDataWithoutDml() {
        Test.setMock(HttpCalloutMock.class, new AcmeTestData.EnrichmentMock());
        Account account = new Account(Name = 'Northwind Traders');
        Test.startTest();
        String body = EnrichmentService.fetchCompanyData(account);
        Test.stopTest();
        Assert.isTrue(body.contains('newsHeadlines'));
    }

    private static AgentEnrichRecord.Request request(String recordId) {
        AgentEnrichRecord.Request request = new AgentEnrichRecord.Request();
        request.recordId = recordId;
        return request;
    }
}
