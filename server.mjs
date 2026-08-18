/** Node server: Next.js frontend plus an in-memory WebSocket chess table service. */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import next from "next";
import { WebSocketServer } from "ws";
import { Chess } from "chess.js";
import { openGameStore } from "./game-store.mjs";

const dev = process.env.NODE_ENV !== "production";
if (dev) {
  try {
    process.loadEnvFile(".env.local");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const port = Number(process.env.PORT) || 3000;
const gameStore = openGameStore();

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
  gameStore.finishGame(table.gameId, table.result, table.chess.fen(), table.clock);

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
  const table = {
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
  gameStore.createGame({
    id: gameId,
    room: id,
    fen: table.chess.fen(),
    clock: table.clock,
  });
  return table;
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
    gameStore.recordMove(table.gameId, ply, acceptedMove, table.chess.fen(), table.clock);
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
    if (table.chess.history().length) {
      gameStore.finishGame(
        table.gameId,
        table.result ?? "Game reset",
        table.chess.fen(),
        table.clock,
      );
    } else {
      gameStore.deleteGame(table.gameId);
    }
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
    gameStore.createGame({
      id: table.gameId,
      room: table.id,
      fen: table.chess.fen(),
      clock: table.clock,
    });
    gameStore.updatePlayers(table.gameId, {
      w: table.seats.w?.name ?? null,
      b: table.seats.b?.name ?? null,
    });
    for (const color of ["w", "b"]) {
      const seated = table.seats[color];
      if (seated?.playerKey) gameStore.addPlayer(table.gameId, seated.playerKey, color);
    }
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
  const playerKey = (url.searchParams.get("playerKey") || "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 64);

  let table = tables.get(roomId);
  if (!table) {
    table = createTable(roomId);
    tables.set(roomId, table);
  }

  const role = !table.seats.w ? "w" : !table.seats.b ? "b" : "spectator";
  const client = { id: randomUUID(), name, role, playerKey, socket };
  table.clients.add(client);
  if (role === "w" || role === "b") {
    table.seats[role] = client;
    if (playerKey) gameStore.addPlayer(table.gameId, playerKey, role);
  }
  gameStore.updatePlayers(table.gameId, {
    w: table.seats.w?.name ?? null,
    b: table.seats.b?.name ?? null,
  });
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

const SENTRY_ORG = "sentry-gambit";
const SENTRY_PROJECT_ID = "4511927685939200";
const SEER_TOKEN = process.env.SEER_API_TOKEN || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash-0731";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const EXPLAINABLE_GRADES = new Set(["inaccuracy", "mistake", "miss", "blunder"]);
const EXPLANATION_MOTIFS = new Set([
  "material_loss",
  "hanging_piece",
  "fork",
  "pin",
  "skewer",
  "mate_threat",
  "missed_win",
  "positional",
  "unclear",
]);
const explanationCache = new Map();
const explanationRateLimits = new Map();

const REVIEW_PROMPT = [
  "This issue represents one finished chess game. Review the game using the",
  "chess.move.accepted and chess.move.graded logs in this issue's trace.",
  "Reconstruct the game, call out the key moments (best moves, mistakes,",
  "blunders) with move numbers, and give each player two or three concrete",
  "tips to improve. Keep it under 300 words. This is a chess game review:",
  "do not analyze application code and do not propose code changes.",
].join(" ");

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(req, maxBytes = 8_192) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > maxBytes) throw new RequestError(413, "Request is too large.");

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, "Request is too large.");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Request body must be valid JSON.");
  }
}

function parseUciMove(value) {
  if (typeof value !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)) {
    throw new RequestError(400, "Analysis contains an invalid move.");
  }
  return value;
}

function parseEngineLine(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new RequestError(400, "Analysis contains an invalid engine line.");
  }
  return value.map(parseUciMove);
}

function parseExpectedPoints(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RequestError(400, "Analysis contains an invalid evaluation.");
  }
  return value;
}

function replayEngineLine(fen, moves) {
  let board;
  try {
    board = new Chess(fen);
  } catch {
    throw new RequestError(400, "Analysis contains an invalid position.");
  }

  const san = [];
  for (const uci of moves.slice(0, 10)) {
    try {
      const move = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || "q",
      });
      if (!move) throw new Error("Illegal move");
      san.push(move.san);
    } catch {
      throw new RequestError(400, "Analysis contains an illegal engine line.");
    }
  }
  return san;
}

