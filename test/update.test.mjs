// Smoke test for the pure update helpers (ls-remote parsing, remote URL
// normalization, compare links). Run: node test/update.test.mjs
import {
  compareUrl, isSha, parseLsRemote, parseRemoteUrl, shortSha, updateAvailable
} from '../server/utils/update.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

const SHA_A = '0123456789abcdef0123456789abcdef01234567'
const SHA_B = '9876543210fedcba9876543210fedcba98765432'

check('isSha accepts a full lowercase sha', isSha(SHA_A))
check('isSha rejects short/uppercase/null', !isSha(SHA_A.slice(0, 7)) && !isSha(SHA_A.toUpperCase()) && !isSha(null) && !isSha(undefined))
check('shortSha keeps 7 chars', shortSha(SHA_A) === SHA_A.slice(0, 7))
check('shortSha of garbage is empty', shortSha(null) === '' && shortSha('main') === '')

check('parseLsRemote finds the branch head', parseLsRemote(`${SHA_A}\trefs/heads/master\n`, 'master') === SHA_A)
check('parseLsRemote survives CRLF', parseLsRemote(`${SHA_A}\trefs/heads/main\r\n`, 'main') === SHA_A)
check('parseLsRemote skips other refs', parseLsRemote(`${SHA_A}\trefs/heads/dev\n${SHA_B}\trefs/tags/v1\n`, 'master') === null)
check('parseLsRemote picks the right line', parseLsRemote(`${SHA_B}\trefs/heads/dev\n${SHA_A}\trefs/heads/master\n`, 'master') === SHA_A)
check('parseLsRemote tolerates empty/garbage output', parseLsRemote('', 'master') === null && parseLsRemote('fatal: not a thing\n', 'master') === null)
check('parseLsRemote rejects a malformed sha', parseLsRemote(`xyz\trefs/heads/master\n`, 'master') === null)

check('different shas mean an update is available', updateAvailable(SHA_A, SHA_B))
check('equal shas are up to date', !updateAvailable(SHA_A, SHA_A))
check('unknown versions are never "available"', !updateAvailable(null, SHA_B) && !updateAvailable(SHA_A, null) && !updateAvailable(null, null))

check('https remote normalized', parseRemoteUrl('https://github.com/Crdls/Pazuzu.git') === 'https://github.com/Crdls/Pazuzu')
check('https remote without .git', parseRemoteUrl('https://github.com/Crdls/Pazuzu') === 'https://github.com/Crdls/Pazuzu')
check('ssh scp remote normalized', parseRemoteUrl('git@github.com:Crdls/Pazuzu.git') === 'https://github.com/Crdls/Pazuzu')
check('ssh/git scheme remotes normalized', parseRemoteUrl('ssh://git@github.com/Crdls/Pazuzu.git') === 'https://github.com/Crdls/Pazuzu' && parseRemoteUrl('git://github.com/Crdls/Pazuzu') === 'https://github.com/Crdls/Pazuzu')
check('non-GitHub remotes get no project page', parseRemoteUrl('https://gitlab.com/Crdls/Pazuzu.git') === null && parseRemoteUrl('') === null && parseRemoteUrl(null) === null)
check('remote with extra path segments rejected', parseRemoteUrl('https://github.com/Crdls/Pazuzu/deep/path') === null)

check('compare link spans the two commits', compareUrl('https://github.com/Crdls/Pazuzu', SHA_A, SHA_B) === `https://github.com/Crdls/Pazuzu/compare/${SHA_A}...${SHA_B}`)
check('no compare link when equal/unknown', compareUrl('https://github.com/Crdls/Pazuzu', SHA_A, SHA_A) === null && compareUrl('https://github.com/Crdls/Pazuzu', null, SHA_B) === null && compareUrl(null, SHA_A, SHA_B) === null)

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exitCode = failed > 0 ? 1 : 0
