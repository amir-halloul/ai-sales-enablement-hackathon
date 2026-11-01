@IsTest
private class MeetingBriefServiceTest {
    private static final String TESTER = 'BriefTester';
    private static final String NO_ACCESS = 'BriefNoAccess';

    private class LlmException extends Exception {}

    // returns fixed section JSON after resolving the grounding class, as the prompt template does
    private class MockRunner implements MeetingBriefGenerator.PromptRunner {
        Set<String> failing = new Set<String>();
        List<String> prompts = new List<String>();

        public String run(String templateName, Id accountId) {
            if (failing.contains(templateName)) {
                throw new LlmException('The model is unavailable.');
            }
            prompts.add(ground(templateName, new Account(Id = accountId)));
            switch on templateName {
                when 'Meeting_Brief_Overview' {
                    return '```json\n{"whyItMatters":"[Analytics renews soon](PRD-1) and [made up](XYZ-9).",'
                        + '"whatChanged":["Dana asked for a pricing review [CONV-1]"],"suggestedGoal":"**Agree** on the renewal."}\n```';
                }
                when 'Meeting_Brief_Conversations' {
                    return '{"people":[{"ref":"PPL-1","worthKnowing":"[Wants a pricing review](CONV-1)."},{"ref":"PPL-99","worthKnowing":""}],'
                        + '"recent":[{"ref":"CONV-1","text":"Pricing discussed.","openCommitment":"Send the quote."}]}';
                }
                when 'Meeting_Brief_Account_Health' {
                    return '{"owned":{"summary":"[Two products](PRD-1).","highlights":["[CRM Cloud has 120 licenses](PRD-2)"]},'
                        + '"lapsed":{"summary":"","highlights":[]},"opportunities":{"summary":"[Renewal is open](OPP-1).","highlights":[]}}';
                }
                when 'Meeting_Brief_Company_Signals' {
                    return '{"items":[{"date":"2026-01-05","headline":"[Opened an Austin center](ENR-1)","soWhat":"More users."}],"hiring":""}';
                }
                when else {
                    return '{"talkingPoints":["[Renewal due](OPP-1): offer multi-year."],"questions":["Who signs?"],"watchOuts":[]}';
                }
            }
        }
    }

    private static String ground(String templateName, Account account) {
        switch on templateName {
            when 'Meeting_Brief_Overview' {
                MeetingBriefGroundingOverview.Request request = new MeetingBriefGroundingOverview.Request();
                request.Record = account;
                return MeetingBriefGroundingOverview.getPrompt(new List<MeetingBriefGroundingOverview.Request>{ request })[0].Prompt;
            }
            when 'Meeting_Brief_Conversations' {
                MeetingBriefGroundingConversations.Request request = new MeetingBriefGroundingConversations.Request();
                request.Record = account;
                return MeetingBriefGroundingConversations.getPrompt(new List<MeetingBriefGroundingConversations.Request>{ request })[0].Prompt;
            }
            when 'Meeting_Brief_Account_Health' {
                MeetingBriefGroundingAccountHealth.Request request = new MeetingBriefGroundingAccountHealth.Request();
                request.Record = account;
                return MeetingBriefGroundingAccountHealth.getPrompt(new List<MeetingBriefGroundingAccountHealth.Request>{ request })[0].Prompt;
            }
            when 'Meeting_Brief_Company_Signals' {
                MeetingBriefGroundingCompanySignals.Request request = new MeetingBriefGroundingCompanySignals.Request();
                request.Record = account;
                return MeetingBriefGroundingCompanySignals.getPrompt(new List<MeetingBriefGroundingCompanySignals.Request>{ request })[0].Prompt;
            }
            when else {
                MeetingBriefGroundingApproach.Request request = new MeetingBriefGroundingApproach.Request();
                request.Record = account;
                return MeetingBriefGroundingApproach.getPrompt(new List<MeetingBriefGroundingApproach.Request>{ request })[0].Prompt;
            }
        }
    }

    @TestSetup
    static void setup() {
        AcmeTestData.createUser(NO_ACCESS, false);
        System.runAs(AcmeTestData.createUser(TESTER, true)) {
            AcmeTestData.createBriefData();
        }
    }

