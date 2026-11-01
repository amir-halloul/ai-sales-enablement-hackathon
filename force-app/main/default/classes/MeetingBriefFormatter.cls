/**
 * Plain-text rendering of a meeting brief for the agent: one block per Ready section, citations reduced to their words.
 */
public with sharing class MeetingBriefFormatter {
    private static final Pattern INLINE_REF = Pattern.compile('\\[([^\\[\\]]+)\\]\\(([A-Z]{2,5}-\\d{1,4})\\)');
    // output keys of the prompt templates; blank labels are shown without a prefix
    private static final Map<String, String> LABELS = new Map<String, String>{
        'whyItMatters' => 'Why it matters',
        'whatChanged' => 'What changed',
        'suggestedGoal' => 'Suggested goal',
        'people' => 'People',
        'worthKnowing' => '',
        'recent' => 'Recent conversations',
        'text' => '',
        'openCommitment' => 'Open commitment',
        'owned' => 'Products owned',
        'lapsed' => 'Lapsed products',
        'opportunities' => 'Opportunities',
        'summary' => '',
        'highlights' => '',
        'items' => 'Recent events',
        'date' => '',
        'headline' => '',
        'soWhat' => 'So what',
        'hiring' => 'Hiring',
        'talkingPoints' => 'Talking points',
        'questions' => 'Questions to ask',
        'watchOuts' => 'Watch outs'
    };
    // display order of output keys; JSON.deserializeUntyped does not keep the model's order
    private static final List<String> KEY_ORDER = new List<String>{
        'whyItMatters', 'whatChanged', 'suggestedGoal', 'people', 'recent', 'owned', 'lapsed', 'opportunities',
        'summary', 'highlights', 'items', 'hiring', 'talkingPoints', 'questions', 'watchOuts',
        'date', 'headline', 'worthKnowing', 'text', 'soWhat', 'openCommitment'
    };

    public static final String BRIEF_FIELDS = 'Id, Name, Account__c, Account__r.Name, Status__c, Status_Message__c, CreatedDate, '
        + 'Overview__c, Overview_Status__c, Approach__c, Approach_Status__c, Conversations__c, Conversations_Status__c, '
        + 'Account_Health__c, Account_Health_Status__c, Company_Signals__c, Company_Signals_Status__c';

    public static String toText(Meeting_Brief__c brief) {
        List<String> lines = new List<String>{
            'Meeting brief ' + brief.Name + ' for ' + brief.Account__r?.Name + ' (' + brief.Status__c + ')'
        };
        if (brief.Status__c != MeetingBriefService.STATUS_READY && String.isNotBlank(brief.Status_Message__c)) {
            lines.add(brief.Status_Message__c);
        }
        for (MeetingBriefSections.Section section : MeetingBriefSections.ALL) {
            if (brief.get(section.statusField) != MeetingBriefService.SECTION_READY) {
                continue;
            }
            Map<String, Object> stored = (Map<String, Object>) JSON.deserializeUntyped((String) brief.get(section.contentField));
            Map<String, Object> references = stored.get('references') instanceof Map<String, Object>
                ? (Map<String, Object>) stored.get('references') : new Map<String, Object>();
            lines.add('');
            lines.add(section.label.toUpperCase());
            render(stored.get('content'), references, lines, '');
        }
        return String.join(lines, '\n');
    }

    private static void render(Object node, Map<String, Object> references, List<String> lines, String indent) {
        if (node instanceof String) {
            if (String.isNotBlank((String) node)) {
                lines.add(indent + plain((String) node));
            }
        } else if (node instanceof List<Object>) {
            for (Object item : (List<Object>) node) {
                String text = item instanceof Map<String, Object>
                    ? inline((Map<String, Object>) item, references)
                    : (item instanceof String ? plain((String) item) : null);
                if (String.isNotBlank(text)) {
                    lines.add(indent + '- ' + text);
                }
            }
        } else if (node instanceof Map<String, Object>) {
            Map<String, Object> entry = (Map<String, Object>) node;
            for (String key : orderedKeys(entry)) {
                Object value = entry.get(key);
                if (key == 'ref' || isEmpty(value)) {
                    continue;
                }
                String label = labelOf(key);
                if (value instanceof String && String.isNotBlank(label)) {
                    lines.add(indent + label + ': ' + plain((String) value));
                } else if (String.isBlank(label)) {
                    render(value, references, lines, indent);
                } else {
                    lines.add(indent + label + ':');
                    render(value, references, lines, indent + '  ');
                }
            }
        }
    }

    // one list entry: the referenced record (e.g. a person and their title), then its text fields
    private static String inline(Map<String, Object> entry, Map<String, Object> references) {
        List<String> parts = new List<String>();
        Object reference = entry.get('ref') instanceof String ? references.get((String) entry.get('ref')) : null;
        if (reference instanceof Map<String, Object>) {
            Map<String, Object> details = (Map<String, Object>) reference;
            String title = details.get('title') instanceof String ? ' (' + details.get('title') + ')' : '';
            String dateText = details.get('date') instanceof String && !'Contact'.equals(details.get('type'))
                ? ((String) details.get('date')).left(10) + ' ' : '';
            parts.add(dateText + details.get('label') + title);
        }
        for (String key : orderedKeys(entry)) {
            Object value = entry.get(key);
            if (key == 'ref' || !(value instanceof String) || String.isBlank((String) value)) {
                continue;
            }
            String label = labelOf(key);
            parts.add(String.isBlank(label) ? plain((String) value) : label + ': ' + plain((String) value));
        }
        return String.join(parts, ' | ');
    }

    private static List<String> orderedKeys(Map<String, Object> entry) {
        List<String> keys = new List<String>();
        for (String key : KEY_ORDER) {
            if (entry.containsKey(key)) {
                keys.add(key);
            }
        }
        for (String key : entry.keySet()) {
            if (!KEY_ORDER.contains(key)) {
                keys.add(key);
            }
        }
        return keys;
    }

    private static String labelOf(String key) {
        return LABELS.containsKey(key) ? LABELS.get(key) : key;
    }

    private static Boolean isEmpty(Object value) {
        return value == null
            || (value instanceof String && String.isBlank((String) value))
            || (value instanceof List<Object> && ((List<Object>) value).isEmpty());
    }

    private static String plain(String text) {
        return INLINE_REF.matcher(text).replaceAll('$1');
    }
}
