// Smoke test for config.json loading (defaults, partial files, invalid input).
// Run: node test/config.test.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CONFIG_DEFAULTS, isGitlabReady, loadConfig, mergeConfigText, saveConfig, validateConfigInput } from '../server/utils/config.ts'

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

// --- admin UI round trip: validate, merge over hand-edits, save live ---
const merged = JSON.parse(mergeConfigText('{"strange":{"a":1},"gateway":{"extra":"keep","queueMax":5}}', {
  db: { path: 'p.db' }, auth: { enabled: true, gitlab: CONFIG_DEFAULTS.auth.gitlab }, gateway: { ...CONFIG_DEFAULTS.gateway, queueMax: 7 }
}))
check('merge keeps keys Pazuzu does not know', merged.strange?.a === 1 && merged.gateway.extra === 'keep')
check('merge overwrites the known fields', merged.gateway.queueMax === 7 && merged.db.path === 'p.db' && merged.auth.enabled === true)
check('merge on broken text writes a clean config', JSON.parse(mergeConfigText('not json {{{', { db: { path: 'p.db' }, auth: { enabled: false, gitlab: CONFIG_DEFAULTS.auth.gitlab }, gateway: CONFIG_DEFAULTS.gateway })).auth.gitlab.enabled === false)

const good = validateConfigInput({
  db: { path: ' data/x.db ' },
  auth: { enabled: true, gitlab: { ...CONFIG_DEFAULTS.auth.gitlab, enabled: true, baseUrl: 'http://gitlab.lan/', clientId: ' cid ', clientSecret: ' sec ', allowedGroups: ['ops', '  ', 42] } },
  gateway: { ...CONFIG_DEFAULTS.gateway, queueMax: 7 }
})
check('validate: good form has no errors', good.errors.length === 0)
check('validate: values normalized', good.config.db.path === 'data/x.db' && good.config.auth.gitlab.baseUrl === 'http://gitlab.lan' && good.config.auth.gitlab.clientId === 'cid')
check('validate: allowedGroups filtered to strings', JSON.stringify(good.config.auth.gitlab.allowedGroups) === '["ops"]')

const bad = validateConfigInput({
  db: { path: '  ' },
  auth: { enabled: 'yes', gitlab: { enabled: true, baseUrl: 42, clientId: '', clientSecret: '' } },
  gateway: { queueMax: 99999, sessionIdleMin: 0 }
})
check('validate: empty db.path rejected', bad.errors.some(e => e.startsWith('db.path')))
check('validate: wrong types rejected', bad.errors.some(e => e.startsWith('auth.enabled')) && bad.errors.some(e => e.startsWith('auth.gitlab.baseUrl')))
check('validate: half-configured gitlab rejected', bad.errors.some(e => e.startsWith('auth.gitlab:')))
check('validate: out-of-range numbers rejected', bad.errors.some(e => e.startsWith('gateway.queueMax')) && bad.errors.some(e => e.startsWith('gateway.sessionIdleMin')))

await write(JSON.stringify({ futureSetting: { keep: true }, gateway: { queueMax: 5 } }))
saveConfig(good.config)
cfg = loadConfig()
check('saveConfig takes effect without a restart', cfg.auth.enabled === true && cfg.db.path === 'data/x.db' && cfg.gateway.queueMax === 7)
const savedRaw = JSON.parse(readFileSync(file, 'utf8'))
check('saveConfig keeps hand-added keys', savedRaw.futureSetting?.keep === true)
saveConfig(validateConfigInput({ db: { path: 'a.db' }, auth: { enabled: false, gitlab: CONFIG_DEFAULTS.auth.gitlab }, gateway: { ...CONFIG_DEFAULTS.gateway, queueMax: 9 } }).config)
saveConfig(validateConfigInput({ db: { path: 'b.db' }, auth: { enabled: false, gitlab: CONFIG_DEFAULTS.auth.gitlab }, gateway: { ...CONFIG_DEFAULTS.gateway, queueMax: 11 } }).config)
cfg = loadConfig()
check('back-to-back saves reload the cache', cfg.db.path === 'b.db' && cfg.gateway.queueMax === 11)

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
