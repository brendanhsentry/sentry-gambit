/** Node server: Next.js frontend plus an in-memory WebSocket chess table service. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import next from "next";
import { WebSocketServer } from "ws";
import { Chess } from "chess.js";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;

Sentry.init({
  dsn: "https://69f4666f8a913ed118913d18660fe20d@o4511927634296832.ingest.us.sentry.io/4511927685939200",
  integrations: [
    // send console.log, console.warn, and console.error calls as logs to Sentry
    Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
  ],
  enableLogs: true,
  tracesSampleRate: 1.0,
});

const STARTING_TIME = 10 * 60 * 1000;
const IDLE_ROOM_TTL = 60 * 60 * 1000;
const MOVE_GRADES = new Set([
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "book",
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
]);

function createGameTrace(roomId, gameId) {
  return Sentry.startNewTrace(() =>
    Sentry.startInactiveSpan({
      name: "chess.game",
      op: "chess.game",
      attributes: {
        "chess.room.id": roomId,
        "chess.game.id": gameId,
      },
    }),
  );
}

function logGameEvent(table, name, attributes) {
  Sentry.withActiveSpan(table.sentrySpan, () => {
    Sentry.logger.info(name, attributes);
  });
}

function endGameTraceWhenReady(table) {
  if (
    table.sentryTraceEnded ||
    !table.result ||
    table.gradedPlies.size < table.chess.history().length
  )
    return;
  table.sentryTraceEnded = true;
  table.sentrySpan.end();
}

function captureFinishedGame(table) {
  if (!table.result || table.finishedIssueSent) return;
  table.finishedIssueSent = true;

  const plyCount = table.chess.history().length;
  table.sentrySpan.setAttributes({
    "chess.game.result": table.result,
    "chess.game.ply_count": plyCount,
  });

  Sentry.withActiveSpan(table.sentrySpan, (scope) => {
    scope.setTag("chess.game.id", table.gameId);
    scope.setTag("chess.room.id", table.id);
    scope.setTag("chess.game.result", table.result);
    scope.setContext("chess_game", {
      game_id: table.gameId,
      room_id: table.id,
      result: table.result,
      ply_count: plyCount,
      final_fen: table.chess.fen(),
    });
    // One issue per game (not one shared issue), so Seer can review a single
    // game when asked about its short ID.
    scope.setFingerprint(["chess.game.finished", table.gameId]);
    Sentry.captureMessage(`Pawn Patrol game finished — room ${table.id}`);
  });

  endGameTraceWhenReady(table);
}

/** All live tables, keyed by room code. State is in-memory only, so the
 * service must run as a single instance (Cloud Run --max-instances=1). */
const tables = new Map();

function createTable(id) {
  const gameId = randomUUID();
  return {
    id,
    gameId,
    chess: new Chess(),
    clients: new Set(),
    seats: { w: null, b: null },
    result: null,
    clock: { w: STARTING_TIME, b: STARTING_TIME, running: null, since: null },
    gradedPlies: new Set(),
    sentrySpan: createGameTrace(id, gameId),
    sentryTraceEnded: false,
    finishedIssueSent: false,
    touchedAt: Date.now(),
  };
}

