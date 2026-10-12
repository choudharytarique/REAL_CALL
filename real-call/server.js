/**
 * Real Call server
 *  - Static files
 *  - /api/ai  → Ollama (AI Voice characters only)
 *  - WebSocket /ws → real-time 1v1 matchmaking + WebRTC signaling (humans only, audio)
 *
 *   npm install
 *   node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch {
  console.error('\n  Missing dependency. Run:  npm install\n');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const ROOT = __dirname;

const WAIT_TIMEOUT_MS = 5 * 60 * 1000;   // drop from queue after 5 min
const ROOM_TTL_MS = 30 * 60 * 1000;      // force-end idle rooms after 30 min
const HEARTBEAT_MS = 25000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function send(res, code, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type || (typeof body === 'string' ? 'text/plain' : 'application/json'),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(data);
}

/* ---------- Ollama (AI Voice only) ---------- */
function systemPrompt(character, level) {
  const name = character?.name || 'English Partner';
  const field = character?.field || 'General';
  const sub = character?.sub || '';
  const lvl = level || 'B2';
  const n = name.toLowerCase();
  let voice = '';

  if (/salman khan/.test(n)) {
    voice = 'You are Salman Khan — energetic Bollywood superstar. Speak with confidence. Keep most sentences in clear English. Encourage the learner like a big brother.';
  } else if (/shah rukh|shahrukh/.test(n)) {
    voice = 'You are Shah Rukh Khan — charming, romantic, witty. Use warm metaphors and gentle humour. Keep English clear.';
  } else if (/tom cruise/.test(n)) {
    voice = 'You are Tom Cruise — intense, positive, action-oriented. Short punchy sentences. Push the learner to practise hard.';
  } else if (/emma watson/.test(n)) {
    voice = 'You are Emma Watson — thoughtful, articulate. Speak precisely and encourage learning.';
  } else if (/leonardo|dicaprio/.test(n)) {
    voice = 'You are Leonardo DiCaprio — passionate about storytelling and the planet. Speak clearly and earnestly.';
  } else if (/deepika|priyanka|scarlett|brad pitt|robert downey/.test(n)) {
    voice = 'You are ' + name + ', a famous actor. Stay in character: confident and engaging. Keep English natural for a learner.';
  } else if (/teacher|tutor|coach/.test(n) || field === 'Teaching') {
    voice = 'You are a supportive English teacher. Correct gently, ask follow-up questions, and keep language at ' + lvl + ' level.';
  } else {
    voice = 'You are ' + name + (sub ? ' (' + sub + ')' : '') + '. Speak as a friendly conversation partner. Keep English clear for a ' + lvl + ' learner. Stay in character.';
  }

  return voice + ' Reply in 1–3 short sentences. Do not write stage directions or labels. Ask one natural follow-up question when it fits.';
}

async function callOllama(messages, system) {
  const body = {
    model: OLLAMA_MODEL,
    stream: false,
    messages: [{ role: 'system', content: system }].concat(messages.slice(-12)),
    options: { temperature: 0.7, num_predict: 120 }
  };
  const r = await fetch(OLLAMA_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
  const j = await r.json();
  return (j.message && j.message.content) ? String(j.message.content).trim() : '';
}

function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://x').pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, function(err, data) {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file).toLowerCase();
    send(res, 200, data, MIME[ext] || 'application/octet-stream');
  });
}

const server = http.createServer(async function(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url, 'http://' + req.headers.host);

  if (req.method === 'POST' && url.pathname === '/api/ai') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { error: 'Invalid JSON' }); }
    const character = payload.character || {};
    const messages = payload.messages || [];
    const level = payload.level || 'B2';
    try {
      const reply = await callOllama(messages, systemPrompt(character, level));
      if (!reply) return send(res, 502, { error: 'Empty reply from model' });
      return send(res, 200, { reply: reply });
    } catch (e) {
      console.error('[ai]', e.message);
      return send(res, 503, {
        error: 'Ollama unavailable',
        hint: 'ollama serve && ollama pull ' + OLLAMA_MODEL,
        detail: e.message
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    let ollama = false;
    try {
      const r = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(1500) });
      ollama = r.ok;
    } catch (e) {}
    return send(res, 200, {
      ok: true,
      ollama: ollama,
      model: OLLAMA_MODEL,
      waiting: waiting.length,
      rooms: rooms.size,
      clients: clients.size
    });
  }

  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, 'Method not allowed', 'text/plain');
});

/* ---------- WebSocket: real 1v1 matchmaking + WebRTC signaling ---------- */
const wss = new WebSocketServer({ server: server, path: '/ws' });