    private static Map<String, Id> ids() {
        Account account = [SELECT Id FROM Account WHERE Name = 'Northwind Traders' LIMIT 1];
        return new Map<String, Id>{
            'account' => account.Id,
            'event' => [SELECT Id FROM Event WHERE AccountId = :account.Id LIMIT 1].Id,
            'task' => [SELECT Id FROM Task WHERE AccountId = :account.Id LIMIT 1].Id
        };
    }

    @IsTest
    static void generatesBriefForEvent() {
        Map<String, Id> ids = ids();
        MockRunner runner = new MockRunner();
        MeetingBriefGenerator.promptRunner = runner;
        Test.setMock(HttpCalloutMock.class, new AcmeTestData.EnrichmentMock());
        System.runAs(AcmeTestData.findUser(TESTER)) {
            Test.startTest();
            MeetingBriefService.Result result = MeetingBriefService.generateBrief(ids.get('event'), null);
            Test.stopTest();

            Assert.areEqual(MeetingBriefService.STATUS_READY, result.status, result.message);
            Assert.areEqual(ids.get('account'), result.accountId);
            Assert.areEqual(5, runner.prompts.size());
            Assert.isTrue(runner.prompts[0].contains('Renewal review'), 'The meeting is in the grounding data');
            Assert.isTrue(runner.prompts[3].contains('ENR-1'), 'Company data is in the grounding data');
            Assert.isTrue(runner.prompts[3].contains('acmeProducts'), 'The catalog is in the grounding data');

            Meeting_Brief__c brief = MeetingBriefService.getLatestBrief(ids.get('event'));
            Assert.areEqual(result.briefId, brief.Id);
            Assert.isFalse(brief.Overview__c.contains('XYZ-9'), 'Unknown refs are dropped');
            Assert.isTrue(brief.Overview__c.contains('(CONV-1)'), 'Bare refs become citations');
            Assert.isTrue(brief.Account_Health__c.contains('lapsedProducts'));
            Assert.isTrue([SELECT Context_Snapshot__c FROM Meeting_Brief__c WHERE Id = :brief.Id WITH SYSTEM_MODE]
                .Context_Snapshot__c.contains('Renewal review'));

            String text = MeetingBriefFormatter.toText(brief);
            Assert.isTrue(text.contains('BOTTOM LINE'));
            Assert.isTrue(text.contains('Dana Lee (CFO)'));
            Assert.isFalse(text.contains('(PRD-1)'), 'Citations are reduced to their words');
        }
    }

    @IsTest
    static void marksFailedAndSkippedSections() {
        Map<String, Id> ids = ids();
        MockRunner runner = new MockRunner();
        runner.failing.add('Meeting_Brief_Approach');
        MeetingBriefGenerator.promptRunner = runner;
        AcmeTestData.EnrichmentMock mock = new AcmeTestData.EnrichmentMock();
        mock.statusCode = 503;
        Test.setMock(HttpCalloutMock.class, mock);
        System.runAs(AcmeTestData.findUser(TESTER)) {
            Test.startTest();
            MeetingBriefService.Result result = MeetingBriefService.generate(
                null, ids.get('task'), MeetingBriefSections.parse('Bottom Line, call plan, Who You\'re Meeting; companySignals')
            );
            Test.stopTest();

            Assert.areEqual(MeetingBriefService.STATUS_INCOMPLETE, result.status);
            Meeting_Brief__c brief = MeetingBriefService.findLatest(ids.get('account'));
            Assert.areEqual(MeetingBriefService.SECTION_ERROR, brief.Approach_Status__c);
            Assert.areEqual(MeetingBriefService.SECTION_SKIPPED, brief.Account_Health_Status__c);
            Assert.areEqual(MeetingBriefService.SECTION_READY, brief.Conversations_Status__c);
            Assert.isTrue(brief.Company_Signals__c.contains('Unavailable'), 'Company data coverage is unavailable');
            Assert.areEqual(brief.Id, [SELECT Meeting_Brief__c FROM Task WHERE Id = :ids.get('task')].Meeting_Brief__c);
        }
    }

