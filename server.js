const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const DAY = 24 * 60 * 60 * 1000;
const UNITS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: DAY };
const MIN_MS = 60 * 1000;   // 1 minute
const MAX_MS = 7 * DAY;     // 1 week

// { amount, unit } -> milliseconds, or null if invalid / outside 1 minute - 7 days
function parseDuration(d) {
  const unit = UNITS[d && d.unit];
  const amount = Number(d && d.amount);
  if (!unit || !Number.isFinite(amount)) return null;
  const ms = Math.round(amount * unit);
  return ms >= MIN_MS && ms <= MAX_MS ? ms : null;
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I
// pass -> { name, expiresAt, timerVisibility: 'all'|'admin', adminKey, messages: [] }
const rooms = new Map();

function makePass() {
  let pass;
  do {
    const raw = [...crypto.randomBytes(8)].map(b => ALPHABET[b % 32]).join('');
    pass = raw.slice(0, 4) + '-' + raw.slice(4);
  } while (rooms.has(pass));
  return pass;
}

const normalize = p => String(p || '').trim().toUpperCase();
const clean = (s, max) => String(s || '').trim().slice(0, max);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function getLiveRoom(pass) {
  const room = rooms.get(pass);
  if (!room) return null;
  if (Date.now() >= room.expiresAt) { closeRoom(pass); return null; }
  return room;
}

function closeRoom(pass) {
  io.to(pass).emit('expired');
  io.in(pass).disconnectSockets(true);
  rooms.delete(pass);
}

// Expiry is only revealed to members when the admin allows it
function statePayload(room, isAdmin) {
  const show = isAdmin || room.timerVisibility === 'all';
  return { timerVisibility: room.timerVisibility, expiresAt: show ? room.expiresAt : null };
}

function pushState(pass, room) {
  io.to(pass + '#admin').emit('state', statePayload(room, true));
  io.to(pass).except(pass + '#admin').emit('state', statePayload(room, false));
}

// Admin creates a room + pass
app.post('/api/rooms', (req, res) => {
  const duration = parseDuration(req.body.duration);
  if (!duration) return res.status(400).json({ error: 'Validity must be between 1 minute and 7 days.' });
  const pass = makePass();
  const room = {
    name: clean(req.body.name, 40) || 'Private chat',
    expiresAt: Date.now() + duration,
    timerVisibility: req.body.timerVisibility === 'admin' ? 'admin' : 'all',
    adminKey: crypto.randomBytes(16).toString('hex'),
    messages: [],
  };
  rooms.set(pass, room);
  res.json({ pass, name: room.name, expiresAt: room.expiresAt, adminKey: room.adminKey });
});

io.on('connection', socket => {
  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    const pass = normalize(data && data.pass);
    const name = clean(data && data.name, 24);
    if (!name) return ack({ ok: false, error: 'Enter your name.' });
    const room = getLiveRoom(pass);
    if (!room) return ack({ ok: false, error: 'Invalid or expired pass.' });

    const isAdmin = safeEq(data.adminKey, room.adminKey);
    socket.join(pass);
    if (isAdmin) socket.join(pass + '#admin');
    socket.data = { pass, name, isAdmin };
    socket.to(pass).emit('system', `${name} joined`);
    ack({
      ok: true, roomName: room.name, isAdmin, history: room.messages,
      pass: isAdmin ? pass : undefined,
      ...statePayload(room, isAdmin),
    });
  });

  socket.on('message', text => {
    const { pass, name } = socket.data || {};
    const room = pass && getLiveRoom(pass);
    const body = clean(text, 1000);
    if (!room || !body) return;
    const msg = { name, text: body, ts: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    io.to(pass).emit('message', msg);
  });

  // Admin: set a new validity, counted from now
  socket.on('setValidity', (duration, ack) => {
    const { pass, isAdmin } = socket.data || {};
    const room = isAdmin && getLiveRoom(pass);
    const ms = parseDuration(duration);
    if (!room || !ms) return typeof ack === 'function' && ack({ ok: false });
    room.expiresAt = Date.now() + ms;
    pushState(pass, room);
    io.to(pass).emit('system', 'Admin changed the pass validity');
    if (typeof ack === 'function') ack({ ok: true });
  });

  // Admin: choose who can see the countdown
  socket.on('setTimerVisibility', (value, ack) => {
    const { pass, isAdmin } = socket.data || {};
    const room = isAdmin && getLiveRoom(pass);
    if (!room) return typeof ack === 'function' && ack({ ok: false });
    room.timerVisibility = value === 'admin' ? 'admin' : 'all';
    pushState(pass, room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const { pass, name } = socket.data || {};
    if (pass && rooms.has(pass)) socket.to(pass).emit('system', `${name} left`);
  });
});

setInterval(() => {
  for (const pass of [...rooms.keys()]) getLiveRoom(pass);
}, 30 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat running on http://localhost:${PORT}`));
