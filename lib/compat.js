/**
 * Brand a string as a {@link ToolCallId}. Runtime identity, exactly like the
 * harness brand constructor it replaces.
 * @param id - the provider-issued or synthesized call id.
 * @returns the same string, branded.
 */
export function toolCallId(id) {
    return id;
}
/** Historical alias: the 0.1.6-and-earlier name, kept so call sites read the same. */
export const CallId = toolCallId;
