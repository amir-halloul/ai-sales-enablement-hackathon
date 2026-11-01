/**
 * HTTP boundary of the enrichment provider (POST /v1/identify and /v1/enrich).
 * Authentication comes from the Acme_Enrichment Named Credential. Call before any DML in the transaction.
 */
public with sharing class AcmeEnrichmentClient {
    public class ProviderException extends Exception {}

    public class Identification {
        public String entityType;
        public String status;
        public String entityId;
    }

    public class Enrichment {
        public String entityType;
        public String entityId;
        public String completeness;
        public String body;
    }

    public static final String STATUS_MATCHED = 'matched';
    public static final String STATUS_AMBIGUOUS = 'ambiguous';
    public static final Set<String> NO_MATCH_STATUSES = new Set<String>{ 'not_found', 'no_match', 'unmatched' };

    private static final String ENDPOINT = 'callout:Acme_Enrichment/v1/';
    // the API answers within its 90 s request budget
    private static final Integer TIMEOUT_MS = 100000;

    public static String entityTypeOf(SObject target) {
        if (target == null) {
            throw new ProviderException('A Lead or Account is required.');
        }
        Schema.SObjectType type = target.getSObjectType();
        if (type == Lead.SObjectType) {
            return 'person';
        }
        if (type == Account.SObjectType) {
            return 'company';
        }
        throw new ProviderException('Only Leads and Accounts can be enriched.');
    }

    /**
     * @param target Lead with Name, Company and Website, or Account with Name, Website, BillingCountry and ShippingCountry.
     */
    public static Identification identify(SObject target) {
        String entityType = entityTypeOf(target);
        String name = (String) target.get('Name');
        if (String.isBlank(name)) {
            throw new ProviderException('A name is required for identification.');
        }
        Map<String, Object> payload = new Map<String, Object>{ 'entityType' => entityType, 'name' => name.trim() };
        String website = (String) target.get('Website');
        if (String.isNotBlank(website)) {
            payload.put('website', website.trim());
        }
        if (entityType == 'person') {
            String company = (String) target.get('Company');
            if (String.isNotBlank(company)) {
                payload.put('company', company.trim());
            }
        } else {
            String country = String.isBlank((String) target.get('BillingCountry'))
                ? (String) target.get('ShippingCountry')
                : (String) target.get('BillingCountry');
            if (String.isNotBlank(country)) {
                payload.put('address', country.trim());
            }
        }

        String body = send('identify', payload);
        Identification result;
        try {
            result = (Identification) JSON.deserialize(body, Identification.class);
        } catch (JSONException e) {
            throw new ProviderException('Identify returned invalid JSON.');
        }
        if (result == null || result.entityType != entityType) {
            throw new ProviderException('Identify returned an unexpected entity type.');
        }
        if (result.status == STATUS_AMBIGUOUS || NO_MATCH_STATUSES.contains(result.status)) {
            return result;
        }
        if (result.status != STATUS_MATCHED || String.isBlank(result.entityId)) {
            throw new ProviderException('Identify returned an invalid status or no identifier.');
        }
        return result;
    }

    public static Enrichment enrich(String entityId, String entityType) {
        if (String.isBlank(entityId)) {
            throw new ProviderException('An entity Id is required for enrichment.');
        }
        String body = send('enrich', new Map<String, Object>{ 'entityType' => entityType, 'entityId' => entityId });
        Enrichment result;
        try {
            result = (Enrichment) JSON.deserialize(body, Enrichment.class);
        } catch (JSONException e) {
            throw new ProviderException('Enrich returned invalid JSON.');
        }
        if (result == null || result.entityType != entityType || String.isBlank(result.entityId)
            || (result.completeness != 'complete' && result.completeness != 'partial')) {
            throw new ProviderException('Enrich returned an invalid entity or completeness value.');
        }
        result.body = body;
        return result;
    }

    private static String send(String operation, Map<String, Object> payload) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(ENDPOINT + operation);
        request.setMethod('POST');
        request.setHeader('Content-Type', 'application/json');
        request.setTimeout(TIMEOUT_MS);
        request.setBody(JSON.serialize(payload));
        HttpResponse response;
        try {
            response = new Http().send(request);
        } catch (CalloutException e) {
            throw new ProviderException('The enrichment service could not be reached.');
        }
        Integer statusCode = response.getStatusCode();
        if (statusCode < 200 || statusCode >= 300) {
            throw new ProviderException('The enrichment service returned HTTP ' + statusCode + '.');
        }
        if (String.isBlank(response.getBody())) {
            throw new ProviderException('The enrichment service returned an empty response.');
        }
        return response.getBody();
    }
}
