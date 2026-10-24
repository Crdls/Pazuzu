#!/usr/bin/env node
// Applies a Pazuzu update after the server exits, then restarts it.
// Spawned detached by POST /api/update/apply with the server's PID as argv[2];
// stdout/stderr already point at data/update.log (inherited stdio).
// A failed step aborts the update, but the old build is always restarted so
// the monitor never stays down because of a bad pull or build.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parentPid = Number(process.argv[2]) || 0
const startedAt = Date.now()

// same rule as server/utils/config.ts db.path, resolved from the project root
function dataDir () {
  try {
    const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    if (typeof cfg?.db?.path === 'string' && cfg.db.path) return resolve(root, dirname(cfg.db.path))
  } catch { /* no/invalid config.json -> default data dir */ }
  return join(root, 'data')
}

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms))
}

function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false // ESRCH/EPERM: nothing to wait for (same user, so EPERM is not expected)
  }
}

async function waitForExit (pid) {
  if (!pid) return
  const deadline = Date.now() + 120_000
  while (alive(pid) && Date.now() < deadline) await sleep(300)
  // let the OS fully release the listen port before binding it again
  await sleep(1500)
}

function run (cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true, windowsHide: true })
  if (res.error) {
    console.log(`! ${cmd} failed to start: ${res.error.message}`)
    return false
  }
  if (res.status !== 0) {
    console.log(`! ${cmd} exited with code ${res.status}`)
    return false
  }
  return true
}

function restart () {
  const entry = join(root, '.output', 'server', 'index.mjs')
  if (!existsSync(entry)) {
    console.log('\n.output/server/index.mjs is missing - start the server by hand')
    return
  }
  console.log('\nRestarting Pazuzu...')
  // inherit keeps the server's console output in the same update.log; env
  // (NITRO_HOST/NITRO_PORT, PAZUZU_CONFIG, ...) carries over from the old one
  const child = spawn(process.execPath, [entry], {
    cwd: root, detached: true, stdio: 'inherit', windowsHide: true, env: process.env
  })
  child.unref()
}

function finish (ok, step, error) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'last-update.json'), JSON.stringify({
    startedAt, finishedAt: Date.now(), ok, step: step ?? null, error: error ?? null
  }, null, 2) + '\n')
  console.log(ok ? '\nUpdate applied successfully.' : `\nUpdate failed${step ? ` during "${step}"` : ''} - the old build keeps running`)
}

let failedStep = null
let errorMessage = null
try {
  await waitForExit(parentPid)
  if (!run('git', ['pull', '--ff-only'])) failedStep = 'git pull'
  else if (!run('npm', ['install', '--omit=dev'])) failedStep = 'npm install'
  else if (!run('npm', ['run', 'build'])) failedStep = 'npm run build'
} catch (err) {
  failedStep = failedStep ?? 'unexpected error'
  errorMessage = String(err?.stack ?? err)
  console.log(`! ${errorMessage}`)
} finally {
  restart()
  finish(failedStep === null, failedStep, errorMessage)
}
process.exitCode = failedStep ? 1 : 0
