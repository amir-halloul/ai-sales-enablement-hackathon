// Apex merge field of the Meeting_Brief_Account_Health prompt template
public with sharing class MeetingBriefGroundingAccountHealth {
    public class Request {
        @InvocableVariable(required=true)
        public Account Record;
    }

    public class Response {
        @InvocableVariable
        public String Prompt;
    }

    @InvocableMethod(label='Meeting Brief Grounding: Where We Stand')
    public static List<Response> getPrompt(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            Response response = new Response();
            response.Prompt = MeetingBriefContextService.forSection(request.Record.Id, MeetingBriefSections.ACCOUNT_HEALTH).promptText;
            responses.add(response);
        }
        return responses;
    }
}
