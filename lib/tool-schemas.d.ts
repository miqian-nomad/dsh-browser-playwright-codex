/**
 * tool-schemas：从 tool.ts 拆出的一部分（纯搬运，行为不变）。
 * @module dsh-browser-playwright-codex/tool-schemas
 */
export declare const SNAPSHOT_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly url: {
            readonly type: "string";
        };
        readonly title: {
            readonly type: "string";
        };
        readonly refs: {
            readonly type: "integer";
        };
        readonly truncated: {
            readonly type: "boolean";
        };
        readonly tree: {
            readonly type: "string";
        };
    };
    readonly additionalProperties: false;
};
export declare const TABS_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly tabs: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly properties: {
                    readonly index: {
                        readonly type: "integer";
                    };
                    readonly url: {
                        readonly type: "string";
                    };
                    readonly title: {
                        readonly type: "string";
                    };
                    readonly active: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
        };
    };
    readonly additionalProperties: false;
};
export declare const SCREENSHOT_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly attachmentId: {
            readonly type: "string";
        };
        readonly mediaType: {
            readonly type: "string";
        };
        readonly bytes: {
            readonly type: "integer";
        };
        readonly width: {
            readonly type: "integer";
        };
        readonly height: {
            readonly type: "integer";
        };
        readonly url: {
            readonly type: "string";
        };
    };
    readonly additionalProperties: false;
};
