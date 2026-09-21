# Watch Party (single-file version)

Everything — backend, WebSocket logic, RBAC, and the entire frontend — lives
in **one file: `server.js`**. `package.json` just lists the two dependencies
(Express, Socket.IO) so `npm install` works.

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:4000 — create a room in one tab, join with the code
in another to test sync.

## Deploy (one service, not two)

Because frontend and backend are the same app now, you only deploy **once**:

1. Push this folder to GitHub.
2. Render.com → New → Web Service → connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment variable: `CLIENT_ORIGIN` = your Render URL itself (e.g.
   `https://watch-party.onrender.com`) once you know it — or leave as `*`
   for the assignment demo.
6. Deploy. Open the URL Render gives you — that's your whole app, live.

No separate frontend deploy, no `VITE_BACKEND_URL`, no CORS juggling between
two different domains.

## Where everything is inside server.js

- **Section 2**: role permission rules (`canPerform`)
- **Section 3**: `Participant`, `Room`, `RoomManager` classes (OOP model)
- **Section 4**: all Socket.IO event handlers (`create_room`, `join_room`,
  `play`, `pause`, `seek`, `change_video`, `assign_role`,
  `remove_participant`, `transfer_host`, `chat_message`) — this is where
  role checks happen before any state changes
- **Section 5**: `HTML_PAGE` — the entire frontend as one template string
  (plain HTML/CSS/JS, no React, no build step)
- **Section 6**: Express routes that serve `HTML_PAGE` and start the server

## Trade-offs (same as the multi-file version)

- In-memory rooms only (no database) — restarting the server clears rooms.
- No login/auth — identity is a random ID stored in the browser's
  `localStorage`.
- Single server instance — scaling to multiple instances would need the
  Socket.IO Redis adapter.
