// Agent action: enriches a Lead or Account with company data, writing only blank fields
public with sharing class AgentEnrichRecord {
    public class Request {
        @InvocableVariable(label='Record Id' description='Record Id of the Lead or Account to enrich.' required=true)
        public String recordId;
    }

    public class Response {
        @InvocableVariable(label='Status' description='Succeeded, Partial, No Match, Ambiguous Match or Failed.')
        public String status;
        @InvocableVariable(label='Message' description='What happened, including the updated fields.')
        public String message;
        @InvocableVariable(label='Record Name')
        public String recordName;
    }

    @InvocableMethod(label='Enrich Record' description='Enriches a Lead or Account from the company data provider; only blank fields are filled.')
    public static List<Response> enrich(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            Response response = new Response();
            try {
                Id recordId = AgentIds.parse(request.recordId,
                    new Set<Schema.SObjectType>{ Lead.SObjectType, Account.SObjectType }, 'a Lead or Account Id');
                EnrichmentService.Result result = EnrichmentService.enrich(recordId);
                response.status = result.status;
                response.message = result.message;
                response.recordName = result.recordName;
            } catch (AgentIds.InvalidIdException e) {
                response.status = EnrichmentService.STATUS_FAILED;
                response.message = e.getMessage();
            } catch (EnrichmentService.EnrichmentException e) {
                response.status = EnrichmentService.STATUS_FAILED;
                response.message = e.getMessage();
            }
            responses.add(response);
        }
        return responses;
    }
}