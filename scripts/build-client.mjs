/**
 * Copy the hand-written Settings-card client bundle into the build output.
 *
 * The client half is authored plain JS (`client/client.js`, absorbed from
 * dsh-browser-toggle 0.3.0) because it talks to the browser shell through
 * `window.__ModuleLoader__` and a `require()` shim — none of which TypeScript
 * can check meaningfully. `tsc` only compiles `src/`, so this step puts the
 * artifact where `package.json#exports["./client"]` expects it.
 *
 * The copy is byte-identical, so `git diff --exit-code -- lib` stays a valid
 * "src and lib agree" guard in CI and in the publish workflow.
 *
 * @module scripts/build-client
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
mkdirSync(fileURLToPath(new URL('lib/', root)), { recursive: true })
copyFileSync(fileURLToPath(new URL('client/client.js', root)), fileURLToPath(new URL('lib/client.js', root)))
process.stdout.write('build-client: lib/client.js (from client/client.js)\n')
