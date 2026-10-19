/**
 * Settings card host half, absorbed from dsh-browser-toggle 0.3.0 (2026-10-19).
 * Same four /api/browser-playwright routes and CSRF rules; the only change is that the
 * runtime state is now a sibling module instead of a package specifier.
 *
 * @module dsh-browser-playwright-codex/settings-card
 */
// @ts-nocheck — absorbed verbatim from the standalone package (plain JS), typed later.
/**
 * dsh-browser-toggle - Host half.
 *
 * HTTP API for the Settings → Plugins UI card that flips the runtime enable
 * flag of dsh-browser-playwright-codex without restarting DSH.
 *
 *   GET  /api/browser-playwright/state             -> { enabled, engine, engineUserChosen, allowEvaluate, allowCdp }
 *   POST /api/browser-playwright/toggle {enabled}   -> { enabled, changed }
 *   POST /api/browser-playwright/engine {engine}    -> { engine, changed }
 *   POST /api/browser-playwright/gates {allowEvaluate, allowCdp} -> { allowEvaluate, allowCdp, changed }
 *   GET  /api/browser-playwright/logins             -> { logins: { source, capturedAt, cookies, total, sites } | null }
 *
 * `allowEvaluate` / `allowCdp` are the two power gates of the browser tool
 * family: arbitrary page JavaScript and raw CDP. They are registration-time
 * settings (an off gate means the tool is not registered at all, which is how
 * the plugin keeps them out of the resident prompt), so this route cannot flip
 * them in memory — it writes them into the home-level cordis.patch.yml, the
 * layer with the highest priority among patch files, and lets the profile's
 * `patchReload: live` re-apply the tree. The Settings page therefore reads the
 * *effective* values published by the tool family (runtime-state.getGates),
 * never a guess at the package default.
 *
 * The package itself ships both gates off: cordis.patch.yml travels inside the
 * package, so anything it enabled would be enabled for every installer. This
 * route is how a user opts in, in their own layer.
 *
 * `engine` is the page-reading mode: 'legacy' (the plugin's own DOM walk) or
 * 'aria' (the browser's official accessibility tree). It is a user setting too,
 * so it lives next to the enable flag and applies from the next operation on —
 * no restart, no config edit. `engineUserChosen` says whether the current mode
 * is the user's own pick or still the configured default.
 *
 * The enable flag lives in dsh-browser-playwright-codex's shared module
 * (lib/runtime-state.js, persisted to ~/.dsh/dsh-browser-playwright.state.json —
 * the file name is intentionally stable across package renames so the user's
 * saved switch survives). Importing it through the package export
 * gives this plugin the SAME module instance as the playwright provider, so
 * flipping the flag here triggers the provider's disable-subscription (tears
 * down any open window) in-process, and every future browser acquire is
 * rejected while disabled.
 *
 * The specifier below must match the provider package's package.json#name.
 * 2026-09-30: the provider was renamed to *-codex; the old specifier stopped
 * resolving (MODULE_NOT_FOUND) and the toggle failed to load, so the import and
 * the node_modules link have to move together with the rename.
 *
 * CSRF: POST requires the custom `x-dsh-plugin: browser-toggle` header, the
 * same pattern as dsh-local-switch.
 */
// Namespace import on purpose: this host half and the provider package are
// separate plugins, and a profile that is still running an older provider build
// would otherwise fail at link time with "does not provide an export named".
// Missing helpers degrade to "unknown" instead of breaking the Settings page.
import * as runtimeState from './runtime-state.ts'
// The patch writer lives in its own dependency-free module so it can be tested
// without a DSH host (a half-written patch layer would break every plugin load).
import { homePatchPath, parseGatesBlock, writeGates } from './gates-patch.ts'
import { readFileSync } from 'node:fs'

const { getEnabled, setEnabled, getEffectiveEngine, setSnapshotEngine, isEngineUserChosen } = runtimeState

export const name = 'browser-toggle'
export const inject = ['webServer']

const PREFIX = '/api/browser-playwright'
const HEADER = 'x-dsh-plugin'

/** Read the gates the tool family published, or undefined while unknown. */
function readGates() {
  if (typeof runtimeState.getGates !== 'function') return undefined
  try {
    const gates = runtimeState.getGates()
    if (gates && typeof gates.allowEvaluate === 'boolean' && typeof gates.allowCdp === 'boolean') return gates
  } catch {
    /* fall through to unknown */
  }
  return undefined
}

/**
 * Report the current managed block (what the user's own layer says). The switch
 * shows the *effective* gates from readGates(); this is the file-level view used
 * for diagnostics when the two disagree (i.e. the reload has not landed yet).
 */
