// Recovery tool for a lost password (no email involved - run it on the server).
// From the project root, while the Pazuzu server may keep running:
//
//   node scripts/reset-password.mjs --list
//   node scripts/reset-password.mjs <username or id> [new password]
//
// Requires Node >= 22.22 / 24.15 (imports the server TypeScript helpers
// directly, same as the tests). The user's sessions are signed out.
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { hashPassword } from '../server/utils/credentials.ts'
import { countUsers, deleteUserSessions, getUserById, getUserByUsername, updatePassword, useDb } from '../server/utils/db.ts'

const USAGE = 'usage: node scripts/reset-password.mjs --list | <username or id> [new password]'

function listUsers () {
  const users = useDb().prepare('SELECT id, username, created_at, last_login FROM users ORDER BY id').all()
  if (users.length === 0) console.log('no users yet')
  for (const u of users) {
    const created = new Date(u.created_at).toISOString()
    const last = u.last_login ? new Date(u.last_login).toISOString() : 'never'
    console.log(`${String(u.id).padStart(3)}  ${u.username.padEnd(32)} created ${created}  last login ${last}`)
  }
}

async function main () {
  const [arg1, arg2] = process.argv.slice(2)
  if (arg1 === '--help' || arg1 === '-h') {
    console.log(USAGE)
    return
  }

  // opens the same DB file as the running server (WAL allows concurrent access)
  // and makes sure the schema exists even on a database from before auth was added
  useDb()

  if (!arg1 || arg1 === '--list') {
    listUsers()
    return
  }

  const user = /^\d+$/.test(arg1) ? getUserById(Number(arg1)) : getUserByUsername(arg1)
  if (!user) {
    console.error(`no user "${arg1}" (by name or id)\n`)
    listUsers()
    process.exitCode = 1
    return
  }

  let password = arg2
  if (!password) {
    const rl = createInterface({ input: stdin, output: stdout })
    password = await rl.question(`new password for "${user.username}": `)
    rl.close()
  }
  if (password.length < 8) {
    console.error('password must be at least 8 characters')
    process.exitCode = 1
    return
  }

  updatePassword(user.id, await hashPassword(password))
  deleteUserSessions(user.id)
  console.log(`password updated for "${user.username}" (${countUsers()} user(s) in total); all their sessions were signed out`)
}

await main()
