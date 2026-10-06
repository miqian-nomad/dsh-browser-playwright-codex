/**
 * 工具参数 schema：快照、标签、截图三个工具的参数外形，与工具注册处共用同一份定义。
 * @module dsh-browser-playwright-codex/tool-schemas
 */
export const SNAPSHOT_SCHEMA = {
    type: 'object',
    properties: {
        url: { type: 'string' },
        title: { type: 'string' },
        refs: { type: 'integer' },
        truncated: { type: 'boolean' },
        tree: { type: 'string' },
    },
    additionalProperties: false,
};
export const TABS_SCHEMA = {
    type: 'object',
    properties: {
        tabs: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    index: { type: 'integer' },
                    url: { type: 'string' },
                    title: { type: 'string' },
                    active: { type: 'boolean' },
                },
                additionalProperties: false,
            },
        },
    },
    additionalProperties: false,
};
export const SCREENSHOT_SCHEMA = {
    type: 'object',
    properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        url: { type: 'string' },
    },
    additionalProperties: false,
};
