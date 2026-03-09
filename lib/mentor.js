const BASE_PROMPT = `You are an AI startup mentor.

## YOUR IDENTITY
You are modeled after experienced startup mentors and early-stage investors. You give direct, specific, useful feedback. You are not a cheerleader and you do not flatter weak ideas.

## YOUR MENTALITY
- Radical honesty over comfort.
- Push teams on validation, execution, differentiation, and business viability.
- Favor concrete evidence over vague ambition.
- Keep advice practical for an event team working under severe time pressure.

## HOW YOU EVALUATE
Probe for:
1. Problem severity
2. Solution uniqueness
3. Founder-market fit
4. Market timing
5. Business viability
6. Feasibility of what can be built now

## JUDGING CRITERIA
### 1. Customer Validation
- Real users interviewed
- Specific insights learned
- Clear pain point

### 2. Execution & Design
- Working MVP over slides
- Ability to demonstrate the core value
- Product clarity and usability

### 3. Business Model
- Clear target market
- Realistic revenue path
- Competitive understanding
- Plausible first-customer strategy

## RESPONSE STYLE
- Be direct.
- When you critique, follow with an actionable fix.
- Use markdown.
- Prefer structured answers when the user asks for evaluations, pitches, interviews, competition, or revenue analysis.`;

function getEventPrompt() {
    const eventName = process.env.EVENT_NAME?.trim();
    const eventYear = process.env.EVENT_YEAR?.trim();
    const eventSchedule = process.env.EVENT_SCHEDULE_MD?.trim();

    if (!eventName && !eventYear && !eventSchedule) {
        return '';
    }

    const title = [eventName, eventYear].filter(Boolean).join(' ').trim() || 'the current startup event';
    const lines = [`## EVENT CONTEXT`, `You are the AI mentor for ${title}.`];

    if (eventSchedule) {
        lines.push('', '### Event Schedule', eventSchedule);
    }

    return `\n\n${lines.join('\n')}`;
}

export function getTeamContextBlock(team) {
    if (team.teamIdea) {
        return `TEAM INFO:\nThe team "${team.teamName}" has the following startup idea: "${team.teamIdea}". Evaluate it critically from the first interaction.`;
    }

    return `TEAM INFO:\nThe team is called "${team.teamName}". They have not shared their idea yet, so ask for it and probe deeply.`;
}

export function buildMentorPrompt(team, summaryMd) {
    const sections = [BASE_PROMPT + getEventPrompt(), '', getTeamContextBlock(team)];

    if (summaryMd) {
        sections.push('', '## COMPACTED THREAD SUMMARY', summaryMd);
    }

    return sections.join('\n');
}

export function buildImagePromptText(userMessage, fileName) {
    if (typeof userMessage === 'string' && userMessage.trim()) {
        return userMessage.trim();
    }

    return `Evaluate this presentation slide (${fileName}) critically against customer validation, execution and design, and business model. Explain what is weak and how to fix it.`;
}

function renderMessages(messages) {
    return messages
        .map((message) => {
            const attachment = message.attachment_name ? `\nAttachment: ${message.attachment_name} (${message.attachment_mime || 'unknown mime'})` : '';
            return `### ${message.role.toUpperCase()}\n${message.content_md}${attachment}`;
        })
        .join('\n\n');
}

export function buildCompactionPrompt(team, existingSummary, messagesToCompact) {
    const sections = [
        'You are compressing a startup mentoring thread into durable context.',
        'Produce concise markdown that preserves facts, decisions, validation evidence, business model assumptions, open questions, and promised follow-ups.',
        'Do not invent details.',
        '',
        getTeamContextBlock(team)
    ];

    if (existingSummary) {
        sections.push('', '## Existing Summary', existingSummary);
    }

    sections.push('', '## Messages To Compact', renderMessages(messagesToCompact));
    sections.push(
        '',
        '## Required Output',
        '- Idea summary',
        '- Customer validation learned so far',
        '- Product and demo state',
        '- Business model and competition notes',
        '- Open risks and unanswered questions',
        '- Important constraints for future responses'
    );

    return sections.join('\n');
}
