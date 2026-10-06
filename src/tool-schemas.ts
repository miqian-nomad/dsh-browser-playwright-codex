/**
 * tool-schemas：从 tool.ts 拆出的一部分（纯搬运，行为不变）。
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
} as const

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
} as const

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
} as const
