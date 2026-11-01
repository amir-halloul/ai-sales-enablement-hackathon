// Agent action: lists an account's meetings (Tasks and Events) from 7 days ago to 30 days ahead
public with sharing class AgentListMeetings {
    private static final Integer DAYS_BACK = 7;
    private static final Integer DAYS_AHEAD = 30;
    private static final Integer MAX_RESULTS = 10;

    public class Request {
        @InvocableVariable(label='Account Id' description='Record Id of the Account.' required=true)
        public String accountId;
    }

    public class Response {
        @InvocableVariable(label='Meetings' description='One line per meeting with the type, date, subject, contact, Id and whether a brief exists.')
        public String meetings;
        @InvocableVariable(label='Meeting Count')
        public Integer meetingCount;
    }

    @InvocableMethod(label='List Account Meetings' description='Lists Tasks and Events of an account from 7 days ago to 30 days ahead.')
    public static List<Response> listMeetings(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            Response response = new Response();
            try {
                Id accountId = AgentIds.parse(request.accountId, new Set<Schema.SObjectType>{ Account.SObjectType }, 'an Account Id');
                List<String> lines = findMeetings(accountId);
                response.meetingCount = lines.size();
                response.meetings = lines.isEmpty()
                    ? 'No meetings from ' + DAYS_BACK + ' days ago to ' + DAYS_AHEAD + ' days ahead.'
                    : String.join(lines, '\n');
            } catch (AgentIds.InvalidIdException e) {
                response.meetingCount = 0;
                response.meetings = e.getMessage();
            }
            responses.add(response);
        }
        return responses;
    }

    private static List<String> findMeetings(Id accountId) {
        if (accountId == null) {
            throw new AgentIds.InvalidIdException('An Account Id is required.');
        }
        Date fromDate = Date.today().addDays(-DAYS_BACK);
        Date toDate = Date.today().addDays(DAYS_AHEAD);
        Map<String, String> byKey = new Map<String, String>();
        for (Event meeting : [
            SELECT Id, Subject, ActivityDate, StartDateTime, Who.Name, What.Name, Meeting_Brief__c
            FROM Event
            WHERE AccountId = :accountId AND ActivityDate >= :fromDate AND ActivityDate <= :toDate
            WITH USER_MODE
            ORDER BY ActivityDate, Id
            LIMIT :MAX_RESULTS
        ]) {
            String startText = meeting.StartDateTime == null
                ? String.valueOf(meeting.ActivityDate) : meeting.StartDateTime.format('yyyy-MM-dd HH:mm');
            byKey.put(String.valueOf(meeting.ActivityDate) + meeting.Id,
                line('Event', startText, meeting.Subject, meeting.Who?.Name, meeting.What?.Name, meeting.Id, meeting.Meeting_Brief__c));
        }
        for (Task meeting : [
            SELECT Id, Subject, ActivityDate, Who.Name, What.Name, Meeting_Brief__c
            FROM Task
            WHERE AccountId = :accountId AND ActivityDate >= :fromDate AND ActivityDate <= :toDate
            WITH USER_MODE
            ORDER BY ActivityDate, Id
            LIMIT :MAX_RESULTS
        ]) {
            byKey.put(String.valueOf(meeting.ActivityDate) + meeting.Id,
                line('Task', String.valueOf(meeting.ActivityDate), meeting.Subject, meeting.Who?.Name, meeting.What?.Name,
                    meeting.Id, meeting.Meeting_Brief__c));
        }
        List<String> keys = new List<String>(byKey.keySet());
        keys.sort();
        List<String> lines = new List<String>();
        for (String key : keys) {
            if (lines.size() < MAX_RESULTS) {
                lines.add(byKey.get(key));
            }
        }
        return lines;
    }

    private static String line(String type, String whenText, String subject, String contact, String related, Id recordId,
        Id briefId) {
        return type + ' | ' + whenText + ' | ' + (String.isBlank(subject) ? '(no subject)' : subject)
            + (String.isBlank(contact) ? '' : ' | with ' + contact)
            + (String.isBlank(related) ? '' : ' | re ' + related)
            + ' | Id ' + recordId
            + (briefId == null ? '' : ' | brief exists');
    }
}