// Smoke test for config.json loading (defaults, partial files, invalid input).
// Run: node test/config.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CONFIG_DEFAULTS, isGitlabReady, loadConfig } from '../server/utils/config.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'pazuzu-config-test-'))
const file = join(dir, 'config.json')
process.env.PAZUZU_CONFIG = file

// the loader caches by file mtime - pause between writes so they differ
async function write (text) {
  await sleep(10)
  writeFileSync(file, text)
}

await write(JSON.stringify({ auth: { enabled: true } }))
let cfg = loadConfig()
check('auth.enabled from file', cfg.auth.enabled === true)
check('missing db.path falls back to default', cfg.db.path === CONFIG_DEFAULTS.db.path)
check('gitlab off by default', cfg.auth.gitlab.enabled === false && !isGitlabReady(cfg))

await write(JSON.stringify({
  auth: { enabled: true, gitlab: { enabled: true, baseUrl: 'http://gitlab.lan/', clientId: ' cid ', clientSecret: 'sec', allowedGroups: ['ops', '', 42] } }
}))
cfg = loadConfig()
check('gitlab fields parsed', cfg.auth.gitlab.enabled === true && cfg.auth.gitlab.clientId === 'cid' && isGitlabReady(cfg))
check('gitlab baseUrl trimmed of slashes', cfg.auth.gitlab.baseUrl === 'http://gitlab.lan')
check('gitlab allowedGroups filtered to strings', JSON.stringify(cfg.auth.gitlab.allowedGroups) === '["ops"]')
check('gitlab tls options off by default', cfg.auth.gitlab.caCert === '' && cfg.auth.gitlab.insecureTls === false)

const warnLog = console.warn
console.warn = () => { /* expected insecureTls warning */ }
await write(JSON.stringify({ auth: { enabled: true, gitlab: { enabled: true, baseUrl: 'http://gitlab.lan', clientId: 'cid', clientSecret: 'sec', caCert: ' certs/ca.pem ', insecureTls: 'yes' } } }))
cfg = loadConfig()
check('gitlab caCert trimmed', cfg.auth.gitlab.caCert === 'certs/ca.pem')
check('gitlab insecureTls only accepts true', cfg.auth.gitlab.insecureTls === false)
await write(JSON.stringify({ auth: { enabled: true, gitlab: { enabled: true, baseUrl: 'http://gitlab.lan', clientId: 'cid', clientSecret: 'sec', insecureTls: true } } }))
cfg = loadConfig()
check('gitlab insecureTls true parsed', cfg.auth.gitlab.insecureTls === true && isGitlabReady(cfg))
console.warn = warnLog

await write(JSON.stringify({ auth: { enabled: true, gitlab: { enabled: true, baseUrl: 'http://gitlab.lan', clientId: 'cid' } } }))
cfg = loadConfig()
check('gitlab without secret is not ready', !isGitlabReady(cfg))

await write(JSON.stringify({ auth: { enabled: false, gitlab: { enabled: true, baseUrl: 'http://gitlab.lan', clientId: 'cid', clientSecret: 'sec' } } }))
cfg = loadConfig()
check('gitlab needs auth.enabled to be ready', !isGitlabReady(cfg))

await write(JSON.stringify({ db: { path: 'x/other.db' }, auth: { enabled: false } }))
cfg = loadConfig()
check('db.path from file', cfg.db.path === 'x/other.db' && cfg.auth.enabled === false)

await write(JSON.stringify({ db: { path: 42 }, auth: { enabled: 'yes' } }))
cfg = loadConfig()
check('wrong types fall back to defaults', cfg.db.path === CONFIG_DEFAULTS.db.path && cfg.auth.enabled === false)

await write(JSON.stringify({ gateway: { enabled: true, queueTimeoutS: 5, queueMax: 10, defaultCapacity: 4 } }))
cfg = loadConfig()
check('gateway parsed from file', cfg.gateway.enabled === true && cfg.gateway.queueTimeoutS === 5 && cfg.gateway.queueMax === 10 && cfg.gateway.defaultCapacity === 4)
check('gateway unset fields use defaults', cfg.gateway.sessionIdleMin === CONFIG_DEFAULTS.gateway.sessionIdleMin && cfg.gateway.ejectionS === CONFIG_DEFAULTS.gateway.ejectionS)
await write(JSON.stringify({ gateway: { queueTimeoutS: 'nope', queueMax: -3, queueMaxPerClient: 0 } }))
cfg = loadConfig()
check('gateway stays off unless explicitly enabled', cfg.gateway.enabled === false)
check('gateway bad numbers fall back to defaults', cfg.gateway.queueTimeoutS === CONFIG_DEFAULTS.gateway.queueTimeoutS && cfg.gateway.queueMax === CONFIG_DEFAULTS.gateway.queueMax && cfg.gateway.queueMaxPerClient === CONFIG_DEFAULTS.gateway.queueMaxPerClient)

const errLog = console.error
console.error = () => { /* expected parse error */ }
await write('not json {{{')
cfg = loadConfig()
check('invalid json falls back to defaults', cfg.db.path === CONFIG_DEFAULTS.db.path && cfg.auth.enabled === false)
console.error = errLog

process.env.PAZUZU_CONFIG = join(dir, 'does-not-exist.json')
cfg = loadConfig()
check('missing file uses defaults', cfg.db.path === CONFIG_DEFAULTS.db.path && cfg.auth.enabled === false)

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exitCode = failed > 0 ? 1 : 0