function validateMoveAnalysis(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "Move analysis is required.");
  }
  const fenBefore = typeof body.fenBefore === "string" ? body.fenBefore.trim() : "";
  if (!fenBefore || fenBefore.length > 120) {
    throw new RequestError(400, "Analysis contains an invalid position.");
  }
  const grade = typeof body.grade === "string" ? body.grade : "";
  if (!EXPLAINABLE_GRADES.has(grade)) {
    throw new RequestError(400, "Only significant errors can be explained.");
  }
  const playedMove = parseUciMove(body.playedMove);
  const playedLine = parseEngineLine(body.playedLine);
  const bestLine = parseEngineLine(body.bestLine);
  if (playedLine[0] !== playedMove) {
    throw new RequestError(400, "The played line does not start with the played move.");
  }

  const playedLineSan = replayEngineLine(fenBefore, playedLine);
  const bestLineSan = replayEngineLine(fenBefore, bestLine);
  return {
    grade,
    fenBefore,
    playedMove,
    playedLine,
    bestLine,
    playedLineSan,
    bestLineSan,
    bestExpectedPoints: parseExpectedPoints(body.bestExpectedPoints),
    playedExpectedPoints: parseExpectedPoints(body.playedExpectedPoints),
  };
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function consumeExplanationRateLimit(req) {
  const key = clientAddress(req);
  const now = Date.now();
  const existing = explanationRateLimits.get(key);
  if (!existing || now - existing.startedAt >= 10 * 60 * 1000) {
    explanationRateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 20;
}

function cacheExplanation(key, value) {
  if (explanationCache.size >= 500) {
    const oldest = explanationCache.keys().next().value;
    if (oldest) explanationCache.delete(oldest);
  }
  explanationCache.set(key, value);
}

async function callOpenRouter(facts) {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(12_000),
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "https://pawn-patrol.example",
      "X-OpenRouter-Title": "Pawn Patrol",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "Explain this chess error using only the supplied Stockfish evidence.",
            "Do not invent moves, evaluations, threats, or tactical motifs.",
            "The played line shows the punishment; the best line shows the alternative.",
            "If the exact motif is not demonstrated, choose unclear.",
            "Use at most two short sentences and write for a club chess player.",
          ].join(" "),
        },
        { role: "user", content: JSON.stringify(facts) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "move_explanation",
          strict: true,
          schema: {
            type: "object",
            properties: {
              motif: { type: "string", enum: [...EXPLANATION_MOTIFS] },
              explanation: {
                type: "string",
                description: "At most two short sentences supported by the engine lines.",
              },
            },
            required: ["motif", "explanation"],
            additionalProperties: false,
          },
        },
      },
      provider: {
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
      },
      max_tokens: 180,
    }),
  });

  if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter returned no explanation");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenRouter returned invalid JSON");
  }
  const motif = typeof parsed?.motif === "string" ? parsed.motif : "";
  const explanation = typeof parsed?.explanation === "string" ? parsed.explanation.trim() : "";
  if (!EXPLANATION_MOTIFS.has(motif) || !explanation || explanation.length > 400) {
    throw new Error("OpenRouter returned an invalid explanation");
  }
  return { motif, explanation };
}

async function handleMoveExplanationRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  if (!consumeExplanationRateLimit(req)) {
    sendJson(res, 429, { error: "Too many explanation requests. Try again shortly." });
    return;
  }

  let analysis;
  try {
    analysis = validateMoveAnalysis(await readJsonBody(req));
  } catch (error) {
    sendJson(res, error instanceof RequestError ? error.status : 400, {
      error: error instanceof Error ? error.message : "Invalid request.",
    });
    return;
  }

  const lines = {
    playedLine: analysis.playedLineSan,
    bestLine: analysis.bestLineSan,
  };
  if (!OPENROUTER_API_KEY) {
    sendJson(res, 503, {
      ...lines,
      error: "Move explanations are not configured.",
    });
    return;
  }

  const facts = {
    grade: analysis.grade,
    fenBefore: analysis.fenBefore,
    playedMove: analysis.playedLineSan[0],
    playedLine: analysis.playedLineSan,
    bestMove: analysis.bestLineSan[0],
    bestLine: analysis.bestLineSan,
    expectedPointsBefore: analysis.bestExpectedPoints,
    expectedPointsAfter: analysis.playedExpectedPoints,
  };
  const cacheKey = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  const cached = explanationCache.get(cacheKey);
  if (cached) {
    sendJson(res, 200, { ...lines, ...cached, cached: true });
    return;
  }

  try {
    const explanation = await callOpenRouter(facts);
    cacheExplanation(cacheKey, explanation);
    sendJson(res, 200, { ...lines, ...explanation, cached: false });
  } catch (error) {
    console.error("OpenRouter move explanation failed:", error.message);
    sendJson(res, 502, {
      ...lines,
      error: "The AI explanation is unavailable; the verified engine lines are shown instead.",
    });
  }
}

