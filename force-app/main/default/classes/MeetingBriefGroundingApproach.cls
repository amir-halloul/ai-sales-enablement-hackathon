// Apex merge field of the Meeting_Brief_Approach prompt template
public with sharing class MeetingBriefGroundingApproach {
    public class Request {
        @InvocableVariable(required=true)
        public Account Record;
    }

    public class Response {
        @InvocableVariable
        public String Prompt;
    }

    @InvocableMethod(label='Meeting Brief Grounding: Call Plan')
    public static List<Response> getPrompt(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            Response response = new Response();
            response.Prompt = MeetingBriefContextService.forSection(request.Record.Id, MeetingBriefSections.APPROACH).promptText;
            responses.add(response);
        }
        return responses;
    }
}