    @IsTest
    static void agentActionsWorkEndToEnd() {
        Map<String, Id> ids = ids();
        MeetingBriefGenerator.promptRunner = new MockRunner();
        Test.setMock(HttpCalloutMock.class, new AcmeTestData.EnrichmentMock());
        System.runAs(AcmeTestData.findUser(TESTER)) {
            AgentSearchRecords.Request search = new AgentSearchRecords.Request();
            search.searchText = 'northwind';
            AgentSearchRecords.Response found = AgentSearchRecords.search(new List<AgentSearchRecords.Request>{ search })[0];
            Assert.areEqual(1, found.matchCount);
            Assert.isTrue(found.matches.contains(ids.get('account')));

            AgentListMeetings.Request listRequest = new AgentListMeetings.Request();
            listRequest.accountId = ids.get('account');
            AgentListMeetings.Response meetings = AgentListMeetings.listMeetings(new List<AgentListMeetings.Request>{ listRequest })[0];
            Assert.areEqual(2, meetings.meetingCount, meetings.meetings);

            AgentGenerateMeetingBrief.Request generate = new AgentGenerateMeetingBrief.Request();
            generate.meetingId = ids.get('event');
            generate.sections = 'Bottom Line, Call Plan';
            Test.startTest();
            AgentGenerateMeetingBrief.Response generated =
                AgentGenerateMeetingBrief.generate(new List<AgentGenerateMeetingBrief.Request>{ generate })[0];
            Test.stopTest();
            Assert.areEqual(MeetingBriefService.STATUS_READY, generated.status, generated.message);
            Assert.isTrue(generated.briefText.contains('CALL PLAN'));

            AgentGetMeetingBrief.Request getRequest = new AgentGetMeetingBrief.Request();
            getRequest.recordId = ids.get('account');
            AgentGetMeetingBrief.Response latest = AgentGetMeetingBrief.getBrief(new List<AgentGetMeetingBrief.Request>{ getRequest })[0];
            Assert.isTrue(latest.found);
            Assert.areEqual(generated.briefId, latest.briefId);
        }
    }

    @IsTest
    static void handlesInvalidInput() {
        Map<String, Id> ids = ids();
        System.runAs(AcmeTestData.findUser(TESTER)) {
            AgentGenerateMeetingBrief.Request badSection = new AgentGenerateMeetingBrief.Request();
            badSection.accountId = ids.get('account');
            badSection.sections = 'Weather';
            AgentGenerateMeetingBrief.Request badId = new AgentGenerateMeetingBrief.Request();
            badId.accountId = 'abc';
            AgentGenerateMeetingBrief.Request missing = new AgentGenerateMeetingBrief.Request();
            List<AgentGenerateMeetingBrief.Response> responses = AgentGenerateMeetingBrief.generate(
                new List<AgentGenerateMeetingBrief.Request>{ badSection, badId, missing }
            );
            for (AgentGenerateMeetingBrief.Response response : responses) {
                Assert.areEqual(MeetingBriefService.STATUS_FAILED, response.status);
            }

            AgentGetMeetingBrief.Request none = new AgentGetMeetingBrief.Request();
            none.recordId = ids.get('task');
            AgentGetMeetingBrief.Request invalid = new AgentGetMeetingBrief.Request();
            invalid.recordId = UserInfo.getUserId();
            List<AgentGetMeetingBrief.Response> briefs = AgentGetMeetingBrief.getBrief(
                new List<AgentGetMeetingBrief.Request>{ none, invalid }
            );
            Assert.isFalse(briefs[0].found);
            Assert.isFalse(briefs[1].found);

            AgentListMeetings.Request listRequest = new AgentListMeetings.Request();
            listRequest.accountId = 'abc';
            Assert.areEqual(0, AgentListMeetings.listMeetings(new List<AgentListMeetings.Request>{ listRequest })[0].meetingCount);

            AgentSearchRecords.Request search = new AgentSearchRecords.Request();
            search.searchText = 'x';
            Assert.areEqual(0, AgentSearchRecords.search(new List<AgentSearchRecords.Request>{ search })[0].matchCount);
        }
        System.runAs(AcmeTestData.findUser(NO_ACCESS)) {
            try {
                MeetingBriefService.generateBrief(ids.get('account'), new List<String>{ 'overview' });
                Assert.fail('Expected a permission error');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('permission'));
            }
        }
    }

    @IsTest
    static void groundingWorksWithoutPriming() {
        Map<String, Id> ids = ids();
        System.runAs(AcmeTestData.findUser(TESTER)) {
            String prompt = ground('Meeting_Brief_Approach', new Account(Id = ids.get('account')));
            Assert.isTrue(prompt.contains('Acme Analytics'));
            Assert.isFalse(prompt.contains('"meeting"'));
        }
    }
}