function handleGamesRequest(req, res, url) {
  if (req.method !== "GET") return false;
  const playerKey = (url.searchParams.get("playerKey") || "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 64);
  if (url.pathname === "/api/games") {
    sendJson(res, 200, {
      games: gameStore.listGames(playerKey, url.searchParams.get("limit") ?? 20),
    });
    return true;
  }
  const match = url.pathname.match(/^\/api\/games\/([^/]+)$/);
  if (!match) return false;
  const game = gameStore.getGame(decodeURIComponent(match[1]), playerKey);
  sendJson(res, game ? 200 : 404, game ?? { error: "Game not found" });
  return true;
}

async function sentryApi(path, options = {}) {
  const response = await fetch(`https://sentry.io/api/0${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SEER_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`Sentry API ${response.status} for ${path}`);
  return response.json();
}

function extractReview(autofix) {
  const blocks = Array.isArray(autofix?.blocks) ? autofix.blocks : [];
  const answers = blocks
    .map((block) => block?.message)
    .filter((m) => m && m.role === "assistant" && typeof m.content === "string" && m.content.trim());
  return answers.length ? answers[answers.length - 1].content : null;
}

async function handleReviewRequest(req, res, url) {
  if (!SEER_TOKEN) {
    sendJson(res, 503, { error: "Game review is not configured." });
    return;
  }
  try {
    if (req.method === "POST" && url.pathname === "/api/review") {
      const gameId = (url.searchParams.get("gameId") || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
      if (!gameId) {
        sendJson(res, 400, { error: "gameId is required" });
        return;
      }
      const query = encodeURIComponent(`chess.game.id:${gameId}`);
      const issues = await sentryApi(
        `/organizations/${SENTRY_ORG}/issues/?project=${SENTRY_PROJECT_ID}&query=${query}&limit=1`,
      );
      if (!Array.isArray(issues) || issues.length === 0) {
        // The game's issue can lag ingestion by a minute; the client retries.
        sendJson(res, 404, { error: "Game not indexed yet. Try again shortly." });
        return;
      }
      const issueId = issues[0].id;
      const existing = await sentryApi(`/organizations/${SENTRY_ORG}/issues/${issueId}/autofix/`);
      if (!existing?.autofix || existing.autofix.status === "errored") {
        await sentryApi(`/organizations/${SENTRY_ORG}/issues/${issueId}/autofix/?mode=explorer`, {
          method: "POST",
          body: JSON.stringify({ step: "root_cause", referrer: "api.web", user_context: REVIEW_PROMPT }),
        });
      }
      sendJson(res, 200, { issueId, shortId: issues[0].shortId });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/review/status") {
      const issueId = (url.searchParams.get("issueId") || "").replace(/\D/g, "");
      if (!issueId) {
        sendJson(res, 400, { error: "issueId is required" });
        return;
      }
      const data = await sentryApi(`/organizations/${SENTRY_ORG}/issues/${issueId}/autofix/`);
      const status = data?.autofix?.status ?? "none";
      sendJson(res, 200, { status, text: extractReview(data?.autofix) });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Seer review request failed:", error.message);
    sendJson(res, 502, { error: "Sentry API request failed." });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (handleGamesRequest(req, res, url)) return;
  if (url.pathname === "/api/move-explanation") {
    void handleMoveExplanationRequest(req, res);
    return;
  }
  if (url.pathname.startsWith("/api/review")) {
    void handleReviewRequest(req, res, url);
    return;
  }
  handleRequest(req, res);
});
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
