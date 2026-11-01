// Agent action: finds Accounts and Leads by name so the agent can work with their record Ids
public with sharing class AgentSearchRecords {
    private static final Integer MAX_RESULTS = 5;

    public class Request {
        @InvocableVariable(label='Search Text' description='Part of the account name, lead name or lead company.' required=true)
        public String searchText;
    }

    public class Response {
        @InvocableVariable(label='Matches' description='One line per match with the record type, name, Id, location and enrichment status.')
        public String matches;
        @InvocableVariable(label='Match Count')
        public Integer matchCount;
    }

    @InvocableMethod(label='Search Accounts and Leads' description='Finds Accounts and Leads by name and returns their record Ids.')
    public static List<Response> search(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(search(request.searchText));
        }
        return responses;
    }

    private static Response search(String searchText) {
        Response response = new Response();
        String text = searchText == null ? '' : searchText.trim();
        if (text.length() < 2) {
            response.matches = 'Enter at least 2 characters to search.';
            response.matchCount = 0;
            return response;
        }
        String pattern = '%' + text.replace('%', '\\%').replace('_', '\\_') + '%';
        List<String> lines = new List<String>();
        for (Account account : [
            SELECT Id, Name, Website, BillingCity, BillingCountry, Enrichment_Status__c
            FROM Account
            WHERE Name LIKE :pattern
            WITH USER_MODE
            ORDER BY Name
            LIMIT :MAX_RESULTS
        ]) {
            lines.add('Account | ' + account.Name + ' | Id ' + account.Id + location(account.BillingCity, account.BillingCountry)
                + detail('Website', account.Website) + detail('Enrichment', account.Enrichment_Status__c));
        }
        for (Lead lead : [
            SELECT Id, Name, Company, Website, City, Country, Enrichment_Status__c
            FROM Lead
            WHERE (Name LIKE :pattern OR Company LIKE :pattern) AND IsConverted = false
            WITH USER_MODE
            ORDER BY Name
            LIMIT :MAX_RESULTS
        ]) {
            lines.add('Lead | ' + lead.Name + ' at ' + lead.Company + ' | Id ' + lead.Id + location(lead.City, lead.Country)
                + detail('Website', lead.Website) + detail('Enrichment', lead.Enrichment_Status__c));
        }
        response.matchCount = lines.size();
        response.matches = lines.isEmpty() ? 'No Accounts or Leads match "' + text + '".' : String.join(lines, '\n');
        return response;
    }

    private static String location(String city, String country) {
        List<String> parts = new List<String>();
        for (String part : new List<String>{ city, country }) {
            if (String.isNotBlank(part)) {
                parts.add(part);
            }
        }
        return parts.isEmpty() ? '' : ' | ' + String.join(parts, ', ');
    }

    private static String detail(String label, String value) {
        return String.isBlank(value) ? '' : ' | ' + label + ': ' + value;
    }
}