function managedBlockGates() {
  try {
    const text = readFileSync(homePatchPath(), 'utf8')
    return parseGatesBlock(text)
  } catch {
    return undefined
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  try {
    for await (const chunk of req) chunks.push(chunk)
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/state`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET only' } })
        // Required even for a read: this exposes the deployment's switch state. A custom
        // header forces a CORS preflight, which is what stops any other page in the
        // browser from reading it off 127.0.0.1 (2026-10-16: only the POST routes had it).
        if (req.headers[HEADER] !== 'browser-toggle')
          return sendJson(res, 403, { error: { code: 'CSRF', message: 'missing plugin header' } })
        const gates = readGates()
        sendJson(res, 200, {
          enabled: getEnabled(),
          engine: getEffectiveEngine(),
          engineUserChosen: isEngineUserChosen(),
          // Effective values, published by the tool family itself. null = the
          // provider build in this profile is too old to report them.
          allowEvaluate: gates ? gates.allowEvaluate : null,
          allowCdp: gates ? gates.allowCdp : null,
          diagnostics: gates ? gates.diagnostics : null,
          // What the user's own layer says right now. Differs from the above
          // between a write and the live reload that applies it.
          patchGates: managedBlockGates() ?? null,
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/toggle`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        if (req.headers[HEADER] !== 'browser-toggle')
          return sendJson(res, 403, { error: { code: 'CSRF', message: 'missing plugin header' } })
        const body = await readBody(req)
        if (!body.ok) return sendJson(res, 400, { error: { code: 'BODY_READ', message: body.error } })
        let payload
        try {
          payload = JSON.parse(body.text || '{}')
        } catch {
          return sendJson(res, 400, { error: { code: 'INVALID_JSON', message: 'body must be JSON' } })
        }
        if (typeof payload.enabled !== 'boolean')
          return sendJson(res, 400, { error: { code: 'INVALID_BODY', message: '`enabled` must be a boolean' } })
        const changed = setEnabled(payload.enabled)
        sendJson(res, 200, { enabled: getEnabled(), changed })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/engine`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        if (req.headers[HEADER] !== 'browser-toggle')
          return sendJson(res, 403, { error: { code: 'CSRF', message: 'missing plugin header' } })
        const body = await readBody(req)
        if (!body.ok) return sendJson(res, 400, { error: { code: 'BODY_READ', message: body.error } })
        let payload
        try {
          payload = JSON.parse(body.text || '{}')
        } catch {
          return sendJson(res, 400, { error: { code: 'INVALID_JSON', message: 'body must be JSON' } })
        }
        if (payload.engine !== 'legacy' && payload.engine !== 'aria')
          return sendJson(res, 400, {
            error: { code: 'INVALID_BODY', message: '`engine` must be "legacy" or "aria"' },
          })
        const changed = setSnapshotEngine(payload.engine)
        sendJson(res, 200, { engine: getEffectiveEngine(), changed })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/gates`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        if (req.headers[HEADER] !== 'browser-toggle')
          return sendJson(res, 403, { error: { code: 'CSRF', message: 'missing plugin header' } })
        const body = await readBody(req)
        if (!body.ok) return sendJson(res, 400, { error: { code: 'BODY_READ', message: body.error } })
        let payload
        try {
          payload = JSON.parse(body.text || '{}')
        } catch {
          return sendJson(res, 400, { error: { code: 'INVALID_JSON', message: 'body must be JSON' } })
        }
        if (typeof payload.diagnostics !== 'boolean') payload.diagnostics = false
        if (typeof payload.allowEvaluate !== 'boolean' || typeof payload.allowCdp !== 'boolean')
          return sendJson(res, 400, {
            error: {
              code: 'INVALID_BODY',
              message: '`allowEvaluate` and `allowCdp` must both be booleans',
            },
          })
        const before = readGates()
        if (
          before &&
          before.allowEvaluate === payload.allowEvaluate &&
          before.allowCdp === payload.allowCdp &&
          before.diagnostics === payload.diagnostics
        )
          return sendJson(res, 200, { ...before, changed: false, patch: null })
        try {
          const written = await writeGates(payload.allowEvaluate, payload.allowCdp, payload.diagnostics)
          // The effective values only move once the loader re-applies the tree
          // (profile patchReload: live); report what was written, and let the
          // panel's next /state poll show whether it took effect.
          sendJson(res, 200, {
            allowEvaluate: written.allowEvaluate,
            allowCdp: written.allowCdp,
            diagnostics: written.diagnostics,
            changed: true,
            patch: written.patch,
          })
        } catch (error) {
          sendJson(res, 500, {
            error: { code: 'PATCH_WRITE', message: String(error?.message ?? error) },
          })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/logins`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET only' } })
        // The CSRF header is mandatory here, and this route is the reason the rule exists:
        // the payload is a list of the sites this browser is signed in to. A custom header
        // forces a preflight, so no other page in the browser can read it off 127.0.0.1.
        if (req.headers[HEADER] !== 'browser-toggle')
          return sendJson(res, 403, { error: { code: 'CSRF', message: 'missing plugin header' } })
        // Read-only, display-only: the provider publishes this summary (counts and domain
        // names, never cookie values or names). null = nothing published yet, or the
        // provider build in this profile is too old to publish it.
        let logins = null
        if (typeof runtimeState.getLoginSites === 'function') {
          try {
            logins = runtimeState.getLoginSites() ?? null
          } catch {
            logins = null
          }
        }
        sendJson(res, 200, { logins })
      },
    }),
  )
}

export default { name, inject, apply }
