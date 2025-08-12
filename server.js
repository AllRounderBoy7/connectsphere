// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TEAMS_FILE = path.join(__dirname, 'teams.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Load or initialize permanent team codes
let teams = {};
try {
  if (fs.existsSync(TEAMS_FILE)) {
    const raw = fs.readFileSync(TEAMS_FILE, 'utf8');
    teams = raw ? JSON.parse(raw) : {};
  } else {
    fs.writeFileSync(TEAMS_FILE, JSON.stringify(teams, null, 2));
  }
} catch (err) {
  console.error('Failed to read or create teams file', err);
  teams = {};
}

// In-memory runtime state: messages per room and user counts
const roomMessages = {}; // { teamCode: [ {id, name, text, ts} ] }
const roomUserCounts = {}; // { teamCode: number }

function saveTeamsToDisk() {
  try {
    fs.writeFileSync(TEAMS_FILE, JSON.stringify(teams, null, 2));
  } catch (err) {
    console.error('Failed to save teams file', err);
  }
}

function makeTeamCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid ambiguous chars
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/create-team', (req, res) => {
  let { customCode } = req.body || {};
  if (customCode) customCode = String(customCode).trim().toUpperCase();

  let code = customCode || makeTeamCode(6);
  if (customCode && teams[customCode]) {
    return res.status(409).json({ error: 'Code already exists' });
  }
  while (!customCode && teams[code]) code = makeTeamCode(6);

  teams[code] = { createdAt: new Date().toISOString() };
  saveTeamsToDisk();

  return res.json({ teamCode: code });
});

app.get('/teams', (req, res) => {
  res.json(teams);
});

// Admin page (simple)
app.get('/admin', (req, res) => {
  // serve the admin html file
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ teamCode, name }, ack) => {
    if (!teamCode || !name) {
      if (ack) ack({ ok: false, error: 'Missing teamCode or name' });
      return;
    }
    teamCode = String(teamCode).trim().toUpperCase();
    name = String(name).trim().slice(0, 50);

    if (!teams[teamCode]) {
      if (ack) ack({ ok: false, error: 'Team code not found' });
      return;
    }

    socket.join(teamCode);
    socket.teamCode = teamCode;
    socket.userName = name;

    roomUserCounts[teamCode] = (roomUserCounts[teamCode] || 0) + 1;
    roomMessages[teamCode] = roomMessages[teamCode] || [];

    // send current messages
    socket.emit('room-history', roomMessages[teamCode]);

    const joinNotice = {
      id: 'sys-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      system: true,
      text: `${name} joined the chat`,
      ts: new Date().toISOString(),
    };
    roomMessages[teamCode].push(joinNotice);
    io.to(teamCode).emit('message', joinNotice);

    if (ack) ack({ ok: true });
  });

  socket.on('send-message', (payload, ack) => {
    const teamCode = socket.teamCode;
    const name = socket.userName;
    if (!teamCode || !name) {
      if (ack) ack({ ok: false, error: 'You are not in a room' });
      return;
    }
    const text = String(payload && payload.text || '').trim();
    if (!text) {
      if (ack) ack({ ok: false, error: 'Empty message' });
      return;
    }
    const msg = {
      id: 'm-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      name,
      text,
      ts: new Date().toISOString(),
    };
    roomMessages[teamCode] = roomMessages[teamCode] || [];
    roomMessages[teamCode].push(msg);

    io.to(teamCode).emit('message', msg);
    if (ack) ack({ ok: true });
  });

  // delete message (server-side delete)
  socket.on('delete-message', ({ id }, ack) => {
    const teamCode = socket.teamCode;
    if (!teamCode) {
      if (ack) ack({ ok:false, error: 'Not in room' });
      return;
    }
    if (!id) {
      if (ack) ack({ ok:false, error: 'No id' });
      return;
    }
    const arr = roomMessages[teamCode] = roomMessages[teamCode] || [];
    const idx = arr.findIndex(m => m.id === id);
    if (idx === -1) {
      if (ack) ack({ ok:false, error: 'Message not found' });
      return;
    }
    const [removed] = arr.splice(idx, 1);
    io.to(teamCode).emit('delete-message', { id });
    if (ack) ack({ ok:true });
  });

  socket.on('disconnect', () => {
    const teamCode = socket.teamCode;
    const name = socket.userName;
    if (!teamCode) return;

    roomUserCounts[teamCode] = Math.max(0, (roomUserCounts[teamCode] || 1) - 1);

    const leaveNotice = {
      id: 'sys-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      system: true,
      text: `${name || 'A user'} left the chat`,
      ts: new Date().toISOString(),
    };

    if (roomUserCounts[teamCode] > 0) {
      roomMessages[teamCode] = roomMessages[teamCode] || [];
      roomMessages[teamCode].push(leaveNotice);
      io.to(teamCode).emit('message', leaveNotice);
    } else {
      // clear messages only, keep team code
      delete roomMessages[teamCode];
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Permanent teams stored in ${TEAMS_FILE}`);
});