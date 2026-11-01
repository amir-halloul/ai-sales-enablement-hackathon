/**
 * Converts enrich attributes into blank-only Lead/Account values using Enrichment_Field_Mapping__mdt.
 * Attributes are { value, confidence, sources }; medium, high and very_high confidence values are written.
 */
public with sharing class EnrichmentFieldMapper {
    private static final Set<String> ACCEPTED_CONFIDENCE = new Set<String>{ 'medium', 'high', 'very_high' };
    // the provider reports money in USD; the demo org is single-currency
    private static final String SOURCE_CURRENCY = 'USD';
    @TestVisible private static List<Enrichment_Field_Mapping__mdt> testMappings;

    /**
     * @return Active mappings whose field exists and is readable and editable by the running user.
     */
    public static List<Enrichment_Field_Mapping__mdt> selectMappings(Schema.SObjectType targetType) {
        Schema.DescribeSObjectResult describe = targetType.getDescribe();
        Map<String, Schema.SObjectField> fields = describe.fields.getMap();
        List<Enrichment_Field_Mapping__mdt> usable = new List<Enrichment_Field_Mapping__mdt>();
        List<Enrichment_Field_Mapping__mdt> mappings = testMappings != null
            ? testMappings : Enrichment_Field_Mapping__mdt.getAll().values();
        for (Enrichment_Field_Mapping__mdt mapping : mappings) {
            if (mapping.Active__c != true) {
                continue;
            }
            Schema.SObjectField field = mapping.Object__c == describe.getName() ? fields.get(mapping.Field__c) : null;
            if (field != null && field.getDescribe().isAccessible() && field.getDescribe().isUpdateable()) {
                usable.add(mapping);
            }
        }
        return usable;
    }

    /**
     * @param current Target queried with every mapped field.
     * @return Update holding only blank fields with an accepted, valid value. Grouped fields (an address) are only
     * written when the whole group is blank.
     */
    public static SObject buildUpdate(SObject current, List<Enrichment_Field_Mapping__mdt> mappings, String responseBody) {
        Map<String, Object> response = (Map<String, Object>) JSON.deserializeUntyped(responseBody);
        Map<String, Schema.SObjectField> fields = current.getSObjectType().getDescribe().fields.getMap();
        Set<String> occupiedGroups = new Set<String>();
        for (Enrichment_Field_Mapping__mdt mapping : mappings) {
            if (String.isNotBlank(mapping.Field_Group__c) && !isBlank(current.get(mapping.Field__c))) {
                occupiedGroups.add(mapping.Field_Group__c);
            }
        }
        SObject changes = current.getSObjectType().newSObject(current.Id);
        for (Enrichment_Field_Mapping__mdt mapping : mappings) {
            if (!isBlank(current.get(mapping.Field__c)) || occupiedGroups.contains(mapping.Field_Group__c)) {
                continue;
            }
            Object value = convert(readValue(response, mapping.Attribute__c), fields.get(mapping.Field__c).getDescribe());
            value = toStateOrCountryLabel(value, mapping.Field__c, fields);
            if (value != null) {
                changes.put(mapping.Field__c, value);
            }
        }
        return changes;
    }

    private static Object readValue(Map<String, Object> response, String path) {
        Object wrapper = response.get(path.substringBefore('.'));
        if (!(wrapper instanceof Map<String, Object>)) {
            return null;
        }
        Map<String, Object> attribute = (Map<String, Object>) wrapper;
        if (!ACCEPTED_CONFIDENCE.contains(String.valueOf(attribute.get('confidence')))) {
            return null;
        }
        Object value = attribute.get('value');
        String part = path.substringAfter('.');
        if (String.isBlank(part)) {
            return value;
        }
        return value instanceof Map<String, Object> ? ((Map<String, Object>) value).get(part) : null;
    }

    private static Object convert(Object value, Schema.DescribeFieldResult field) {
        if (value == null) {
            return null;
        }
        switch on field.getType() {
            when STRING, TEXTAREA, PHONE, URL {
                if (!(value instanceof String)) {
                    return null;
                }
                String text = ((String) value).trim();
                if (String.isBlank(text) || text.length() > field.getLength()) {
                    return null;
                }
                if (field.getType() == Schema.DisplayType.URL
                    && !Pattern.matches('(?i)^https?://[^\\s/?#]+[^\\s]*$', text)) {
                    return null;
                }
                return text;
            }
            when INTEGER, DOUBLE, CURRENCY {
                if (!(value instanceof Integer || value instanceof Long || value instanceof Decimal)) {
                    return null;
                }
                if (field.getType() == Schema.DisplayType.CURRENCY
                    && (UserInfo.isMultiCurrencyOrganization() || UserInfo.getDefaultCurrency() != SOURCE_CURRENCY)) {
                    return null;
                }
                Decimal amount = Decimal.valueOf(String.valueOf(value));
                if (amount < 0) {
                    return null;
                }
                Boolean whole = field.getType() == Schema.DisplayType.INTEGER;
                Integer scale = whole ? 0 : field.getScale();
                Integer integerDigits = whole ? field.getDigits() : field.getPrecision() - scale;
                amount = amount.setScale(scale, RoundingMode.HALF_UP);
                if (amount.setScale(0, RoundingMode.DOWN).toPlainString().length() > integerDigits) {
                    return null;
                }
                return whole ? (Object) amount.intValue() : (Object) amount;
            }
            when else {
                // booleans, dates, emails and picklists are not approved for enrichment
                return null;
            }
        }
    }

    // with state and country picklists enabled, a value outside the picklist fails the whole update, so it is dropped
    private static Object toStateOrCountryLabel(Object value, String fieldName, Map<String, Schema.SObjectField> fields) {
        Schema.SObjectField codeField = fields.get(fieldName + 'Code');
        if (!(value instanceof String) || codeField == null
            || !(fieldName.endsWithIgnoreCase('State') || fieldName.endsWithIgnoreCase('Country'))) {
            return value;
        }
        String text = (String) value;
        for (Schema.PicklistEntry entry : codeField.getDescribe().getPicklistValues()) {
            if (entry.isActive() && (text.equalsIgnoreCase(entry.getLabel()) || text.equalsIgnoreCase(entry.getValue()))) {
                return entry.getLabel();
            }
        }
        return null;
    }

    private static Boolean isBlank(Object value) {
        return value == null || (value instanceof String && String.isBlank((String) value));
    }
}
