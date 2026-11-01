// Turns the stored section JSON ({ content, references, coverage }) into a render model; never produces HTML.
const LABELS = {
    whyItMatters: 'Why it matters',
    whatChanged: 'What changed',
    suggestedGoal: 'Suggested goal',
    people: 'People',
    worthKnowing: '',
    recent: 'Recent conversations',
    text: '',
    openCommitment: 'Open commitment',
    owned: 'Products owned',
    lapsed: 'Lapsed products',
    opportunities: 'Opportunities',
    summary: '',
    highlights: '',
    items: 'Recent events',
    date: '',
    headline: '',
    soWhat: 'So what',
    hiring: 'Hiring',
    talkingPoints: 'Talking points',
    questions: 'Questions to ask',
    watchOuts: 'Watch outs'
};
const KEY_ORDER = [
    'whyItMatters', 'whatChanged', 'suggestedGoal', 'people', 'recent', 'owned', 'lapsed', 'opportunities',
    'summary', 'highlights', 'items', 'hiring', 'talkingPoints', 'questions', 'watchOuts',
    'date', 'headline', 'worthKnowing', 'text', 'soWhat', 'openCommitment'
];
const INLINE_REF = /\[([^[\]]+)\]\(([A-Z]{2,5}-\d{1,4})\)/g;
const RECORD_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

export const SECTIONS = [
    { key: 'overview', label: 'Bottom Line', field: 'Overview__c', statusField: 'Overview_Status__c' },
    { key: 'conversations', label: "Who You're Meeting", field: 'Conversations__c', statusField: 'Conversations_Status__c' },
    { key: 'accountHealth', label: 'Where We Stand', field: 'Account_Health__c', statusField: 'Account_Health_Status__c' },
    { key: 'companySignals', label: "What's New", field: 'Company_Signals__c', statusField: 'Company_Signals_Status__c' },
    { key: 'approach', label: 'Call Plan', field: 'Approach__c', statusField: 'Approach_Status__c' }
];

export function buildSections(brief) {
    const coverage = new Map();
    const sections = [];
    SECTIONS.forEach((definition) => {
        const status = brief[definition.statusField];
        if (status !== 'Ready' && status !== 'Error') {
            return;
        }
        const stored = status === 'Ready' ? parse(brief[definition.field]) : null;
        (stored?.coverage || []).forEach((entry) => {
            if (entry?.source && (!coverage.has(entry.source) || entry.status === 'Available')) {
                coverage.set(entry.source, entry);
            }
        });
        const blocks = stored ? buildBlocks(stored.content || {}, stored.references || {}, definition.key, 0) : [];
        sections.push({
            key: definition.key,
            label: definition.label,
            isError: status === 'Error' || !stored,
            isEmpty: !!stored && blocks.length === 0,
            blocks
        });
    });
    return { sections, coverage: [...coverage.values()].map(toCoverageBadge) };
}

function buildBlocks(content, references, prefix, level) {
    const blocks = [];
    orderedKeys(content).forEach((key) => {
        const value = content[key];
        if (key === 'ref' || isEmpty(value)) {
            return;
        }
        const id = `${prefix}.${key}`;
        const block = { key: id, label: labelOf(key), className: level ? 'brief-block brief-block_nested' : 'brief-block' };
        if (typeof value === 'string') {
            blocks.push({ ...block, segments: toSegments(value, references, id) });
        } else if (Array.isArray(value)) {
            const items = value.map((item, index) => buildItem(item, references, `${id}.${index}`)).filter((item) => item);
            if (items.length) {
                blocks.push({ ...block, items });
            }
        } else if (typeof value === 'object') {
            const children = buildBlocks(value, references, id, block.label ? level + 1 : level);
            if (children.length) {
                if (block.label) {
                    blocks.push(block);
                }
                blocks.push(...children);
            }
        }
    });
    return blocks;
}

function buildItem(item, references, id) {
    if (typeof item === 'string') {
        return item.trim() ? { key: id, fields: [{ key: `${id}.text`, segments: toSegments(item, references, id) }] } : null;
    }
    if (!item || typeof item !== 'object') {
        return null;
    }
    const fields = orderedKeys(item)
        .filter((key) => key !== 'ref' && typeof item[key] === 'string' && item[key].trim())
        .map((key) => ({
            key: `${id}.${key}`,
            label: labelOf(key),
            segments: toSegments(item[key], references, `${id}.${key}`)
        }));
    const reference = typeof item.ref === 'string' ? references[item.ref] : null;
    if (!reference && !fields.length) {
        return null;
    }
    return { key: id, reference: reference ? toReference(reference) : null, fields };
}

function toReference(reference) {
    const date = typeof reference.date === 'string' && reference.type !== 'Contact' ? reference.date.slice(0, 10) : '';
    const details = [reference.title, reference.type !== 'Contact' ? reference.type : null, date]
        .filter((part) => typeof part === 'string' && part);
    return { label: reference.label, url: recordUrl(reference.recordId), detail: details.join(' · ') };
}

function toSegments(text, references, prefix) {
    const segments = [];
    const pattern = new RegExp(INLINE_REF.source, 'g');
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) {
            segments.push({ text: text.slice(last, match.index) });
        }
        const reference = references[match[2]];
        segments.push({ text: match[1], url: recordUrl(reference?.recordId), title: reference?.label });
        last = pattern.lastIndex;
    }
    if (last < text.length) {
        segments.push({ text: text.slice(last) });
    }
    return segments.map((segment, index) => ({ ...segment, key: `${prefix}.${index}` }));
}

function toCoverageBadge(entry) {
    const available = entry.status === 'Available';
    const count = available && entry.count != null ? ` (${entry.count})` : '';
    return {
        key: entry.source,
        label: available ? `${entry.label}${count}` : `${entry.label}: ${entry.status}`,
        icon: available ? 'utility:success' : 'utility:warning'
    };
}

function recordUrl(recordId) {
    return typeof recordId === 'string' && RECORD_ID.test(recordId) ? `/lightning/r/${recordId}/view` : null;
}

function orderedKeys(entry) {
    const keys = KEY_ORDER.filter((key) => key in entry);
    return keys.concat(Object.keys(entry).filter((key) => !KEY_ORDER.includes(key)));
}

function labelOf(key) {
    return key in LABELS ? LABELS[key] : key;
}

function isEmpty(value) {
    return value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

function parse(json) {
    try {
        return json ? JSON.parse(json) : null;
    } catch (e) {
        return null;
    }
}
