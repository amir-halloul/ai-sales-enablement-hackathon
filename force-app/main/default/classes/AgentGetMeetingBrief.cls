// Agent action: returns the newest meeting brief of an account, a meeting or a brief Id as text
public with sharing class AgentGetMeetingBrief {
    public class Request {
        @InvocableVariable(label='Record Id' description='Record Id of a Meeting Brief, an Account (newest brief) or a Task or Event (its brief).' required=true)
        public String recordId;
    }

    public class Response {
        @InvocableVariable(label='Found')
        public Boolean found;
        @InvocableVariable(label='Brief Id')
        public String briefId;
        @InvocableVariable(label='Brief URL')
        public String briefUrl;
        @InvocableVariable(label='Brief Text' description='The brief as plain text, or why none was found.')
        public String briefText;
    }

    @InvocableMethod(label='Get Meeting Brief' description='Returns an existing meeting brief as text without generating a new one.')
    public static List<Response> getBrief(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            Response response = new Response();
            response.found = false;
            try {
                Id recordId = AgentIds.parse(request.recordId, new Set<Schema.SObjectType>{
                    Meeting_Brief__c.SObjectType, Account.SObjectType, Task.SObjectType, Event.SObjectType
                }, 'a Meeting Brief, Account, Task or Event Id');
                Meeting_Brief__c brief = MeetingBriefService.findLatest(recordId);
                if (brief == null) {
                    response.briefText = 'No meeting brief exists for this record yet.';
                } else {
                    response.found = true;
                    response.briefId = brief.Id;
                    response.briefUrl = '/lightning/r/Meeting_Brief__c/' + brief.Id + '/view';
                    response.briefText = MeetingBriefFormatter.toText(brief);
                }
            } catch (AgentIds.InvalidIdException e) {
                response.briefText = e.getMessage();
            }
            responses.add(response);
        }
        return responses;
    }
}