/** @type {{ws: import('ws').WebSocket, id: string, profile: object, topic: string, joinedAt: number}[]} */
const waiting = [];
/** @type {Map<string, {a: string, b: string, createdAt: number}>} */
const rooms = new Map();
/** @type {Map<string, import('ws').WebSocket>} */
const clients = new Map();

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sendWs(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function isOpen(ws) {
  return ws && ws.readyState === 1;
}

function removeWaiting(id) {
  for (let i = waiting.length - 1; i >= 0; i--) {
    if (waiting[i].id === id) waiting.splice(i, 1);
  }
}

function isWaiting(id) {
  return waiting.some(function(w) { return w.id === id; });
}

function endRoom(roomId, reason) {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  [room.a, room.b].forEach(function(cid) {
    const cws = clients.get(cid);
    if (cws) {
      cws._roomId = null;
      sendWs(cws, { type: 'peer-left', reason: reason || 'ended' });
    }
  });
  console.log('[room-end]', roomId.slice(0, 8), reason || 'ended');
}

function pruneQueues() {
  const now = Date.now();
  // Stale waiting entries
  for (let i = waiting.length - 1; i >= 0; i--) {
    const w = waiting[i];
    if (!isOpen(w.ws) || now - w.joinedAt > WAIT_TIMEOUT_MS) {
      waiting.splice(i, 1);
      if (isOpen(w.ws)) sendWs(w.ws, { type: 'search-timeout' });
      console.log('[prune-wait]', w.id.slice(0, 8));
    }
  }
  // Expired rooms
  for (const [rid, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      endRoom(rid, 'timeout');
    }
  }
}

setInterval(pruneQueues, 15000);

wss.on('connection', function(ws) {
  const id = uid();
  clients.set(id, ws);
  ws._roomId = null;
  ws.isAlive = true;
  let profile = { name: 'Learner', init: 'L', level: 'B2' };

  sendWs(ws, { type: 'welcome', id: id });

  ws.on('pong', function() { ws.isAlive = true; });

  ws.on('message', function(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (e) { return; }

    switch (msg.type) {
      case 'hello': {
        profile = {
          name: String(msg.name || 'Learner').slice(0, 24),
          init: String(msg.init || 'L').slice(0, 3),
          level: String(msg.level || 'B2').slice(0, 8)
        };
        break;
      }
      case 'ping': {
        sendWs(ws, { type: 'pong', t: Date.now() });
        break;
      }
      case 'find': {
        // Already in a room — ignore duplicate
        if (ws._roomId) {
          sendWs(ws, { type: 'error', code: 'already-in-call', message: 'Already in a call' });
          break;
        }
        // Already searching — refresh topic / keep position, avoid duplicates
        if (isWaiting(id)) {
          removeWaiting(id);
        }
        const topic = String(msg.topic || 'free').slice(0, 32);

        // Prefer same topic; otherwise any waiting open peer
        let idx = waiting.findIndex(function(w) {
          return w.topic === topic && isOpen(w.ws) && !w.ws._roomId;
        });
        if (idx < 0) {
          idx = waiting.findIndex(function(w) {
            return isOpen(w.ws) && !w.ws._roomId;
          });
        }

        if (idx >= 0) {
          const partner = waiting.splice(idx, 1)[0];
          // Double-check partner still free
          if (partner.ws._roomId || !isOpen(partner.ws)) {
            // Partner taken or gone — put self in queue
            waiting.push({ ws: ws, id: id, profile: profile, topic: topic, joinedAt: Date.now() });
            sendWs(ws, { type: 'searching', queue: waiting.length });
            break;
          }
          const roomId = uid();
          partner.ws._roomId = roomId;
          ws._roomId = roomId;
          rooms.set(roomId, { a: partner.id, b: id, createdAt: Date.now() });
          sendWs(partner.ws, {
            type: 'matched',
            roomId: roomId,
            role: 'offerer',
            peer: profile
          });
          sendWs(ws, {
            type: 'matched',
            roomId: roomId,
            role: 'answerer',
            peer: partner.profile
          });
          console.log('[match] ' + partner.profile.name + ' ↔ ' + profile.name + ' (' + topic + ') room=' + roomId.slice(0, 8));
        } else {
          waiting.push({ ws: ws, id: id, profile: profile, topic: topic, joinedAt: Date.now() });
          sendWs(ws, { type: 'searching', queue: waiting.length });
        }
        break;
      }
      case 'cancel-find': {
        removeWaiting(id);
        sendWs(ws, { type: 'cancelled' });
        break;
      }
      case 'signal': {
        const rid = msg.roomId || ws._roomId;
        const room = rooms.get(rid);
        if (!room) break;
        const otherId = room.a === id ? room.b : room.a;
        const other = clients.get(otherId);
        if (other) sendWs(other, { type: 'signal', data: msg.data });
        break;
      }
      case 'chat': {
        const rid = msg.roomId || ws._roomId;
        const room = rooms.get(rid);
        if (!room) break;
        const otherId = room.a === id ? room.b : room.a;
        const other = clients.get(otherId);
        if (other) sendWs(other, { type: 'chat', text: String(msg.text || '').slice(0, 500), from: profile.name });
        break;
      }
      case 'leave': {
        removeWaiting(id);
        if (ws._roomId) {
          endRoom(ws._roomId, 'left');
          ws._roomId = null;
        }
        break;
      }
    }
  });

  ws.on('close', function() {
    removeWaiting(id);
    clients.delete(id);
    if (ws._roomId) {
      endRoom(ws._roomId, 'disconnected');
      ws._roomId = null;
    }
  });

  ws.on('error', function() {
    // close handler will clean up
  });
});

/* Heartbeat: terminate dead sockets so queue stays clean */
const heartbeat = setInterval(function() {
  wss.clients.forEach(function(ws) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, HEARTBEAT_MS);

wss.on('close', function() {
  clearInterval(heartbeat);
});

server.listen(PORT, function() {
  console.log('\n  Real Call →  http://localhost:' + PORT);
  console.log('  WebSocket →  ws://localhost:' + PORT + '/ws   (real 1v1 humans, audio only)');
  console.log('  Ollama    →  ' + OLLAMA_URL + '  (' + OLLAMA_MODEL + ')');
  console.log('  Health    →  http://localhost:' + PORT + '/api/health\n');
});
