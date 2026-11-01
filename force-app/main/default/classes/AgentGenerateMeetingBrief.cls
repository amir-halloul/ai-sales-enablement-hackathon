// Agent action: generates a meeting brief for an account or one of its meetings and returns it as text
public with sharing class AgentGenerateMeetingBrief {
    public class Request {
        @InvocableVariable(label='Account Id' description='Record Id of the Account. Optional when a meeting Id is given.')
        public String accountId;
        @InvocableVariable(label='Meeting Id' description='Record Id of the Task or Event the brief prepares for. Optional.')
        public String meetingId;
        @InvocableVariable(label='Sections' description='Comma-separated sections: Bottom Line, Who You\'re Meeting, Where We Stand, What\'s New, Call Plan. Empty means all.')
        public String sections;
    }

    public class Response {
        @InvocableVariable(label='Status' description='Ready, Incomplete or Failed.')
        public String status;
        @InvocableVariable(label='Message')
        public String message;
        @InvocableVariable(label='Brief Id')
        public String briefId;
        @InvocableVariable(label='Brief URL')
        public String briefUrl;
        @InvocableVariable(label='Brief Text' description='The generated brief as plain text.')
        public String briefText;
    }

    @InvocableMethod(label='Generate Meeting Brief' description='Generates a meeting brief from CRM data, conversations, subscriptions and company data.')
    public static List<Response> generate(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            Response response = new Response();
            try {
                Id accountId = AgentIds.parse(request.accountId, new Set<Schema.SObjectType>{ Account.SObjectType }, 'an Account Id');
                Id meetingId = AgentIds.parse(request.meetingId,
                    new Set<Schema.SObjectType>{ Task.SObjectType, Event.SObjectType }, 'a Task or Event Id');
                MeetingBriefService.Result result = MeetingBriefService.generate(
                    accountId, meetingId, MeetingBriefSections.parse(request.sections)
                );
                response.status = result.status;
                response.message = result.message;
                response.briefId = result.briefId;
                response.briefUrl = '/lightning/r/Meeting_Brief__c/' + result.briefId + '/view';
                response.briefText = MeetingBriefFormatter.toText(MeetingBriefService.findLatest(result.briefId));
            } catch (AgentIds.InvalidIdException e) {
                fail(response, e.getMessage());
            } catch (MeetingBriefService.BriefException e) {
                fail(response, e.getMessage());
            } catch (MeetingBriefSections.SectionException e) {
                fail(response, e.getMessage());
            } catch (MeetingBriefContextService.ContextException e) {
                fail(response, e.getMessage());
            }
            responses.add(response);
        }
        return responses;
    }

    private static void fail(Response response, String message) {
        response.status = MeetingBriefService.STATUS_FAILED;
        response.message = message;
    }
}