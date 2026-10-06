/** Strip markdown fences and whitespace, then parse one JSON document. */
export function parseJsonText(raw) {
    let text = raw.trim();
    const fenced = /^\s*```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text);
    if (fenced !== null) {
        const inner = fenced[1];
        if (inner !== undefined)
            text = inner.trim();
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error('browser_extract: the model output is not valid JSON: ' + text.slice(0, 500));
    }
}
/**
 * Prompt template for structured page extraction. `maxInputChars` bounds the page
 * data handed to the auxiliary model — that model is billed on this prompt, so an
 * unbounded page is a tax on every extraction.
 */
export function extractionPrompt(instruction, data, maxInputChars) {
    const page = JSON.stringify(data);
    const bounded = page.length > maxInputChars
        ? page.slice(0, maxInputChars) + ' [page data truncated at ' + String(maxInputChars) + ' characters]'
        : page;
    return ('Extract the following from the page data according to the instruction. ' +
        'Answer with ONLY one valid JSON value (object, array, or scalar), no prose, no markdown fences.\n\n' +
        'Instruction: ' +
        instruction +
        '\n\n' +
        'Page data (JSON):\n' +
        bounded);
}
