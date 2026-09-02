// Multiplayer room: one Durable Object per room name, WebSocket per player, JSON snapshot broadcast at 8 Hz.
// ponytail: JSON, not the 24-byte binary format. Switch when a room passes ~100 players.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/room/')) return new Response('nyc multiplayer up', { headers: { 'Access-Control-Allow-Origin': '*' } });
    const id = env.ROOM.idFromName(url.pathname.slice(6) || 'nyc');
    return env.ROOM.get(id).fetch(req);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.players = new Map(); // id -> last state
    this.sockets = new Map(); // id -> WebSocket
    this.timer = null;
  }
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const id = crypto.randomUUID().slice(0, 8);
    this.sockets.set(id, server);
    const drop = () => { this.sockets.delete(id); this.players.delete(id); };
    server.addEventListener('message', ev => {
      if (typeof ev.data !== 'string' || ev.data.length > 400) return;
      try {
        const m = JSON.parse(ev.data);
        if (m.t === 'pos' && Array.isArray(m.e) && m.e.length === 3 && m.e.every(Number.isFinite) && ['walk', 'drive', 'glide'].includes(m.mode)) {
          this.players.set(id, { id, e: m.e, yaw: +m.yaw || 0, mode: m.mode, speed: +m.speed || 0, t: Date.now() });
        }
      } catch {}
    });
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    server.send(JSON.stringify({ t: 'hello', id }));
    if (!this.timer) this.timer = setInterval(() => this.tick(), 125);
    return new Response(null, { status: 101, webSocket: client });
  }
  tick() {
    const now = Date.now();
    for (const [id, p] of this.players) if (now - p.t > 10000) this.players.delete(id);
    if (!this.sockets.size) { clearInterval(this.timer); this.timer = null; return; }
    const msg = JSON.stringify({ t: 'state', players: [...this.players.values()] });
    for (const [id, s] of this.sockets) { try { s.send(msg); } catch { this.sockets.delete(id); this.players.delete(id); } }
  }
}
