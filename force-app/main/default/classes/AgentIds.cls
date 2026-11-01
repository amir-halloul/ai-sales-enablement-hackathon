// Parses record Ids passed by the agent as text
public with sharing class AgentIds {
    public class InvalidIdException extends Exception {}

    /**
     * @return The Id, or null when blank.
     * @throws InvalidIdException when the value is not an Id of one of the allowed types.
     */
    public static Id parse(String value, Set<Schema.SObjectType> allowed, String expected) {
        if (String.isBlank(value)) {
            return null;
        }
        Id recordId;
        try {
            recordId = Id.valueOf(value.trim());
        } catch (StringException e) {
            throw new InvalidIdException('"' + value + '" is not a record Id. Expected ' + expected + '.');
        }
        if (!allowed.contains(recordId.getSObjectType())) {
            throw new InvalidIdException('The Id ' + recordId + ' is not ' + expected + '.');
        }
        return recordId;
    }
}
