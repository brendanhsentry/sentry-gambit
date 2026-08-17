/** Node server: Next.js frontend plus an in-memory WebSocket chess table service. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import next from "next";
import { WebSocketServer } from "ws";
import { Chess } from "chess.js";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;

const STARTING_TIME = 10 * 60 * 1000;
const IDLE_ROOM_TTL = 60 * 60 * 1000;

/** All live tables, keyed by room code. State is in-memory only, so the
 * service must run as a single instance (Cloud Run --max-instances=1). */
const tables = new Map();

function createTable(id) {
  return {
    id,
    chess: new Chess(),
    clients: new Set(),
    seats: { w: null, b: null },
    result: null,
    clock: { w: STARTING_TIME, b: STARTING_TIME, running: null, since: null },
    touchedAt: Date.now(),
  };
}

function serializeTable(table) {
  return {
    room: table.id,
    fen: table.chess.fen(),
    history: table.chess.history({ verbose: true }).map((move) => ({
      from: move.from,
      to: move.to,
      san: move.san,
      color: move.color,
    })),
    players: {
      w: table.seats.w?.name ?? null,
      b: table.seats.b?.name ?? null,
    },
    result: table.result,
    clock: table.clock,
  };
}

function send(client, payload) {
  try {
    client.socket.send(JSON.stringify(payload));
  } catch {
    // A close event will remove stale clients.
  }
}

function broadcast(table) {
  const payload = JSON.stringify({ type: "state", state: serializeTable(table) });
  for (const client of table.clients) {
    try {
      client.socket.send(payload);
    } catch {
      // A close event will remove stale clients.
    }
  }
}

function pauseClock(table, now = Date.now()) {
  const running = table.clock.running;
  if (running && table.clock.since !== null) {
    table.clock[running] = Math.max(0, table.clock[running] - (now - table.clock.since));
  }
  table.clock.running = null;
  table.clock.since = null;
}

function resumeClock(table, now = Date.now()) {
  if (!table.result && table.seats.w && table.seats.b) {
    table.clock.running = table.chess.turn();
    table.clock.since = now;
  }
}

function flagIfExpired(table, now = Date.now()) {
  const running = table.clock.running;
  if (!running || table.clock.since === null || table.result) return false;
  const remaining = table.clock[running] - (now - table.clock.since);
  if (remaining > 0) return false;
  table.clock[running] = 0;
  table.clock.running = null;
  table.clock.since = null;
  table.result = `${running === "w" ? "Black" : "White"} wins on time`;
  return true;
}

function setBoardResult(table) {
  if (table.chess.isCheckmate()) {
    table.result = `${table.chess.turn() === "w" ? "Black" : "White"} wins by checkmate`;
  } else if (table.chess.isStalemate()) {
    table.result = "Draw by stalemate";
  } else if (table.chess.isThreefoldRepetition()) {
    table.result = "Draw by repetition";
  } else if (table.chess.isInsufficientMaterial()) {
    table.result = "Draw by insufficient material";
  } else if (table.chess.isDrawByFiftyMoves()) {
    table.result = "Draw by the fifty-move rule";
  } else if (table.chess.isDraw()) {
    table.result = "Draw";
  }
  if (table.result) pauseClock(table);
}

function handleTableMessage(table, client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    send(client, { type: "error", message: "That message could not be read." });
    return;
  }

  table.touchedAt = Date.now();
  if (message.type === "move") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    if (client.role !== table.chess.turn()) {
      send(client, { type: "error", message: "Wait for your turn." });
      return;
    }
    if (flagIfExpired(table)) {
      broadcast(table);
      return;
    }
    if (!message.from || !message.to) return;

    const now = Date.now();
    pauseClock(table, now);
    try {
      table.chess.move({ from: message.from, to: message.to, promotion: message.promotion || "q" });
    } catch {
      resumeClock(table, now);
      send(client, { type: "error", message: "That move is not legal." });
      return;
    }
    setBoardResult(table);
    if (!table.result) resumeClock(table, now);
    broadcast(table);
    return;
  }

  if (message.type === "resign") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    table.result = `${client.role === "w" ? "Black" : "White"} wins by resignation`;
    pauseClock(table);
    broadcast(table);
    return;
  }

  if (message.type === "reset") {
    if (client.role === "spectator") return;
    table.chess.reset();
    table.result = null;
    table.clock = { w: STARTING_TIME, b: STARTING_TIME, running: null, since: null };
    resumeClock(table);
    broadcast(table);
    return;
  }

  if (message.type === "flag" && flagIfExpired(table)) {
    broadcast(table);
  }
}

function joinTable(request, socket) {
  const url = new URL(request.url, "http://localhost");
  const roomId = (url.searchParams.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (!roomId) {
    socket.close(1008, "A room code is required");
    return;
  }
  const name = (url.searchParams.get("name") || "Guest player").trim().slice(0, 24) || "Guest player";

  let table = tables.get(roomId);
  if (!table) {
    table = createTable(roomId);
    tables.set(roomId, table);
  }

  const role = !table.seats.w ? "w" : !table.seats.b ? "b" : "spectator";
  const client = { id: randomUUID(), name, role, socket };
  table.clients.add(client);
  if (role === "w" || role === "b") table.seats[role] = client;
  table.touchedAt = Date.now();
  if (!table.clock.running) resumeClock(table);

  socket.on("message", (data, isBinary) => {
    if (!isBinary) handleTableMessage(table, client, data.toString());
  });
  socket.on("close", () => {
    pauseClock(table);
    table.clients.delete(client);
    if (client.role === "w" || client.role === "b") {
      if (table.seats[client.role]?.id === client.id) table.seats[client.role] = null;
    }
    table.touchedAt = Date.now();
    broadcast(table);
  });
  socket.on("error", () => socket.close());

  send(client, { type: "welcome", role, playerId: client.id, state: serializeTable(table) });
  broadcast(table);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, table] of tables) {
    if (table.clients.size === 0 && now - table.touchedAt > IDLE_ROOM_TTL) tables.delete(id);
  }
}, 10 * 60 * 1000).unref();

const app = next({ dev });
await app.prepare();
const handleRequest = app.getRequestHandler();
const handleNextUpgrade = typeof app.getUpgradeHandler === "function" ? app.getUpgradeHandler() : null;

const server = createServer((req, res) => handleRequest(req, res));
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => joinTable(req, ws));
  } else if (handleNextUpgrade) {
    // Next dev-mode hot reload uses its own WebSocket.
    handleNextUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Castle & Clock listening on http://0.0.0.0:${port}`);
});
