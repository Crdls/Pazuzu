import { cookieValue, verifySessionToken, SESSION_COOKIE } from '../utils/auth'
import { loadConfig } from '../utils/config'
import { runtime } from '../utils/runtime'

// ws://<host>/_ws - server pushes snapshots, client is read-only.
// WS upgrades bypass server middleware, so the session cookie is checked here.
// Nitro 2.x has no publisher API (`useWebSocket` is undefined), so connected
// peers register on runtime().wsPeers and scrape.broadcast() sends to them.
export default defineWebSocketHandler({
  open (peer) {
    if (loadConfig().auth.enabled) {
      const cookie = peer.request?.headers?.get('cookie') ?? null
      if (!verifySessionToken(cookieValue(cookie, SESSION_COOKIE))) {
        peer.close(4401, 'unauthorized')
        return
      }
    }
    runtime().wsPeers.add(peer)
    for (const snapshot of runtime().snapshots.values()) {
      peer.send({ type: 'snapshot', snapshot })
    }
  },
  close (peer) {
    runtime().wsPeers.delete(peer)
  }
})
