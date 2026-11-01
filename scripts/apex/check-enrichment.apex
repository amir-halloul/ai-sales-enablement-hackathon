// Smoke test for the Acme_Enrichment Named Credential.
// sf apex run --file scripts/apex/check-enrichment.apex --target-org osfDev
Account target = [SELECT Id, Name, Website, BillingCountry, ShippingCountry FROM Account WHERE Name = 'OSF Digital' LIMIT 1];
try {
    AcmeEnrichmentClient.Identification idResult = AcmeEnrichmentClient.identify(target);
    System.debug(LoggingLevel.ERROR, 'identify -> ' + JSON.serialize(idResult));
    if (idResult.status == AcmeEnrichmentClient.STATUS_MATCHED) {
        AcmeEnrichmentClient.Enrichment enrichment = AcmeEnrichmentClient.enrich(idResult.entityId, idResult.entityType);
        System.debug(LoggingLevel.ERROR, 'enrich -> ' + enrichment.completeness + ' ' + enrichment.body.left(500));
    }
} catch (Exception e) {
    System.debug(LoggingLevel.ERROR, 'callout failed -> ' + e.getTypeName() + ': ' + e.getMessage());
}
