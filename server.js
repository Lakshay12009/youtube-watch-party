/**
 * ============================================================================
 *  YOUTUBE WATCH PARTY - SINGLE FILE APP
 * ============================================================================
 *  Everything lives here on purpose: the Express server, the Socket.IO
 *  real-time logic, the role-based access control, AND the frontend
 *  (HTML/CSS/JS) that gets served to the browser. Nothing else to open.
 *
 *  Run it:      npm install
 *               npm start
 *  Then open:   http://localhost:4000
 *
 *  File map (all in this one file, top to bottom):
 *   1. Dependencies + config
 *   2. Roles & permissions            (RBAC rules)
 *   3. Participant / Room / RoomManager classes   (OOP backend model)
 *   4. Socket.IO event wiring         (the "API" between browser <-> server)
 *   5. HTML_PAGE                      (the entire frontend, as one string)
 *   6. Express routes + server start
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1. DEPENDENCIES + CONFIG
// ---------------------------------------------------------------------------
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
// In production, set this to your exact deployed URL (e.g. https://your-app.onrender.com).
// "*" is fine for local dev and for a single-service deploy where frontend + backend
// are served from the SAME origin (which is exactly what this single file does).
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] } });

// ---------------------------------------------------------------------------
// 2. ROLES & PERMISSIONS  (server is the only source of truth for this)
// ---------------------------------------------------------------------------
const ROLES = { HOST: 'host', MODERATOR: 'moderator', PARTICIPANT: 'participant' };

const PLAYBACK_EVENTS = new Set(['play', 'pause', 'seek', 'change_video']); // host + moderator
const HOST_ONLY_EVENTS = new Set(['assign_role', 'remove_participant', 'transfer_host']); // host only

function canPerform(role, eventName) {
  if (HOST_ONLY_EVENTS.has(eventName)) return role === ROLES.HOST;
  if (PLAYBACK_EVENTS.has(eventName)) return role === ROLES.HOST || role === ROLES.MODERATOR;
  return true; // join_room, leave_room, chat_message, etc. are open to everyone
}

// ---------------------------------------------------------------------------
// 3. PARTICIPANT / ROOM / ROOMMANAGER  (OOP model)
// ---------------------------------------------------------------------------
class Participant {
  constructor({ socketId, userId, username, role = ROLES.PARTICIPANT }) {
    this.socketId = socketId;
    this.userId = userId;
    this.username = username;
    this.role = role;
    this.joinedAt = Date.now();
  }
  setRole(role) { this.role = role; }
  toJSON() { return { userId: this.userId, username: this.username, role: this.role }; }
}

class Room {
  constructor({ roomId, io, hostUserId }) {
    this.roomId = roomId;
    this.io = io;
    this.hostUserId = hostUserId;
    this.participants = new Map(); // userId -> Participant
    this.state = { videoId: null, playState: 'paused', currentTime: 0, lastUpdatedAt: Date.now() };
    this.chatHistory = [];
    this.createdAt = Date.now();
  }
  addParticipant(p) { this.participants.set(p.userId, p); }
  removeParticipant(userId) { this.participants.delete(userId); }
  getParticipant(userId) { return this.participants.get(userId); }
  isEmpty() { return this.participants.size === 0; }
  listParticipants() { return Array.from(this.participants.values()).map((p) => p.toJSON()); }

  transferHost(newHostUserId) {
    const current = this.getParticipant(this.hostUserId);
    const next = this.getParticipant(newHostUserId);
    if (!next) return false;
    if (current) current.setRole(ROLES.PARTICIPANT);
    next.setRole(ROLES.HOST);
    this.hostUserId = newHostUserId;
    return true;
  }

  updatePlayback({ playState, currentTime, videoId }) {
    if (playState !== undefined) this.state.playState = playState;
    if (currentTime !== undefined) this.state.currentTime = currentTime;
    if (videoId !== undefined) this.state.videoId = videoId;
    this.state.lastUpdatedAt = Date.now();
  }

  broadcast(event, payload, opts) {
    if (opts && opts.excludeSocketId) this.io.to(this.roomId).except(opts.excludeSocketId).emit(event, payload);
    else this.io.to(this.roomId).emit(event, payload);
  }
  broadcastSyncState() { this.broadcast('sync_state', Object.assign({}, this.state, { participants: this.listParticipants() })); }
  addChatMessage(msg) { this.chatHistory.push(msg); if (this.chatHistory.length > 200) this.chatHistory.shift(); }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> Room
  }
  generateRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code;
  }
  createRoom(hostUserId) {
    let roomId = this.generateRoomCode();
    while (this.rooms.has(roomId)) roomId = this.generateRoomCode();
    const room = new Room({ roomId, io: this.io, hostUserId });
    this.rooms.set(roomId, room);
    return room;
  }
  getRoom(roomId) { return this.rooms.get(roomId); }
  deleteRoomIfEmpty(roomId) {
    const room = this.rooms.get(roomId);
    if (room && room.isEmpty()) { this.rooms.delete(roomId); return true; }
    return false;
  }
  stats() {
    let totalParticipants = 0;
    this.rooms.forEach((r) => { totalParticipants += r.participants.size; });
    return { totalRooms: this.rooms.size, totalParticipants };
  }
}

const roomManager = new RoomManager(io);

// ---------------------------------------------------------------------------
// 4. SOCKET.IO EVENT WIRING
//    Every socket gets its own little handler object. This is where role
//    checks happen BEFORE any state is changed - this is what satisfies
//    "backend must validate permissions before processing events."
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  let roomId = null;
  let userId = null;

  function getRoom() { return roomId ? roomManager.getRoom(roomId) : null; }
  function getSelf(room) { return room ? room.getParticipant(userId) : null; }
  function emitError(message) { socket.emit('error_message', { message: message }); }

  socket.on('create_room', (payload, ack) => {
    const username = payload && payload.username;
    const uid = payload && payload.userId;
    if (!username || !uid) return ack && ack({ ok: false, error: 'username and userId required' });

    const room = roomManager.createRoom(uid);
    const host = new Participant({ socketId: socket.id, userId: uid, username: username, role: ROLES.HOST });
    room.addParticipant(host);

    socket.join(room.roomId);
    roomId = room.roomId;
    userId = uid;

    ack && ack({ ok: true, roomId: room.roomId, role: ROLES.HOST, state: room.state, participants: room.listParticipants() });
  });

  socket.on('join_room', (payload, ack) => {
    const rId = payload && payload.roomId;
    const username = payload && payload.username;
    const uid = payload && payload.userId;
    const room = roomManager.getRoom(rId);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    if (!username || !uid) return ack && ack({ ok: false, error: 'username and userId required' });

    const existing = room.getParticipant(uid);
    const role = existing ? existing.role : ROLES.PARTICIPANT;
    const participant = new Participant({ socketId: socket.id, userId: uid, username: username, role: role });
    room.addParticipant(participant);

    socket.join(room.roomId);
    roomId = room.roomId;
    userId = uid;

    ack && ack({ ok: true, roomId: room.roomId, role: role, state: room.state, participants: room.listParticipants(), chatHistory: room.chatHistory });

    room.broadcast('user_joined', { username: username, userId: uid, role: role, participants: room.listParticipants() }, { excludeSocketId: socket.id });
    socket.emit('sync_state', Object.assign({}, room.state, { participants: room.listParticipants() }));
  });

  function handleLeaveRoom() {
    const room = getRoom();
    if (!room) return;
    const self = getSelf(room);
    if (!self) return;

    room.removeParticipant(userId);
    socket.leave(roomId);

    if (self.role === ROLES.HOST && !room.isEmpty()) {
      const remaining = Array.from(room.participants.values()).sort((a, b) => a.joinedAt - b.joinedAt);
      if (remaining[0]) room.transferHost(remaining[0].userId);
    }

    room.broadcast('user_left', { username: self.username, userId: self.userId, participants: room.listParticipants() });
    roomManager.deleteRoomIfEmpty(roomId);
    roomId = null;
    userId = null;
  }
  socket.on('leave_room', handleLeaveRoom);
  socket.on('disconnect', handleLeaveRoom);

  function guardedPlaybackUpdate(eventName, statePatch) {
    const room = getRoom();
    const self = getSelf(room);
    if (!room || !self) return emitError('Not in a room');
    if (!canPerform(self.role, eventName)) return emitError('Your role (' + self.role + ') is not allowed to ' + eventName);
    room.updatePlayback(statePatch);
    room.broadcastSyncState();
  }
  socket.on('play', () => guardedPlaybackUpdate('play', { playState: 'playing' }));
  socket.on('pause', (payload) => guardedPlaybackUpdate('pause', { playState: 'paused', currentTime: payload && payload.currentTime }));
  socket.on('seek', (payload) => guardedPlaybackUpdate('seek', { currentTime: payload && payload.time }));
  socket.on('change_video', (payload) => guardedPlaybackUpdate('change_video', { videoId: payload && payload.videoId, currentTime: 0, playState: 'paused' }));

  socket.on('assign_role', (payload) => {
    const room = getRoom();
    const self = getSelf(room);
    if (!room || !self) return emitError('Not in a room');
    if (!canPerform(self.role, 'assign_role')) return emitError('Only the Host can assign roles');
    const targetUserId = payload && payload.userId;
    const role = payload && payload.role;
    if (Object.values(ROLES).indexOf(role) === -1) return emitError('Invalid role');
    if (targetUserId === room.hostUserId) return emitError('Cannot change the Host role this way');
    const target = room.getParticipant(targetUserId);
    if (!target) return emitError('Participant not found');
    target.setRole(role);
    room.broadcast('role_assigned', { userId: targetUserId, username: target.username, role: role, participants: room.listParticipants() });
  });

  socket.on('remove_participant', (payload) => {
    const room = getRoom();
    const self = getSelf(room);
    if (!room || !self) return emitError('Not in a room');
    if (!canPerform(self.role, 'remove_participant')) return emitError('Only the Host can remove participants');
    const targetUserId = payload && payload.userId;
    if (targetUserId === room.hostUserId) return emitError('Host cannot remove themselves');
    const target = room.getParticipant(targetUserId);
    if (!target) return emitError('Participant not found');
    room.removeParticipant(targetUserId);
    room.broadcast('participant_removed', { userId: targetUserId, participants: room.listParticipants() });
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) { targetSocket.emit('you_were_removed', { roomId: roomId }); targetSocket.leave(roomId); }
  });

  socket.on('transfer_host', (payload) => {
    const room = getRoom();
    const self = getSelf(room);
    if (!room || !self) return emitError('Not in a room');
    if (!canPerform(self.role, 'transfer_host')) return emitError('Only the Host can transfer host');
    const targetUserId = payload && payload.userId;
    const ok = room.transferHost(targetUserId);
    if (!ok) return emitError('Target participant not found');
    room.broadcast('role_assigned', { userId: targetUserId, role: ROLES.HOST, participants: room.listParticipants() });
  });

  socket.on('chat_message', (payload) => {
    const room = getRoom();
    const self = getSelf(room);
    const text = payload && payload.text && payload.text.trim();
    if (!room || !self || !text) return;
    const message = { userId: self.userId, username: self.username, text: text, at: Date.now() };
    room.addChatMessage(message);
    room.broadcast('chat_message', message);
  });
});

// ---------------------------------------------------------------------------
// 5. HTML_PAGE - the entire frontend, served as one page.
//    Plain HTML/CSS/JS (no build step, no React) so there is nothing to
//    compile - the browser runs this exactly as written.
// ---------------------------------------------------------------------------
const HTML_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Watch Party</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #eaeaf0; }
  .page { min-height: 100vh; padding: 24px; }
  .center { display: flex; align-items: center; justify-content: center; }
  .card { background: #1a1d29; border-radius: 16px; padding: 32px; width: 100%; max-width: 420px; box-shadow: 0 10px 40px rgba(0,0,0,0.4); }
  .card h1 { margin-top: 0; font-size: 28px; }
  .subtitle { color: #9a9db0; margin-bottom: 24px; }
  .field { display: block; margin-bottom: 16px; }
  .field span { display: block; font-size: 13px; color: #9a9db0; margin-bottom: 6px; }
  .field input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2e3244; background: #10121b; color: #eaeaf0; font-size: 15px; }
  .btn { padding: 10px 16px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; background: #2e3244; color: #eaeaf0; font-size: 14px; }
  .btn:hover { filter: brightness(1.15); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: #635bff; color: white; width: 100%; margin-bottom: 8px; }
  .btn.secondary { background: #2e3244; width: 100%; }
  .btn.danger { background: #ff4d4f; color: white; }
  .btn.tiny { padding: 4px 8px; font-size: 12px; }
  .divider { text-align: center; color: #6b6e80; font-size: 13px; margin: 20px 0; }
  .error { color: #ff6b6b; margin-top: 12px; font-size: 14px; }
  .room-page { max-width: 1200px; margin: 0 auto; }
  .room-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
  .room-header-actions { display: flex; gap: 8px; }
  .role-badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .role-host { background: #ffb020; color: #241a00; }
  .role-moderator { background: #4dd0e1; color: #002326; }
  .role-participant { background: #3a3d4d; color: #cfd1de; }
  .toast { background: #2e3244; padding: 8px 16px; border-radius: 8px; margin-bottom: 12px; font-size: 14px; }
  .room-layout { display: grid; grid-template-columns: 1fr 320px; gap: 20px; }
  @media (max-width: 900px) { .room-layout { grid-template-columns: 1fr; } }
  .player-wrapper { position: relative; width: 100%; padding-top: 56.25%; background: black; border-radius: 12px; overflow: hidden; }
  .player-wrapper > div, .player-wrapper iframe { position: absolute; inset: 0; width: 100%; height: 100%; }
  .controls { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .controls .seek-input { width: 120px; padding: 8px; border-radius: 8px; border: 1px solid #2e3244; background: #10121b; color: #eaeaf0; }
  .controls .video-input { flex: 1; min-width: 200px; padding: 8px; border-radius: 8px; border: 1px solid #2e3244; background: #10121b; color: #eaeaf0; }
  .hint { color: #9a9db0; font-size: 13px; margin-top: 12px; }
  .side-col { display: flex; flex-direction: column; gap: 16px; }
  .panel { background: #1a1d29; border-radius: 12px; padding: 16px; }
  .panel h3 { margin: 0 0 12px 0; font-size: 15px; }
  .participant-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .participant-row { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid #2a2e3f; }
  .participant-row:last-child { border-bottom: none; }
  .host-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .chat-panel { display: flex; flex-direction: column; height: 320px; }
  .chat-messages { flex: 1; overflow-y: auto; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
  .chat-msg { font-size: 13px; background: #10121b; padding: 6px 10px; border-radius: 8px; }
  .chat-msg.mine { background: #26264a; align-self: flex-end; }
  .chat-author { font-weight: 700; margin-right: 6px; color: #9a9db0; }
  .chat-input-row { display: flex; gap: 6px; }
  .chat-input-row input { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #2e3244; background: #10121b; color: #eaeaf0; }
  .hidden { display: none !important; }
</style>
</head>
<body>

  <div id="home-screen" class="page center">
    <div class="card">
      <h1>Watch Party</h1>
      <p class="subtitle">Watch YouTube videos in sync with friends.</p>
      <label class="field"><span>Your name</span>
        <input id="name-input" placeholder="e.g. Alex" maxlength="24" />
      </label>
      <button class="btn primary" id="create-btn">Create a new room</button>
      <div class="divider">or join an existing room</div>
      <label class="field"><span>Room code</span>
        <input id="room-code-input" placeholder="e.g. AB12CD" maxlength="8" />
      </label>
      <button class="btn secondary" id="join-btn">Join room</button>
      <p class="error hidden" id="home-error"></p>
    </div>
  </div>

  <div id="room-screen" class="page room-page hidden">
    <div class="room-header">
      <div>
        <h2>Room <span id="room-id-label"></span></h2>
        <span class="role-badge" id="my-role-badge">You are: participant</span>
      </div>
      <div class="room-header-actions">
        <button class="btn secondary" id="copy-link-btn">Copy invite link</button>
        <button class="btn danger" id="leave-btn">Leave room</button>
      </div>
    </div>

    <div id="toast" class="toast hidden"></div>

    <div class="room-layout">
      <div class="main-col">
        <div class="player-wrapper"><div id="yt-player"></div></div>

        <div class="controls" id="playback-controls">
          <button class="btn" id="play-btn">Play</button>
          <button class="btn" id="pause-btn">Pause</button>
          <input class="seek-input" id="seek-input" placeholder="Seek to (sec)" />
          <button class="btn" id="seek-btn">Seek</button>
        </div>
        <p class="hint hidden" id="no-control-hint">Only the Host or Moderator can control playback.</p>

        <div class="controls" id="change-video-controls">
          <input class="video-input" id="video-input" placeholder="Paste YouTube URL to change video" />
          <button class="btn" id="change-video-btn">Change Video</button>
        </div>
      </div>

      <aside class="side-col">
        <div class="panel">
          <h3 id="participant-count">Participants (0)</h3>
          <ul class="participant-list" id="participant-list"></ul>
        </div>

        <div class="panel chat-panel">
          <h3>Chat</h3>
          <div class="chat-messages" id="chat-messages"></div>
          <div class="chat-input-row">
            <input id="chat-input" placeholder="Say something..." />
            <button class="btn tiny" id="chat-send-btn">Send</button>
          </div>
        </div>
      </aside>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
  (function () {
    // ---- identity helpers (persisted in localStorage) ----
    function getUserId() {
      var id = localStorage.getItem('wp_userId');
      if (!id) { id = 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('wp_userId', id); }
      return id;
    }
    function getUsername() { return localStorage.getItem('wp_username') || ''; }
    function setUsername(name) { localStorage.setItem('wp_username', name); }

    function extractYouTubeId(input) {
      if (!input) return null;
      var trimmed = input.trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
      try {
        var url = new URL(trimmed);
        if (url.hostname.indexOf('youtu.be') !== -1) return url.pathname.slice(1);
        if (url.searchParams.get('v')) return url.searchParams.get('v');
        if (url.pathname.indexOf('/embed/') !== -1) return url.pathname.split('/embed/')[1];
      } catch (e) { return null; }
      return null;
    }

    // ---- state ----
    var socket = io();
    var userId = getUserId();
    var username = getUsername();
    var role = 'participant';
    var currentRoomId = null;
    var lastAppliedVideoId = null;
    var ytPlayer = null;
    var ytReady = false;
    var pendingVideoId = null;

    // ---- DOM refs ----
    var homeScreen = document.getElementById('home-screen');
    var roomScreen = document.getElementById('room-screen');
    var nameInput = document.getElementById('name-input');
    var roomCodeInput = document.getElementById('room-code-input');
    var homeError = document.getElementById('home-error');
    var roomIdLabel = document.getElementById('room-id-label');
    var myRoleBadge = document.getElementById('my-role-badge');
    var toastEl = document.getElementById('toast');
    var participantListEl = document.getElementById('participant-list');
    var participantCountEl = document.getElementById('participant-count');
    var chatMessagesEl = document.getElementById('chat-messages');
    var playbackControls = document.getElementById('playback-controls');
    var changeVideoControls = document.getElementById('change-video-controls');
    var noControlHint = document.getElementById('no-control-hint');

    nameInput.value = username;

    function showToast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.remove('hidden');
      setTimeout(function () { toastEl.classList.add('hidden'); }, 3000);
    }

    // ---- YouTube IFrame API ----
    window.onYouTubeIframeAPIReady = function () {
      ytPlayer = new YT.Player('yt-player', {
        height: '100%', width: '100%',
        playerVars: { playsinline: 1, rel: 0 },
        events: { onReady: function () { ytReady = true; if (pendingVideoId) { ytPlayer.cueVideoById(pendingVideoId); pendingVideoId = null; } } }
      });
    };
    (function loadYT() {
      var tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    })();

    function applySyncState(state) {
      participantListEl.innerHTML = '';
      renderParticipants(state.participants || []);
      if (state.videoId && state.videoId !== lastAppliedVideoId) {
        lastAppliedVideoId = state.videoId;
        if (ytReady && ytPlayer) {
          ytPlayer.cueVideoById(state.videoId, state.currentTime || 0);
          setTimeout(function () {
            ytPlayer.seekTo(state.currentTime || 0, true);
            if (state.playState === 'playing') ytPlayer.playVideo();
          }, 500);
        } else {
          pendingVideoId = state.videoId;
        }
        return;
      }
      if (!ytReady || !ytPlayer) return;
      if (typeof state.currentTime === 'number') ytPlayer.seekTo(state.currentTime, true);
      if (state.playState === 'playing') ytPlayer.playVideo(); else ytPlayer.pauseVideo();
    }

    function renderParticipants(list) {
      participantCountEl.textContent = 'Participants (' + list.length + ')';
      participantListEl.innerHTML = '';
      list.forEach(function (p) {
        var li = document.createElement('li');
        li.className = 'participant-row';

        var nameSpan = document.createElement('span');
        nameSpan.textContent = p.username + (p.userId === userId ? ' (you)' : '');
        li.appendChild(nameSpan);

        var badge = document.createElement('span');
        badge.className = 'role-badge role-' + p.role;
        badge.textContent = p.role;
        li.appendChild(badge);

        if (role === 'host' && p.userId !== userId) {
          var actions = document.createElement('div');
          actions.className = 'host-actions';

          if (p.role !== 'moderator') {
            var modBtn = document.createElement('button');
            modBtn.className = 'btn tiny';
            modBtn.textContent = 'Make Mod';
            modBtn.onclick = function () { socket.emit('assign_role', { userId: p.userId, role: 'moderator' }); };
            actions.appendChild(modBtn);
          }
          if (p.role !== 'participant') {
            var viewBtn = document.createElement('button');
            viewBtn.className = 'btn tiny';
            viewBtn.textContent = 'Make Viewer';
            viewBtn.onclick = function () { socket.emit('assign_role', { userId: p.userId, role: 'participant' }); };
            actions.appendChild(viewBtn);
          }
          var hostBtn = document.createElement('button');
          hostBtn.className = 'btn tiny';
          hostBtn.textContent = 'Make Host';
          hostBtn.onclick = function () { socket.emit('transfer_host', { userId: p.userId }); };
          actions.appendChild(hostBtn);

          var removeBtn = document.createElement('button');
          removeBtn.className = 'btn tiny danger';
          removeBtn.textContent = 'Remove';
          removeBtn.onclick = function () { socket.emit('remove_participant', { userId: p.userId }); };
          actions.appendChild(removeBtn);

          li.appendChild(actions);
        }
        participantListEl.appendChild(li);
      });
    }

    function appendChatMessage(msg) {
      var div = document.createElement('div');
      div.className = 'chat-msg' + (msg.userId === userId ? ' mine' : '');
      var author = document.createElement('span');
      author.className = 'chat-author';
      author.textContent = msg.username;
      var text = document.createElement('span');
      text.textContent = msg.text;
      div.appendChild(author);
      div.appendChild(text);
      chatMessagesEl.appendChild(div);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    function updateRoleUI() {
      myRoleBadge.textContent = 'You are: ' + role;
      myRoleBadge.className = 'role-badge role-' + role;
      var canControl = role === 'host' || role === 'moderator';
      playbackControls.classList.toggle('hidden', !canControl);
      changeVideoControls.classList.toggle('hidden', !canControl);
      noControlHint.classList.toggle('hidden', canControl);
    }

    function enterRoom(roomId) {
      currentRoomId = roomId;
      roomIdLabel.textContent = roomId;
      homeScreen.classList.add('hidden');
      roomScreen.classList.remove('hidden');
      history.replaceState(null, '', '/room/' + roomId);
    }

    // ---- socket listeners ----
    socket.on('sync_state', applySyncState);
    socket.on('user_joined', function (data) { renderParticipants(data.participants || []); showToast(data.username + ' joined'); });
    socket.on('user_left', function (data) { renderParticipants(data.participants || []); showToast(data.username + ' left'); });
    socket.on('role_assigned', function (data) {
      renderParticipants(data.participants || []);
      if (data.userId === userId) { role = data.role; updateRoleUI(); }
      showToast((data.username || 'A participant') + ' is now ' + data.role);
    });
    socket.on('participant_removed', function (data) { renderParticipants(data.participants || []); });
    socket.on('you_were_removed', function () {
      showToast('You were removed from the room by the host.');
      setTimeout(function () { window.location.href = '/'; }, 1500);
    });
    socket.on('chat_message', function (msg) { appendChatMessage(msg); });
    socket.on('error_message', function (data) { showToast(data.message); });

    // ---- home screen actions ----
    document.getElementById('create-btn').onclick = function () {
      username = nameInput.value.trim();
      if (!username) { homeError.textContent = 'Please enter a display name.'; homeError.classList.remove('hidden'); return; }
      setUsername(username);
      socket.emit('create_room', { username: username, userId: userId }, function (res) {
        if (!res || !res.ok) { homeError.textContent = (res && res.error) || 'Could not create room'; homeError.classList.remove('hidden'); return; }
        role = res.role;
        renderParticipants(res.participants || []);
        updateRoleUI();
        enterRoom(res.roomId);
      });
    };

    document.getElementById('join-btn').onclick = function () {
      username = nameInput.value.trim();
      var code = roomCodeInput.value.trim().toUpperCase();
      if (!username) { homeError.textContent = 'Please enter a display name.'; homeError.classList.remove('hidden'); return; }
      if (!code) { homeError.textContent = 'Please enter a room code.'; homeError.classList.remove('hidden'); return; }
      setUsername(username);
      socket.emit('join_room', { roomId: code, username: username, userId: userId }, function (res) {
        if (!res || !res.ok) { homeError.textContent = (res && res.error) || 'Could not join room'; homeError.classList.remove('hidden'); return; }
        role = res.role;
        (res.chatHistory || []).forEach(appendChatMessage);
        if (res.state && res.state.videoId) lastAppliedVideoId = null; // force apply on next sync_state
        renderParticipants(res.participants || []);
        updateRoleUI();
        enterRoom(res.roomId);
      });
    };

    // ---- room screen actions ----
    document.getElementById('play-btn').onclick = function () { socket.emit('play'); };
    document.getElementById('pause-btn').onclick = function () { socket.emit('pause', { currentTime: ytPlayer ? ytPlayer.getCurrentTime() : 0 }); };
    document.getElementById('seek-btn').onclick = function () {
      var t = parseFloat(document.getElementById('seek-input').value);
      if (!isNaN(t)) socket.emit('seek', { time: t });
    };
    document.getElementById('change-video-btn').onclick = function () {
      var input = document.getElementById('video-input');
      var id = extractYouTubeId(input.value);
      if (!id) { showToast('Enter a valid YouTube URL or video ID'); return; }
      socket.emit('change_video', { videoId: id });
      input.value = '';
    };
    document.getElementById('chat-send-btn').onclick = sendChat;
    document.getElementById('chat-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });
    function sendChat() {
      var input = document.getElementById('chat-input');
      var text = input.value.trim();
      if (!text) return;
      socket.emit('chat_message', { text: text });
      input.value = '';
    }
    document.getElementById('leave-btn').onclick = function () {
      socket.emit('leave_room');
      window.location.href = '/';
    };
    document.getElementById('copy-link-btn').onclick = function () {
      navigator.clipboard.writeText(window.location.href);
      showToast('Room link copied!');
    };

    // ---- auto-join if URL already has a room code (e.g. shared link, or refresh) ----
    (function autoJoinFromUrl() {
      var match = window.location.pathname.match(/^\\/room\\/([A-Za-z0-9]+)$/);
      if (!match) return;
      var codeFromUrl = match[1].toUpperCase();
      username = getUsername();
      if (!username) { return; } // no stored name yet - user must go through home screen once
      socket.emit('join_room', { roomId: codeFromUrl, username: username, userId: userId }, function (res) {
        if (!res || !res.ok) { window.location.href = '/'; return; }
        role = res.role;
        (res.chatHistory || []).forEach(appendChatMessage);
        renderParticipants(res.participants || []);
        updateRoleUI();
        enterRoom(res.roomId);
      });
    })();
  })();
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// 6. EXPRESS ROUTES + SERVER START
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json(Object.assign({ status: 'healthy' }, roomManager.stats())));

// Serve the same page for "/" and for direct room links like "/room/AB12CD"
// (the inline client-side script detects the room code from the URL).
app.get(['/', '/room/:roomId'], (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(HTML_PAGE);
});

server.listen(PORT, () => {
  console.log('Watch Party (single-file) listening on port ' + PORT);
});
