/**
 * Meeting brief sections: keys match the meetingBrief LWC; prompt templates are Flex templates with an Account input.
 */
public with sharing class MeetingBriefSections {
    public class SectionException extends Exception {}

    public static final String OVERVIEW = 'overview';
    public static final String APPROACH = 'approach';
    public static final String CONVERSATIONS = 'conversations';
    public static final String ACCOUNT_HEALTH = 'accountHealth';
    public static final String COMPANY_SIGNALS = 'companySignals';

    public static final String SOURCE_PRODUCTS = 'products';
    public static final String SOURCE_OPPORTUNITIES = 'opportunities';
    public static final String SOURCE_CONVERSATIONS = 'conversations';
    public static final String SOURCE_ENRICHMENT = 'enrichment';
    public static final String SOURCE_PEOPLE = 'people';
    // product catalog static resource; reference content, not account data, so it has no coverage entry
    public static final String SOURCE_CATALOG = 'catalog';

    public class Section {
        public final String key;
        public final String label;
        public final String promptTemplate;
        public final SObjectField contentField;
        public final SObjectField statusField;
        public final Set<String> sources;

        public Section(String key, String label, String promptTemplate, SObjectField contentField, SObjectField statusField,
            Set<String> sources) {
            this.key = key;
            this.label = label;
            this.promptTemplate = promptTemplate;
            this.contentField = contentField;
            this.statusField = statusField;
            this.sources = sources;
        }
    }

    private static final Set<String> ALL_SOURCES = new Set<String>{
        SOURCE_PRODUCTS, SOURCE_OPPORTUNITIES, SOURCE_CONVERSATIONS, SOURCE_ENRICHMENT, SOURCE_PEOPLE, SOURCE_CATALOG
    };

    // display order: bottom line, who you're meeting, where we stand, what's new, call plan
    public static final List<Section> ALL = new List<Section>{
        new Section(OVERVIEW, 'Bottom Line', 'Meeting_Brief_Overview',
            Meeting_Brief__c.Overview__c, Meeting_Brief__c.Overview_Status__c, ALL_SOURCES),
        new Section(CONVERSATIONS, 'Who You\'re Meeting', 'Meeting_Brief_Conversations',
            Meeting_Brief__c.Conversations__c, Meeting_Brief__c.Conversations_Status__c,
            new Set<String>{ SOURCE_PEOPLE, SOURCE_CONVERSATIONS }),
        new Section(ACCOUNT_HEALTH, 'Where We Stand', 'Meeting_Brief_Account_Health',
            Meeting_Brief__c.Account_Health__c, Meeting_Brief__c.Account_Health_Status__c,
            new Set<String>{ SOURCE_PRODUCTS, SOURCE_OPPORTUNITIES }),
        new Section(COMPANY_SIGNALS, 'What\'s New', 'Meeting_Brief_Company_Signals',
            Meeting_Brief__c.Company_Signals__c, Meeting_Brief__c.Company_Signals_Status__c,
            new Set<String>{ SOURCE_ENRICHMENT, SOURCE_CATALOG }),
        new Section(APPROACH, 'Call Plan', 'Meeting_Brief_Approach',
            Meeting_Brief__c.Approach__c, Meeting_Brief__c.Approach_Status__c, ALL_SOURCES)
    };

    public static Section get(String key) {
        for (Section section : ALL) {
            if (section.key.equals(key)) {
                return section;
            }
        }
        throw new SectionException('Unknown meeting brief section: ' + key);
    }

    /**
     * Section keys from keys or labels such as "overview, Call Plan, what's new"; blank means all sections.
     */
    public static Set<String> parse(String text) {
        Set<String> keys = new Set<String>();
        if (String.isBlank(text)) {
            for (Section section : ALL) {
                keys.add(section.key);
            }
            return keys;
        }
        for (String part : text.split('[,;]')) {
            String wanted = normalize(part);
            if (String.isBlank(wanted)) {
                continue;
            }
            Boolean found = false;
            for (Section section : ALL) {
                if (normalize(section.key) == wanted || normalize(section.label) == wanted) {
                    keys.add(section.key);
                    found = true;
                }
            }
            if (!found) {
                throw new SectionException('Unknown meeting brief section: ' + part.trim()
                    + '. Use Bottom Line, Who You\'re Meeting, Where We Stand, What\'s New or Call Plan.');
            }
        }
        return keys;
    }

    private static String normalize(String text) {
        return text == null ? '' : text.toLowerCase().replaceAll('[^a-z]', '');
    }
}
