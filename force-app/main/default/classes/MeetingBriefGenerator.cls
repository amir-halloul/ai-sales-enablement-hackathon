/**
 * Runs a meeting brief section prompt and turns the model output into stored section JSON
 * { content, references, coverage, lists }. Citations to unknown refs are dropped.
 */
public with sharing class MeetingBriefGenerator {
    public class GeneratorException extends Exception {}

    private static final Integer CONTENT_MAX_LENGTH = 131072;
    // inline citation [cited words](OPP-1)
    private static final Pattern INLINE_REF = Pattern.compile('\\[([^\\[\\]]+)\\]\\(([A-Z]{2,5}-\\d{1,4})\\)');
    // bare [OPP-1] the model sometimes writes instead of a citation
    private static final Pattern BARE_REF = Pattern.compile('\\s*\\[([A-Z]{2,5}-\\d{1,4})\\](?!\\()');
    // "[PRD-1], [CAT-2] and [OPP-1]": a run of bare refs; only the first is kept
    private static final Pattern BARE_REF_RUN = Pattern.compile(
        '(\\[[A-Z]{2,5}-\\d{1,4}\\])(?:\\s*(?:[,;]|and)?\\s*\\[[A-Z]{2,5}-\\d{1,4}\\](?!\\())+'
    );
    // up to 4 words ending the text, without punctuation or brackets
    private static final Pattern TRAILING_WORDS = Pattern.compile('((?:[^\\s\\[\\]().,;:]+\\s+){0,3}[^\\s\\[\\]().,;:]+)$');

    public interface PromptRunner {
        String run(String templateName, Id accountId);
    }

    @TestVisible
    private static PromptRunner promptRunner = new EinsteinPromptRunner();

    /**
     * Generates one section. The context must be primed first; makes no DML.
     */
    public static String generateSection(Id accountId, String sectionKey) {
        MeetingBriefSections.Section section = MeetingBriefSections.get(sectionKey);
        String output = promptRunner.run(section.promptTemplate, accountId);
        if (String.isBlank(output)) {
            throw new GeneratorException('The prompt template ' + section.promptTemplate + ' returned no text.');
        }
        return buildSection(output, MeetingBriefContextService.forSection(accountId, sectionKey));
    }

    private static String buildSection(String output, MeetingBriefContextService.SectionContext context) {
        Object parsed;
        try {
            parsed = JSON.deserializeUntyped(stripCodeFence(output));
        } catch (JSONException e) {
            throw new GeneratorException('The model did not return valid JSON.');
        }
        if (!(parsed instanceof Map<String, Object>)) {
            throw new GeneratorException('The model did not return a JSON object.');
        }
        Map<String, Object> cited = new Map<String, Object>();
        Map<String, Object> section = new Map<String, Object>{
            'content' => cite(parsed, context.references, cited),
            'references' => cited,
            'coverage' => context.coverage
        };
        if (!context.lists.isEmpty()) {
            section.put('lists', context.lists);
        }
        String serialized = JSON.serialize(section);
        if (serialized.length() > CONTENT_MAX_LENGTH) {
            throw new GeneratorException('The generated section is too large to store.');
        }
        return serialized;
    }

    // keeps citations and "ref" values of known references, collects them, and drops the ones the model made up
    private static Object cite(Object node, Map<String, Map<String, Object>> references, Map<String, Object> cited) {
        if (node instanceof String) {
            return citeText((String) node, references, cited);
        }
        if (node instanceof List<Object>) {
            List<Object> items = new List<Object>();
            for (Object item : (List<Object>) node) {
                items.add(cite(item, references, cited));
            }
            return items;
        }
        if (!(node instanceof Map<String, Object>)) {
            return node;
        }
        Map<String, Object> entry = (Map<String, Object>) node;
        Map<String, Object> result = new Map<String, Object>();
        for (String key : entry.keySet()) {
            Object value = entry.get(key);
            if (key != 'ref') {
                result.put(key, cite(value, references, cited));
            } else if (value instanceof String && references.containsKey((String) value)) {
                cited.put((String) value, references.get((String) value));
                result.put(key, value);
            }
        }
        return result;
    }

    // unknown citations keep only their words; bold markers are dropped
    private static String citeText(String text, Map<String, Map<String, Object>> references, Map<String, Object> cited) {
        text = wrapBareRefs(text);
        Matcher matcher = INLINE_REF.matcher(text);
        String result = '';
        Integer last = 0;
        while (matcher.find()) {
            String ref = matcher.group(2);
            result += text.substring(last, matcher.start());
            if (references.containsKey(ref)) {
                cited.put(ref, references.get(ref));
                result += matcher.group();
            } else {
                result += matcher.group(1);
            }
            last = matcher.end();
        }
        return (result + text.substring(last)).replace('**', '').trim();
    }

    // "125 licenses [PRD-1]" becomes "[125 licenses](PRD-1)"; a marker with no words before it is dropped
    private static String wrapBareRefs(String text) {
        text = BARE_REF_RUN.matcher(text).replaceAll('$1');
        Matcher matcher = BARE_REF.matcher(text);
        String result = '';
        Integer last = 0;
        while (matcher.find()) {
            String before = text.substring(last, matcher.start());
            Matcher words = TRAILING_WORDS.matcher(before);
            if (words.find()) {
                result += before.substring(0, words.start()) + '[' + words.group(1) + '](' + matcher.group(1) + ')';
            } else {
                result += before;
            }
            last = matcher.end();
        }
        return result + text.substring(last);
    }

    private static String stripCodeFence(String output) {
        String text = output.trim();
        if (text.startsWith('```')) {
            text = text.substringAfter('\n').trim();
            if (text.endsWith('```')) {
                text = text.removeEnd('```');
            }
        }
        return text;
    }

    private class EinsteinPromptRunner implements PromptRunner {
        public String run(String templateName, Id accountId) {
            ConnectApi.WrappedValue account = new ConnectApi.WrappedValue();
            account.value = new Map<String, String>{ 'id' => accountId };

            ConnectApi.EinsteinPromptTemplateGenerationsInput input = new ConnectApi.EinsteinPromptTemplateGenerationsInput();
            input.inputParams = new Map<String, ConnectApi.WrappedValue>{ 'Input:Account' => account };
            input.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
            input.additionalConfig.applicationName = 'PromptBuilderPreview';
            input.isPreview = false;

            ConnectApi.EinsteinPromptTemplateGenerationsRepresentation output =
                ConnectApi.EinsteinLLM.generateMessagesForPromptTemplate(templateName, input);
            if (output?.generations == null || output.generations.isEmpty()) {
                return null;
            }
            return output.generations[0].text;
        }
    }
}