function serializeTable(table) {
  return {
    room: table.id,
    gameId: table.gameId,
    fen: table.chess.fen(),
    history: table.chess.history({ verbose: true }).map((move) => ({
      from: move.from,
      to: move.to,
      san: move.san,
      color: move.color,
      promotion: move.promotion,
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
  const payload = JSON.stringify({
    type: "state",
    state: serializeTable(table),
  });
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
    table.clock[running] = Math.max(
      0,
      table.clock[running] - (now - table.clock.since),
    );
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
      captureFinishedGame(table);
      broadcast(table);
      return;
    }
    if (!message.from || !message.to) return;

    const now = Date.now();
    pauseClock(table, now);
    let acceptedMove;
    try {
      acceptedMove = table.chess.move({
        from: message.from,
        to: message.to,
        promotion: message.promotion || "q",
      });
    } catch {
      resumeClock(table, now);
      send(client, { type: "error", message: "That move is not legal." });
      return;
    }
    setBoardResult(table);
    if (!table.result) resumeClock(table, now);
    const ply = table.chess.history().length;
    logGameEvent(table, "chess.move.accepted", {
      "chess.room.id": table.id,
      "chess.game.id": table.gameId,
      "chess.move.ply": ply,
      "chess.move.number": Math.ceil(ply / 2),
      "chess.move.color": acceptedMove.color === "w" ? "white" : "black",
      "chess.move.from": acceptedMove.from,
      "chess.move.to": acceptedMove.to,
      "chess.move.san": acceptedMove.san,
      "chess.move.uci": `${acceptedMove.from}${acceptedMove.to}${acceptedMove.promotion ?? ""}`,
      "chess.position.fen_after": table.chess.fen(),
      "chess.clock.remaining_ms": table.clock[acceptedMove.color],
      "chess.game.finished": Boolean(table.result),
      "chess.game.result": table.result ?? "in_progress",
    });
    captureFinishedGame(table);
    broadcast(table);
    return;
  }

  if (message.type === "move_grade") {
    if (message.gameId !== table.gameId) return;

    const ply = Number(message.ply);
    const grade = typeof message.grade === "string" ? message.grade : "";
    const loss = message.expectedPointsLoss;
    const validLoss =
      loss === null ||
      (typeof loss === "number" &&
        Number.isFinite(loss) &&
        loss >= 0 &&
        loss <= 1);
    if (
      !Number.isInteger(ply) ||
      ply < 1 ||
      !MOVE_GRADES.has(grade) ||
      !validLoss ||
      table.gradedPlies.has(ply)
    )
      return;

    const acceptedMove = table.chess.history({ verbose: true })[ply - 1];
    if (!acceptedMove) return;

    table.gradedPlies.add(ply);
    const attributes = {
      "chess.room.id": table.id,
      "chess.game.id": table.gameId,
      "chess.move.ply": ply,
      "chess.move.number": Math.ceil(ply / 2),
      "chess.move.color": acceptedMove.color === "w" ? "white" : "black",
      "chess.move.from": acceptedMove.from,
      "chess.move.to": acceptedMove.to,
      "chess.move.san": acceptedMove.san,
      "chess.move.uci": `${acceptedMove.from}${acceptedMove.to}${acceptedMove.promotion ?? ""}`,
      "chess.position.fen_after": acceptedMove.after,
      "chess.move.grade": grade,
      "chess.analysis.engine": "stockfish-18-lite-single",
      "chess.analysis.search_nodes": 12_000,
    };
    if (loss !== null) attributes["chess.move.expected_points_loss"] = loss;
    logGameEvent(table, "chess.move.graded", attributes);
    endGameTraceWhenReady(table);
    return;
  }

  if (message.type === "resign") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    table.result = `${client.role === "w" ? "Black" : "White"} wins by resignation`;
    pauseClock(table);
    captureFinishedGame(table);
    broadcast(table);
    return;
  }

  if (message.type === "reset") {
    if (client.role === "spectator") return;
    if (!table.sentryTraceEnded) table.sentrySpan.end();
    table.gameId = randomUUID();
    table.sentrySpan = createGameTrace(table.id, table.gameId);
    table.sentryTraceEnded = false;
    table.finishedIssueSent = false;
    table.chess.reset();
    table.result = null;
    table.clock = {
      w: STARTING_TIME,
      b: STARTING_TIME,
      running: null,
      since: null,
    };
    table.gradedPlies.clear();
    resumeClock(table);
    broadcast(table);
    return;
  }

  if (message.type === "flag" && flagIfExpired(table)) {
    captureFinishedGame(table);
    broadcast(table);
  }
}

function joinTable(request, socket) {
  const url = new URL(request.url, "http://localhost");
  const roomId = (url.searchParams.get("room") || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (!roomId) {
    socket.close(1008, "A room code is required");
    return;
  }
  const name =
    (url.searchParams.get("name") || "Guest player").trim().slice(0, 24) ||
    "Guest player";

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
      if (table.seats[client.role]?.id === client.id)
        table.seats[client.role] = null;
    }
    table.touchedAt = Date.now();
    broadcast(table);
  });
  socket.on("error", () => socket.close());

  send(client, {
    type: "welcome",
    role,
    playerId: client.id,
    state: serializeTable(table),
  });
  broadcast(table);
}

setInterval(
  () => {
    const now = Date.now();
    for (const [id, table] of tables) {
      if (table.clients.size === 0 && now - table.touchedAt > IDLE_ROOM_TTL) {
        if (!table.sentryTraceEnded) table.sentrySpan.end();
        tables.delete(id);
      }
    }
  },
  10 * 60 * 1000,
).unref();

const app = next({ dev });
await app.prepare();
const handleRequest = app.getRequestHandler();
const handleNextUpgrade =
  typeof app.getUpgradeHandler === "function" ? app.getUpgradeHandler() : null;

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
  console.log(`Pawn Patrol listening on http://0.0.0.0:${port}`);
});
