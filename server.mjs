/** Node server: Next.js frontend plus an in-memory WebSocket chess table service. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { createRequire } from "node:module";
import * as Sentry from "@sentry/node";
import next from "next";
import { WebSocketServer } from "ws";
import { Chess } from "chess.js";
import { openGameStore } from "./game-store.mjs";
import { openFirestoreGameStore } from "./firestore-game-store.mjs";
import { loadMaia, pickMaiaMove } from "./maia.mjs";
import {
  classifyOpening,
  findOpeningMention,
  isOpeningPosition,
} from "./app/opening-book.mjs";

const require = createRequire(import.meta.url);
const STOCKFISH_SCRIPT = require.resolve("stockfish/bin/stockfish-18-lite-single.js");

const dev = process.env.NODE_ENV !== "production";
if (dev) {
  try {
    process.loadEnvFile(".env.local");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const port = Number(process.env.PORT) || 3000;
const gameStore =
  (process.env.GAME_STORE ?? (dev ? "sqlite" : "firestore")) === "firestore"
    ? openFirestoreGameStore()
    : openGameStore();

Sentry.init({
  dsn: "https://69f4666f8a913ed118913d18660fe20d@o4511927634296832.ingest.us.sentry.io/4511927685939200",
  integrations: [
    // send console.log, console.warn, and console.error calls as logs to Sentry
    Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
  ],
  enableLogs: true,
  tracesSampleRate: 1.0,
  streamGenAiSpans: true,
});

const DEFAULT_STARTING_TIME = 10 * 60 * 1000;
const STARTING_TIMES = new Set(
  [1, 3, 5, 10, 15].map((minutes) => minutes * 60 * 1000),
);
const INCREMENTS = new Map([[15 * 60 * 1000, 10_000]]);
const IDLE_ROOM_TTL = 60 * 60 * 1000;
const BOT_THINK_MS = 500;
const BOTS = {
  levy: { name: "Garry", elo: 1100 },
  hikaru: { name: "Mikhail", elo: 1500 },
  magnus: { name: "Magnus", elo: 1900 },
  grandmaster: { name: "Bobby", elo: 2200 },
};
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

function tableOpening(table) {
  const moves = table.chess
    .history({ verbose: true })
    .map((move) => `${move.from}${move.to}${move.promotion ?? ""}`);
  return classifyOpening(moves);
}

function openingAttributes(opening) {
  if (!opening) return {};
  return {
    "chess.opening.eco": opening.eco,
    "chess.opening.name": opening.name,
    "chess.opening.family": opening.family,
    "chess.opening.side": opening.side,
    "chess.opening.ply_depth": opening.ply,
  };
}

function telemetryPlayerId(kind, value) {
  return createHash("sha256")
    .update(`pawn-patrol:${kind}:${value}`)
    .digest("hex");
}

function tablePlayerIds(table, color) {
  const userId = table.seatUsers[color];
  if (userId) return [telemetryPlayerId("user", userId)];
  return [
    ...new Set(
      [...table.playerColors]
        .filter(([, playerColor]) => playerColor === color)
        .map(([playerKey]) => telemetryPlayerId("player", playerKey)),
    ),
  ];
}

function logCompletedGameSummaries(table) {
  if (table.summaryLogsSent) return;
  table.summaryLogsSent = true;
  const whiteScore = resultScore(table.result ?? "");
  if (whiteScore === null) return;
  const opening = tableOpening(table);
  for (const color of ["w", "b"]) {
    if (table.bot?.color === color) continue;
    const grades = [...table.moveGrades.entries()]
      .filter(([ply]) => (ply % 2 === 1 ? "w" : "b") === color)
      .map(([, grade]) => grade);
    const losses = grades
      .map(({ expectedPointsLoss }) => expectedPointsLoss)
      .filter((loss) => loss !== null);
    const score = color === "w" ? whiteScore : 1 - whiteScore;
    const gradeCount = (name) => grades.filter(({ grade }) => grade === name).length;
    for (const playerId of tablePlayerIds(table, color)) {
      logGameEvent(table, "chess.player.game.completed", {
        "chess.player.id": playerId,
        "chess.player.color": color === "w" ? "white" : "black",
        "chess.player.outcome": score === 1 ? "win" : score === 0 ? "loss" : "draw",
        "chess.player.score": score,
        "chess.player.blunders": gradeCount("blunder"),
        "chess.player.mistakes": gradeCount("mistake"),
        "chess.player.inaccuracies": gradeCount("inaccuracy"),
        "chess.player.misses": gradeCount("miss"),
        "chess.player.expected_points_loss": losses.length
          ? losses.reduce((sum, loss) => sum + loss, 0) / losses.length
          : 0,
        "chess.game.id": table.gameId,
        "chess.game.result": table.result,
        "chess.game.ply_count": table.chess.history().length,
        "chess.game.time_control_ms": table.initialTimeMs,
        "chess.game.opponent": table.bot ? "bot" : "human",
        ...openingAttributes(opening),
      });
    }
  }
}

function endGameTraceWhenReady(table) {
  if (
    table.sentryTraceEnded ||
    !table.result ||
    table.gradedPlies.size < table.chess.history().length
  )
    return;
  logCompletedGameSummaries(table);
  table.sentryTraceEnded = true;
  table.sentrySpan.end();
}

const ELO_K = 32;

function resultScore(result) {
  if (result.startsWith("White wins")) return 1;
  if (result.startsWith("Black wins")) return 0;
  if (result.startsWith("Draw")) return 0.5;
  return null;
}

// Only completed games between signed-in players are rated.
async function applyGameRatings(table) {
  if (table.bot) return;
  const whiteScore = resultScore(table.result ?? "");
  if (whiteScore === null || table.chess.history().length < 2) return;
  const ratings = {};
  const players = {};
  for (const color of ["w", "b"]) {
    const userId = table.seatUsers[color];
    if (userId) {
      const user = await gameStore.getUserById(userId);
      if (!user) return;
      players[color] = user;
      ratings[color] = user.rating;
    } else if (table.bot?.color === color) {
      ratings[color] = table.bot.elo;
    } else {
      return;
    }
  }
  if (!players.w && !players.b) return;
  const expectedWhite = 1 / (1 + 10 ** ((ratings.b - ratings.w) / 400));
  for (const color of ["w", "b"]) {
    if (!players[color]) continue;
    const score = color === "w" ? whiteScore : 1 - whiteScore;
    const expected = color === "w" ? expectedWhite : 1 - expectedWhite;
    const newRating = Math.round(ratings[color] + ELO_K * (score - expected));
    const outcome = score === 1 ? "win" : score === 0 ? "loss" : "draw";
    await gameStore.recordRatedResult(players[color].id, newRating, outcome);
    console.log(
      `Rated game ${table.gameId}: ${players[color].username} ${ratings[color]} -> ${newRating} (${outcome})`,
    );
  }
}

function captureFinishedGame(table) {
  if (!table.result || table.finishedIssueSent) return;
  table.finishedIssueSent = true;
  gameStore.finishGame(
    table.gameId,
    table.result,
    table.chess.fen(),
    table.clock,
  );
  applyGameRatings(table).catch((error) => {
    console.error(`Rating update failed for game ${table.gameId}:`, error);
  });

  const plyCount = table.chess.history().length;
  const opening = tableOpening(table);
  table.sentrySpan.setAttributes({
    "chess.game.result": table.result,
    "chess.game.ply_count": plyCount,
    ...openingAttributes(opening),
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
      opening: opening?.name ?? null,
      opening_eco: opening?.eco ?? null,
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

function createTable(id, initialTimeMs = DEFAULT_STARTING_TIME) {
  const gameId = randomUUID();
  const table = {
    id,
    gameId,
    chess: new Chess(),
    clients: new Set(),
    seats: { w: null, b: null },
    seatOrder: randomInt(2) === 0 ? ["w", "b"] : ["b", "w"],
    result: null,
    initialTimeMs,
    clock: { w: initialTimeMs, b: initialTimeMs, running: null, since: null },
    gradedPlies: new Set(),
    moveGrades: new Map(),
    moveAnalyses: new Map(),
    moveReviewLosses: new Map(),
    playerColors: new Map(),
    seatUsers: { w: null, b: null },
    sentrySpan: createGameTrace(id, gameId),
    sentryTraceEnded: false,
    finishedIssueSent: false,
    summaryLogsSent: false,
    touchedAt: Date.now(),
  };
  gameStore.createGame({
    id: gameId,
    room: id,
    fen: table.chess.fen(),
    clock: table.clock,
    initialTimeMs: table.initialTimeMs,
  });
  return table;
}

function restoreTable(id, saved) {
  const chess = new Chess();
  for (const move of saved.history) {
    chess.move({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
  }
  console.log(
    `Restored room ${id} game ${saved.id} at ply ${saved.history.length}`,
  );
  const table = {
    id,
    gameId: saved.id,
    chess,
    clients: new Set(),
    seats: { w: null, b: null },
    seatOrder: randomInt(2) === 0 ? ["w", "b"] : ["b", "w"],
    result: null,
    initialTimeMs: saved.initialTimeMs ?? DEFAULT_STARTING_TIME,
    clock: { w: saved.clock.w, b: saved.clock.b, running: null, since: null },
    gradedPlies: new Set(),
    moveGrades: new Map(),
    moveAnalyses: new Map(),
    moveReviewLosses: new Map(),
    playerColors: new Map(Object.entries(saved.playerColors ?? {})),
    seatUsers: {
      w: saved.seatUsers?.w ?? null,
      b: saved.seatUsers?.b ?? null,
    },
    sentrySpan: createGameTrace(id, saved.id),
    sentryTraceEnded: false,
    finishedIssueSent: false,
    summaryLogsSent: false,
    touchedAt: Date.now(),
  };
  if (saved.bot && BOTS[saved.bot.key]) {
    const { key, color } = saved.bot;
    table.coach = Boolean(saved.bot.coach);
    table.bot = { key, name: BOTS[key].name, elo: BOTS[key].elo, color };
    table.seats[color] = { id: randomUUID(), name: `${BOTS[key].name} (Bot)` };
  }
  return table;
}

const pendingRestores = new Map();

function obtainTable(roomId, initialTimeMs) {
  const existing = tables.get(roomId);
  if (existing) return existing;
  const pending = pendingRestores.get(roomId);
  if (pending) return pending;
  const promise = (async () => {
    let table = null;
    try {
      const saved = await gameStore.getLiveGame(roomId, IDLE_ROOM_TTL);
      if (saved) table = restoreTable(roomId, saved);
    } catch (error) {
      console.error(
        `Failed to restore room ${roomId} from the game store:`,
        error,
      );
    }
    table ??= createTable(roomId, initialTimeMs);
    tables.set(roomId, table);
    return table;
  })().finally(() => pendingRestores.delete(roomId));
  pendingRestores.set(roomId, promise);
  return promise;
}

function chooseSeat(table, playerKey) {
  const reserved = playerKey ? table.playerColors.get(playerKey) : undefined;
  if (reserved) return table.seats[reserved] ? "spectator" : reserved;
  const reservedColors = new Set(table.playerColors.values());
  return (
    table.seatOrder.find(
      (color) => !table.seats[color] && !reservedColors.has(color),
    ) ?? "spectator"
  );
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
    initialTimeMs: table.initialTimeMs,
    clock: table.clock,
    bot: table.bot ?? null,
    coach: table.coach ?? false,
    undoRequest: table.undoRequest ?? null,
    drawOffer: table.drawOffer ?? null,
    rematchRequest: table.rematchRequest ?? null,
    liveGrades: table.liveGrades ?? false,
    liveGradesRequest: table.liveGradesRequest ?? null,
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
  scheduleBotMove(table);
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
  if (!table.result && table.seats.w && table.seats.b && table.chess.history().length) {
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

function applyDrawAgreement(table) {
  table.drawOffer = null;
  table.undoRequest = null;
  if (flagIfExpired(table)) {
    captureFinishedGame(table);
    broadcast(table);
    return;
  }
  table.result = "Draw";
  pauseClock(table);
  captureFinishedGame(table);
  broadcast(table);
}

function applyUndo(table, color) {
  table.undoRequest = null;
  table.drawOffer = null;
  const plies = table.chess.turn() === color ? 2 : 1;
  if (table.chess.history().length < plies) {
    broadcast(table);
    return;
  }
  if (flagIfExpired(table)) {
    captureFinishedGame(table);
    broadcast(table);
    return;
  }
  const now = Date.now();
  pauseClock(table, now);
  for (let i = 0; i < plies; i++) table.chess.undo();
  const newLength = table.chess.history().length;
  for (const ply of [...table.gradedPlies]) {
    if (ply > newLength) {
      table.gradedPlies.delete(ply);
      table.moveGrades.delete(ply);
      table.moveAnalyses.delete(ply);
      table.moveReviewLosses.delete(ply);
    }
  }
  gameStore.undoMoves(
    table.gameId,
    newLength + 1,
    table.chess.fen(),
    table.clock,
  );
  logGameEvent(table, "chess.move.undone", {
    "chess.room.id": table.id,
    "chess.game.id": table.gameId,
    "chess.undo.by": color === "w" ? "white" : "black",
    "chess.undo.plies": plies,
    "chess.move.ply": newLength,
    "chess.position.fen_after": table.chess.fen(),
  });
  resumeClock(table, now);
  broadcast(table);
}

function recordMoveGrade(table, ply, analysis) {
  if (table.gradedPlies.has(ply)) return false;
  const acceptedMove = table.chess.history({ verbose: true })[ply - 1];
  if (!acceptedMove || !MOVE_GRADES.has(analysis.grade)) return false;

  const loss = analysis.expectedPointsLoss;
  if (
    loss !== null &&
    (!Number.isFinite(loss) || loss < 0 || loss > 1)
  )
    return false;

  table.gradedPlies.add(ply);
  table.moveGrades.set(ply, { grade: analysis.grade, expectedPointsLoss: loss });
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
    "chess.move.grade": analysis.grade,
    "chess.analysis.engine": "stockfish-18-lite-single",
    "chess.analysis.search_depth": 12,
    ...openingAttributes(tableOpening(table)),
  };
  if (loss !== null) attributes["chess.move.expected_points_loss"] = loss;
  logGameEvent(table, "chess.move.graded", attributes);
  endGameTraceWhenReady(table);
  return true;
}

function playMove(table, move, movedByBot) {
  const now = Date.now();
  pauseClock(table, now);
  let acceptedMove;
  try {
    acceptedMove = table.chess.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion || "q",
    });
  } catch {
    resumeClock(table, now);
    return false;
  }
  table.undoRequest = null;
  table.drawOffer = null;
  table.clock[acceptedMove.color] += INCREMENTS.get(table.initialTimeMs) ?? 0;
  setBoardResult(table);
  if (!table.result) resumeClock(table, now);
  const ply = table.chess.history().length;
  gameStore.recordMove(
    table.gameId,
    ply,
    acceptedMove,
    table.chess.fen(),
    table.clock,
  );
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
    "chess.move.by_bot": movedByBot,
    "chess.game.finished": Boolean(table.result),
    "chess.game.result": table.result ?? "in_progress",
    ...openingAttributes(tableOpening(table)),
  });
  captureFinishedGame(table);
  broadcast(table);
  return true;
}

function scheduleBotMove(table) {
  const bot = table.bot;
  if (!bot || table.result) return;
  if (table.chess.turn() !== bot.color) {
    // Reset so an undo returning to a previously seen ply retriggers the bot.
    table.botMoveKey = null;
    return;
  }
  const fen = table.chess.fen();
  const moveKey = `${table.gameId}:${table.chess.history().length}:${fen}`;
  if (table.botMoveKey === moveKey) return;
  table.botMoveKey = moveKey;
  Promise.all([
    pickMaiaMove(fen, bot.elo),
    new Promise((resolve) => setTimeout(resolve, BOT_THINK_MS)),
  ])
    .then(([uci]) => {
      if (table.result || table.botMoveKey !== moveKey || table.chess.fen() !== fen) return;
      if (flagIfExpired(table)) {
        captureFinishedGame(table);
        broadcast(table);
        return;
      }
      playMove(table, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }, true);
    })
    .catch((error) => {
      console.error("Bot move failed:", error);
      if (table.botMoveKey === moveKey) table.botMoveKey = null;
    });
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
    if (!playMove(table, message, false)) {
      send(client, { type: "error", message: "That move is not legal." });
    }
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

    recordMoveGrade(table, ply, { grade, expectedPointsLoss: loss });
    return;
  }

  if (message.type === "coach") {
    if (!table.bot || (client.role !== "w" && client.role !== "b")) return;
    table.coach = message.enabled === true;
    gameStore.setBot(table.gameId, {
      key: table.bot.key,
      color: table.bot.color,
      coach: table.coach,
    });
    broadcast(table);
    return;
  }

  if (message.type === "resign") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    table.result = `${client.role === "w" ? "Black" : "White"} wins by resignation`;
    table.undoRequest = null;
    table.drawOffer = null;
    pauseClock(table);
    captureFinishedGame(table);
    broadcast(table);
    return;
  }

  // A takeback removes the requester's last move and any reply on top of it.
  // A seated human opponent must consent; a bot or empty seat accepts as-is.
  if (message.type === "undo") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    const plies = table.chess.turn() === client.role ? 2 : 1;
    if (table.chess.history().length < plies) return;
    const opponent = client.role === "w" ? "b" : "w";
    const opponentIsHuman =
      table.seats[opponent] && table.bot?.color !== opponent;
    if (opponentIsHuman) {
      if (table.undoRequest) return;
      table.undoRequest = { by: client.role };
      broadcast(table);
      return;
    }
    applyUndo(table, client.role);
    return;
  }

  if (message.type === "undo_response") {
    const request = table.undoRequest;
    if (!request || table.result) return;
    if (client.role !== (request.by === "w" ? "b" : "w")) return;
    table.undoRequest = null;
    if (message.accept) applyUndo(table, request.by);
    else broadcast(table);
    return;
  }

  // A draw needs both players to agree; a bot or empty seat accepts as-is.
  if (message.type === "draw_offer") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    const opponent = client.role === "w" ? "b" : "w";
    const opponentIsHuman =
      table.seats[opponent] && table.bot?.color !== opponent;
    if (opponentIsHuman) {
      if (table.drawOffer) return;
      table.drawOffer = { by: client.role };
      broadcast(table);
      return;
    }
    applyDrawAgreement(table);
    return;
  }

  if (message.type === "draw_response") {
    const offer = table.drawOffer;
    if (!offer || table.result) return;
    if (client.role !== (offer.by === "w" ? "b" : "w")) return;
    table.drawOffer = null;
    if (message.accept) applyDrawAgreement(table);
    else broadcast(table);
    return;
  }

  // Showing grades mid-game needs both players to agree; a bot or empty seat accepts as-is.
  if (message.type === "live_grades_request") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    const opponent = client.role === "w" ? "b" : "w";
    const opponentIsHuman =
      table.seats[opponent] && table.bot?.color !== opponent;
    if (opponentIsHuman) {
      if (table.liveGradesRequest) return;
      table.liveGradesRequest = { by: client.role };
    } else {
      table.liveGrades = !table.liveGrades;
    }
    broadcast(table);
    return;
  }

  if (message.type === "live_grades_response") {
    const request = table.liveGradesRequest;
    if (!request || table.result) return;
    if (client.role !== (request.by === "w" ? "b" : "w")) return;
    table.liveGradesRequest = null;
    if (message.accept) table.liveGrades = !table.liveGrades;
    broadcast(table);
    return;
  }

  if (message.type === "reset") {
    if (client.role === "spectator") return;
    if (table.chess.history().length && !table.result) return;
    const opponent = client.role === "w" ? "b" : "w";
    const opponentIsHuman =
      table.seats[opponent] && table.bot?.color !== opponent;
    if (opponentIsHuman && table.chess.history().length) {
      if (table.rematchRequest?.by === opponent) {
        resetTable(table, true);
        return;
      }
      if (table.rematchRequest) return;
      table.rematchRequest = { by: client.role };
      broadcast(table);
      return;
    }
    resetTable(table, false);
    return;
  }

  if (message.type === "rematch_response") {
    const request = table.rematchRequest;
    if (!request) return;
    if (client.role !== (request.by === "w" ? "b" : "w")) return;
    if (message.accept) resetTable(table, true);
    else {
      table.rematchRequest = null;
      broadcast(table);
    }
    return;
  }

  if (message.type === "flag" && flagIfExpired(table)) {
    captureFinishedGame(table);
    broadcast(table);
  }
}

function resetTable(table, swapSeats) {
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
  table.summaryLogsSent = false;
  table.chess.reset();
  table.result = null;
  table.undoRequest = null;
  table.drawOffer = null;
  table.rematchRequest = null;
  table.liveGrades = false;
  table.liveGradesRequest = null;
  table.clock = {
    w: table.initialTimeMs,
    b: table.initialTimeMs,
    running: null,
    since: null,
  };
  table.gradedPlies.clear();
  table.moveGrades.clear();
  table.moveAnalyses.clear();
  table.moveReviewLosses.clear();
  if (swapSeats && !table.bot) {
    [table.seats.w, table.seats.b] = [table.seats.b, table.seats.w];
    for (const color of ["w", "b"]) {
      const seated = table.seats[color];
      if (seated?.socket) seated.role = color;
    }
  }
  gameStore.createGame({
    id: table.gameId,
    room: table.id,
    fen: table.chess.fen(),
    clock: table.clock,
    initialTimeMs: table.initialTimeMs,
  });
  gameStore.updatePlayers(table.gameId, {
    w: table.seats.w?.name ?? null,
    b: table.seats.b?.name ?? null,
  });
  if (table.bot) {
    gameStore.setBot(table.gameId, {
      key: table.bot.key,
      color: table.bot.color,
      coach: table.coach === true,
    });
  }
  table.playerColors.clear();
  table.seatUsers = { w: null, b: null };
  for (const color of ["w", "b"]) {
    const seated = table.seats[color];
    if (seated?.playerKey) {
      table.playerColors.set(seated.playerKey, color);
      gameStore.addPlayer(table.gameId, seated.playerKey, color);
    }
    if (seated?.userId) {
      table.seatUsers[color] = seated.userId;
      gameStore.setSeatUser(table.gameId, color, seated.userId);
    }
  }
  resumeClock(table);
  if (swapSeats && !table.bot) {
    for (const color of ["w", "b"]) {
      const seated = table.seats[color];
      if (seated?.socket)
        send(seated, {
          type: "welcome",
          role: color,
          playerId: seated.id,
          state: serializeTable(table),
        });
    }
  }
  broadcast(table);
}

async function joinTable(request, socket) {
  const url = new URL(request.url, "http://localhost");
  const roomId = (url.searchParams.get("room") || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (!roomId) {
    socket.close(1008, "A room code is required");
    return;
  }
  const token = (url.searchParams.get("token") || "").slice(0, 64);
  let user = null;
  if (token) {
    try {
      user = await gameStore.getSessionUser(token);
    } catch (error) {
      console.error("Failed to resolve the signed-in player:", error);
    }
  }
  const name =
    user?.username ??
    ((url.searchParams.get("name") || "Guest player").trim().slice(0, 24) ||
      "Guest player");
  const playerKey = (url.searchParams.get("playerKey") || "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 64);
  const requestedTime = Number(url.searchParams.get("time"));
  const initialTimeMs = STARTING_TIMES.has(requestedTime)
    ? requestedTime
    : DEFAULT_STARTING_TIME;

  const table = await obtainTable(roomId, initialTimeMs);
  if (socket.readyState !== socket.OPEN) return;

  const role = chooseSeat(table, playerKey);
  const client = {
    id: randomUUID(),
    name,
    role,
    playerKey,
    userId: user?.id ?? null,
    socket,
  };
  table.clients.add(client);
  if (role === "w" || role === "b") {
    table.seats[role] = client;
    if (playerKey) {
      table.playerColors.set(playerKey, role);
      gameStore.addPlayer(table.gameId, playerKey, role);
    }
    if (user) {
      table.seatUsers[role] = user.id;
      gameStore.setSeatUser(table.gameId, role, user.id);
    }
  }

  // A seated human bringing a bot key gives the opposite seat to the bot,
  // both on game creation and when rejoining a restored bot game.
  const botKey = url.searchParams.get("bot") || "";
  if (
    BOTS[botKey] &&
    !table.bot &&
    !table.result &&
    (role === "w" || role === "b")
  ) {
    const botColor = role === "w" ? "b" : "w";
    const reserved = [...table.playerColors.values()].includes(botColor);
    if (!table.seats[botColor] && !reserved) {
      table.bot = {
        key: botKey,
        name: BOTS[botKey].name,
        elo: BOTS[botKey].elo,
        color: botColor,
      };
      table.seats[botColor] = {
        id: randomUUID(),
        name: `${BOTS[botKey].name} (Bot)`,
      };
      table.coach = url.searchParams.get("coach") === "1";
      gameStore.setBot(table.gameId, {
        key: botKey,
        color: botColor,
        coach: table.coach,
      });
    }
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
    table.clients.delete(client);
    if (client.role === "w" || client.role === "b") {
      pauseClock(table);
      if (table.seats[client.role]?.id === client.id)
        table.seats[client.role] = null;
      if (table.undoRequest?.by === client.role) table.undoRequest = null;
      if (table.drawOffer?.by === client.role) table.drawOffer = null;
      if (table.liveGradesRequest?.by === client.role)
        table.liveGradesRequest = null;
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

const SENTRY_ORG = "pawn-patrol";
const SENTRY_PROJECT_ID = "4511927685939200";
const SENTRY_DATA_API_BASE =
  process.env.SENTRY_DATA_API_BASE || "https://us.sentry.io/api/0";
const SEER_TOKEN = process.env.SEER_API_TOKEN || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "deepseek/deepseek-v3.2";
const OPENROUTER_FALLBACK_MODELS = (
  process.env.OPENROUTER_FALLBACK_MODELS || ""
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean)
  .slice(0, 3);
const OPENROUTER_TIMEOUT_MS = Math.max(
  5_000,
  Math.min(Number(process.env.OPENROUTER_TIMEOUT_MS) || 30_000, 120_000),
);
const OPENROUTER_MAX_ATTEMPTS = 2;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const EXPLAINABLE_GRADES = new Set([
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
]);
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
const PIECE_NAMES = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};
const explanationCache = new Map();
const explanationRateLimits = new Map();
const analysisRateLimits = new Map();
const analysisCache = new Map();
const analysisJobs = new Map();
const MOVE_COACH_AGENT_NAME = "Pawn Patrol Move Coach";
const MOVE_COACH_SPAN_ORIGIN = "manual.ai.openrouter";
const SENTRY_SPAN_STATUS_ERROR = 2;
const MOVE_COACH_SYSTEM_INSTRUCTIONS = [
  "You are a chess coach talking to your student right after their move.",
  "Explain this chess error using only the supplied Stockfish evidence.",
  "Do not invent moves, evaluations, threats, or tactical motifs.",
  "The played line shows the punishment; the best line shows the alternative.",
  "If the exact motif is not demonstrated, choose unclear.",
  "Write at most three short sentences, and prefer one or two — say only what the student needs to hear.",
  "Speak like a coach: direct, warm, and focused on the lesson in this move.",
  "Always name pieces, for example 'the white knight on f3' or 'the black queen moves to d5'.",
  "Board coordinates are allowed, but never use algebraic chess notation such as Nf3, e4, Qxd5, O-O, or move-number notation.",
  "Turn the supplied move descriptions into natural prose instead of copying their sentence structure verbatim.",
].join(" ");

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
  if (declaredLength > maxBytes)
    throw new RequestError(413, "Request is too large.");

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
  if (
    typeof value !== "string" ||
    !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)
  ) {
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
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
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

function describeEngineLine(fen, moves) {
  const board = new Chess(fen);
  return moves.slice(0, 10).map((uci) => {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const movingPiece = board.get(from);
    const move = board.move({ from, to, promotion: uci[4] || "q" });
    const color = movingPiece?.color === "b" ? "Black" : "White";
    let description;
    if (move.san.startsWith("O-O-O")) {
      description = `${color} castles queenside, moving the king from ${from} to ${to}`;
    } else if (move.san.startsWith("O-O")) {
      description = `${color} castles kingside, moving the king from ${from} to ${to}`;
    } else if (move.captured) {
      description = `${color}'s ${PIECE_NAMES[move.piece]} on ${from} captures the ${PIECE_NAMES[move.captured]} on ${to}`;
    } else {
      description = `${color}'s ${PIECE_NAMES[move.piece]} moves from ${from} to ${to}`;
    }
    if (move.promotion)
      description += ` and promotes to a ${PIECE_NAMES[move.promotion]}`;
    if (move.san.endsWith("#")) description += ", delivering checkmate";
    else if (move.san.endsWith("+")) description += ", giving check";
    return description;
  });
}

function expectedPointsFromStockfish(tokens) {
  const scoreIndex = tokens.indexOf("score");
  if (scoreIndex < 0) return null;
  const score = Number(tokens[scoreIndex + 2]);
  if (tokens[scoreIndex + 1] === "mate") return score > 0 ? 1 : 0;
  if (tokens[scoreIndex + 1] === "cp") return 1 / (1 + Math.exp(-score / 272));
  return null;
}

function parseStockfishLine(message) {
  if (!message.startsWith("info ") || !message.includes(" score ") || !message.includes(" pv "))
    return null;
  const tokens = message.trim().split(/\s+/);
  if (tokens.includes("lowerbound") || tokens.includes("upperbound")) return null;
  const pvIndex = tokens.indexOf("pv");
  const expectedPoints = expectedPointsFromStockfish(tokens);
  const pv = tokens.slice(pvIndex + 1);
  if (expectedPoints === null || !pv.length) return null;
  const multipvIndex = tokens.indexOf("multipv");
  return {
    multipv: multipvIndex >= 0 ? Number(tokens[multipvIndex + 1]) : 1,
    line: { move: pv[0], expectedPoints, pv },
  };
}

class ServerStockfish {
  constructor() {
    this.child = null;
    this.ready = null;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.output = "";
  }

  emit(line) {
    for (const listener of this.listeners) listener(line);
  }

  reset() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child && !child.killed) child.kill();
  }

  start() {
    if (this.child) return;
    const child = spawn(process.execPath, [STOCKFISH_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.output += chunk;
      const lines = this.output.split(/\r?\n/);
      this.output = lines.pop() ?? "";
      for (const line of lines) this.emit(line);
    });
    child.stderr.on("data", (chunk) => console.warn(`Stockfish: ${chunk}`));
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
    });
    this.ready = (async () => {
      await this.waitFor("uci", (line) => line === "uciok");
      this.send("setoption name Hash value 32");
      await this.waitFor("isready", (line) => line === "readyok");
    })();
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) throw new Error("Stockfish is unavailable.");
    this.child.stdin.write(`${command}\n`);
  }

  waitFor(command, predicate) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("Stockfish timed out."));
      }, 20_000);
      const listener = (line) => {
        if (!predicate(line)) return;
        clearTimeout(timeout);
        this.listeners.delete(listener);
        resolve(line);
      };
      this.listeners.add(listener);
      try {
        this.send(command);
      } catch (error) {
        clearTimeout(timeout);
        this.listeners.delete(listener);
        reject(error);
      }
    });
  }

  async searchNow(fen, multipv, searchMove) {
    this.start();
    try {
      await this.ready;
      this.send(`setoption name MultiPV value ${multipv}`);
      await this.waitFor("isready", (line) => line === "readyok");
      this.send(`position fen ${fen}`);
      return await new Promise((resolve, reject) => {
        const lines = new Map();
        const timeout = setTimeout(() => {
          this.listeners.delete(listener);
          this.send("stop");
          reject(new Error("Stockfish timed out."));
        }, 20_000);
        const listener = (line) => {
          const parsed = parseStockfishLine(line);
          if (parsed) lines.set(parsed.multipv, parsed.line);
          if (!line.startsWith("bestmove ")) return;
          clearTimeout(timeout);
          this.listeners.delete(listener);
          const result = [...lines.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, value]) => value);
          if (result.length) resolve(result);
          else reject(new Error("Stockfish returned no evaluation."));
        };
        this.listeners.add(listener);
        const restriction = searchMove ? ` searchmoves ${searchMove}` : "";
        this.send(`go depth 12${restriction}`);
      });
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  search(fen, multipv, searchMove) {
    const run = this.queue.then(() => this.searchNow(fen, multipv, searchMove));
    this.queue = run.catch(() => {});
    return run;
  }

  async reviewMove(fen, playedMove) {
    const top = await this.search(fen, 2);
    const played =
      top.find((line) => line.move === playedMove) ??
      (await this.search(fen, 1, playedMove))[0];
    return {
      best: top[0],
      second: top[1] ?? null,
      played,
      loss: Math.max(0, top[0].expectedPoints - played.expectedPoints),
    };
  }
}

const stockfish = new ServerStockfish();
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function materialBalance(board, color) {
  let balance = 0;
  for (const rank of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const file of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const piece = board.get(`${file}${rank}`);
      if (piece) balance += (piece.color === color ? 1 : -1) * PIECE_VALUE[piece.type];
    }
  }
  return balance;
}

function applyUci(board, move) {
  return board.move({
    from: move.slice(0, 2),
    to: move.slice(2, 4),
    promotion: move[4] || "q",
  });
}

function detectsSacrifice(fen, playedMove, pv, mover) {
  const board = new Chess(fen);
  const before = materialBalance(board, mover);
  const line = pv[0] === playedMove ? pv : [playedMove, ...pv];
  try {
    if (!applyUci(board, line[0]) || line.length < 2) return false;
    applyUci(board, line[1]);
    if (before - materialBalance(board, mover) < 1.75) return false;
    if (line.length >= 3) applyUci(board, line[2]);
    return before - materialBalance(board, mover) >= 1.75;
  } catch {
    return false;
  }
}

function classifyServerMove(review, fenBefore, move, previousReview) {
  const playedMove = `${move.from}${move.to}${move.promotion ?? ""}`;
  const secondExpectedPoints = review.second?.expectedPoints ?? review.best.expectedPoints;
  const criticalGap = review.best.expectedPoints - secondExpectedPoints;
  const loss = review.loss;
  const evidence = {
    fenBefore,
    playedMove,
    playedLine: review.played.pv.slice(0, 16),
    bestLine: review.best.pv.slice(0, 16),
    bestExpectedPoints: review.best.expectedPoints,
    playedExpectedPoints: review.played.expectedPoints,
  };
  const isBest = review.best.move === playedMove;
  const sacrifice = detectsSacrifice(fenBefore, playedMove, review.played.pv, move.color);
  let grade;
  if (
    isBest &&
    loss <= 0.02 &&
    sacrifice &&
    review.played.expectedPoints >= 0.45 &&
    criticalGap >= 0.04
  ) {
    grade = "brilliant";
  } else {
    const changesOutcome =
      (review.best.expectedPoints >= 0.72 && secondExpectedPoints < 0.55) ||
      (review.best.expectedPoints >= 0.45 && secondExpectedPoints < 0.25);
    const opponentCreatedOpportunity = previousReview?.loss >= 0.1;
    if (loss <= 0.02 && (criticalGap >= 0.12 || changesOutcome)) grade = "great";
    else if (
      opponentCreatedOpportunity &&
      review.best.expectedPoints >= 0.7 &&
      review.played.expectedPoints < 0.58 &&
      loss >= 0.1
    ) grade = "miss";
    else if (isBest) grade = "best";
    else if (loss <= 0.02) grade = "excellent";
    else if (loss <= 0.05) grade = "good";
    else if (loss <= 0.12) grade = "inaccuracy";
    else if (loss <= 0.28 || review.played.expectedPoints >= 0.65) grade = "mistake";
    else grade = "blunder";
  }
  return {
    grade,
    expectedPointsLoss: loss,
    positionExpectedPoints:
      move.color === "w"
        ? review.played.expectedPoints
        : 1 - review.played.expectedPoints,
    evidence,
  };
}

function validateMoveAnalysis(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "Move analysis is required.");
  }
  const fenBefore =
    typeof body.fenBefore === "string" ? body.fenBefore.trim() : "";
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
    throw new RequestError(
      400,
      "The played line does not start with the played move.",
    );
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
    playedLineDescription: describeEngineLine(fenBefore, playedLine),
    bestLineDescription: describeEngineLine(fenBefore, bestLine),
    bestExpectedPoints: parseExpectedPoints(body.bestExpectedPoints),
    playedExpectedPoints: parseExpectedPoints(body.playedExpectedPoints),
  };
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded)
    return forwarded.split(",")[0].trim();
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

function consumeAnalysisRateLimit(req) {
  const key = clientAddress(req);
  const now = Date.now();
  const existing = analysisRateLimits.get(key);
  if (!existing || now - existing.startedAt >= 10 * 60 * 1000) {
    analysisRateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 240;
}

function parseAnalysisHistory(value) {
  if (!Array.isArray(value) || !value.length || value.length > 300) {
    throw new RequestError(400, "Analysis contains an invalid move list.");
  }
  const board = new Chess();
  const history = [];
  const fensBefore = [];
  const fensAfter = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new RequestError(400, "Analysis contains an invalid move.");
    }
    const from = parseUciMove(`${item.from}${item.to}${item.promotion ?? ""}`);
    fensBefore.push(board.fen());
    try {
      const move = board.move({
        from: from.slice(0, 2),
        to: from.slice(2, 4),
        promotion: from[4] || "q",
      });
      if (!move) throw new Error("Illegal move");
      history.push(move);
      fensAfter.push(board.fen());
    } catch {
      throw new RequestError(400, "Analysis contains an illegal move.");
    }
  }
  return { history, fensBefore, fensAfter };
}

function liveTableForGame(gameId) {
  for (const table of tables.values()) {
    if (table.gameId === gameId) return table;
  }
  return null;
}

function matchesTableHistory(table, history, ply) {
  const accepted = table.chess.history({ verbose: true });
  if (history.length > accepted.length || !accepted[ply - 1]) return false;
  return history.slice(0, ply).every((move, index) => {
    const existing = accepted[index];
    return (
      existing.from === move.from &&
      existing.to === move.to &&
      (existing.promotion ?? "") === (move.promotion ?? "")
    );
  });
}

function cacheAnalysis(key, analysis) {
  if (analysisCache.size >= 1_000) {
    const oldest = analysisCache.keys().next().value;
    if (oldest) analysisCache.delete(oldest);
  }
  analysisCache.set(key, analysis);
}

function persistMoveAnalysis(gameId, ply, analysis) {
  Promise.resolve()
    .then(() => gameStore.saveMoveAnalysis(gameId, ply, analysis))
    .catch((error) => console.error(`Saving analysis for game ${gameId} failed:`, error));
}

async function handleMoveAnalysisRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let body;
  let replay;
  let ply;
  let gameId;
  try {
    body = await readJsonBody(req, 32_768);
    gameId = typeof body.gameId === "string" ? body.gameId : "";
    ply = Number(body.ply);
    if (!gameId || gameId.length > 100 || !Number.isInteger(ply) || ply < 1) {
      throw new RequestError(400, "Analysis contains an invalid game move.");
    }
    replay = parseAnalysisHistory(body.history);
    if (ply > replay.history.length) {
      throw new RequestError(400, "Analysis contains an invalid move number.");
    }
  } catch (error) {
    sendJson(res, error instanceof RequestError ? error.status : 400, {
      error: error instanceof Error ? error.message : "Invalid request.",
    });
    return;
  }

  const table = liveTableForGame(gameId);
  if (table && !matchesTableHistory(table, replay.history, ply)) {
    sendJson(res, 409, { error: "The game changed before analysis could begin." });
    return;
  }
  if (table?.moveAnalyses.has(ply)) {
    sendJson(res, 200, { analysis: table.moveAnalyses.get(ply), cached: true });
    return;
  }

  const move = replay.history[ply - 1];
  const fenBefore = replay.fensBefore[ply - 1];
  const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
  let storedMove = table ? null : await gameStore.getMoveAnalysis(gameId, ply).catch(() => null);
  if (storedMove && `${storedMove.from}${storedMove.to}${storedMove.promotion ?? ""}` !== uci) {
    storedMove = null;
  }
  if (storedMove?.analysis) {
    sendJson(res, 200, { analysis: storedMove.analysis, cached: true });
    return;
  }
  const previousLoss = table?.moveReviewLosses.get(ply - 1) ?? null;
  const cacheKey = createHash("sha256")
    .update(JSON.stringify({ fenBefore, uci, previousLoss }))
    .digest("hex");
  const cached = analysisCache.get(cacheKey);
  let job = cached ? Promise.resolve({ analysis: cached, review: null }) : analysisJobs.get(cacheKey);
  if (!job) {
    if (!consumeAnalysisRateLimit(req)) {
      sendJson(res, 429, { error: "Too many analysis requests. Try again shortly." });
      return;
    }
    job = (async () => {
      const review = await stockfish.reviewMove(fenBefore, uci);
      const analysis = classifyServerMove(
        review,
        fenBefore,
        move,
        previousLoss === null ? null : { loss: previousLoss },
      );
      if (isOpeningPosition(replay.fensAfter[ply - 1])) {
        analysis.grade = "book";
        analysis.expectedPointsLoss = null;
      }
      return {
        analysis,
        review,
      };
    })();
    analysisJobs.set(cacheKey, job);
    void job.finally(() => analysisJobs.delete(cacheKey));
  }

  try {
    const { analysis, review } = await job;
    if (!cached) cacheAnalysis(cacheKey, analysis);
    if (table && matchesTableHistory(table, replay.history, ply)) {
      table.moveAnalyses.set(ply, analysis);
      if (review) table.moveReviewLosses.set(ply, review.loss);
      else if (analysis.expectedPointsLoss !== null)
        table.moveReviewLosses.set(ply, analysis.expectedPointsLoss);
      recordMoveGrade(table, ply, analysis);
    }
    if ((table && matchesTableHistory(table, replay.history, ply)) || storedMove) {
      persistMoveAnalysis(gameId, ply, analysis);
    }
    sendJson(res, 200, { analysis, cached: Boolean(cached) });
  } catch (error) {
    console.error("Stockfish move analysis failed:", error);
    sendJson(res, 503, { error: "Move analysis is temporarily unavailable." });
  }
}

async function handleBestMoveRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  if (!consumeAnalysisRateLimit(req)) {
    sendJson(res, 429, { error: "Too many analysis requests. Try again shortly." });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const fen = typeof body.fen === "string" && body.fen.length <= 120 ? body.fen : "";
    new Chess(fen);
    const [best] = await stockfish.search(fen, 1);
    sendJson(res, 200, { move: best.move });
  } catch (error) {
    console.error("Stockfish hint failed:", error);
    sendJson(res, 503, { error: "The engine is temporarily unavailable." });
  }
}

async function handleBotMove(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  if (!consumeAnalysisRateLimit(req)) {
    sendJson(res, 429, { error: "Too many analysis requests. Try again shortly." });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const fen = typeof body.fen === "string" && body.fen.length <= 120 ? body.fen : "";
    new Chess(fen);
    const elo = Math.min(2800, Math.max(800, Number(body.elo) || 1500));
    sendJson(res, 200, { move: await pickMaiaMove(fen, elo) });
  } catch (error) {
    console.error("Bot hint failed:", error);
    sendJson(res, 503, { error: "The bot is temporarily unavailable." });
  }
}

function cacheExplanation(key, value) {
  if (explanationCache.size >= 500) {
    const oldest = explanationCache.keys().next().value;
    if (oldest) explanationCache.delete(oldest);
  }
  explanationCache.set(key, value);
}

class OpenRouterError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.statusCode = options.statusCode ?? null;
    this.errorType = options.errorType ?? null;
    this.provider = options.provider ?? null;
    this.retryAfterMs = options.retryAfterMs ?? 0;
    this.retryable = options.retryable ?? false;
  }
}

function openRouterErrorFromResponse(response, data) {
  const choiceError = data?.choices?.[0]?.error;
  const error = data?.error ?? choiceError;
  const statusCode = Number(error?.code) || response.status;
  const errorType = error?.metadata?.error_type || null;
  const message =
    typeof error?.message === "string"
      ? error.message.slice(0, 240)
      : `OpenRouter returned ${statusCode}`;
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  const retryable =
    [408, 429, 500, 502, 503, 504].includes(statusCode) ||
    [
      "rate_limit_exceeded",
      "provider_overloaded",
      "provider_unavailable",
      "timeout",
      "server",
    ].includes(errorType);
  return new OpenRouterError(message, {
    statusCode,
    errorType,
    provider: data?.provider ?? null,
    retryAfterMs: Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : 0,
    retryable,
  });
}

function parseOpenRouterExplanation(response, data) {
  if (!response.ok || data?.error || data?.choices?.[0]?.error) {
    throw openRouterErrorFromResponse(response, data);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const finishReason = data?.choices?.[0]?.finish_reason;
    const reasoningTokens =
      data?.usage?.completion_tokens_details?.reasoning_tokens ??
      data?.usage?.reasoning_tokens;
    const details = [
      finishReason ? `finish=${finishReason}` : null,
      Number.isFinite(reasoningTokens)
        ? `reasoning_tokens=${reasoningTokens}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    throw new OpenRouterError(
      `OpenRouter returned no explanation${details ? ` (${details})` : ""}`,
      {
        statusCode: response.status,
        provider: data?.provider ?? null,
        errorType: "empty_response",
        retryable: true,
      },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new OpenRouterError("OpenRouter returned invalid JSON", {
      statusCode: response.status,
      provider: data?.provider ?? null,
      errorType: "invalid_json",
      retryable: true,
    });
  }
  const motif = typeof parsed?.motif === "string" ? parsed.motif : "";
  const explanation =
    typeof parsed?.explanation === "string" ? parsed.explanation.trim() : "";
  if (
    !EXPLANATION_MOTIFS.has(motif) ||
    !explanation ||
    explanation.length > 400
  ) {
    throw new OpenRouterError("OpenRouter returned an invalid explanation", {
      statusCode: response.status,
      provider: data?.provider ?? null,
      errorType: "invalid_output",
      retryable: true,
    });
  }
  return {
    motif,
    explanation,
    provider: data?.provider ?? null,
    model: data?.model ?? OPENROUTER_MODEL,
    responseId: data?.id ?? null,
    responseText: content,
    finishReason: data?.choices?.[0]?.finish_reason ?? null,
    usage: {
      inputTokens: Number.isFinite(data?.usage?.prompt_tokens)
        ? data.usage.prompt_tokens
        : null,
      outputTokens: Number.isFinite(data?.usage?.completion_tokens)
        ? data.usage.completion_tokens
        : null,
      totalTokens: Number.isFinite(data?.usage?.total_tokens)
        ? data.usage.total_tokens
        : null,
    },
  };
}

function setTokenUsage(span, usage) {
  if (usage.inputTokens !== null) {
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  }
  if (usage.outputTokens !== null) {
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  }
  if (usage.totalTokens !== null) {
    span.setAttribute("gen_ai.usage.total_tokens", usage.totalTokens);
  }
}

function sentryTextMessage(role, content) {
  return { role, parts: [{ type: "text", content }] };
}

async function callOpenRouter(facts, requestId) {
  const body = {
    model: OPENROUTER_MODEL,
    ...(OPENROUTER_FALLBACK_MODELS.length
      ? { models: OPENROUTER_FALLBACK_MODELS }
      : {}),
    messages: [
      {
        role: "system",
        content: MOVE_COACH_SYSTEM_INSTRUCTIONS,
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
              description:
                "At most three short sentences supported by the engine lines; shorter is better.",
            },
          },
          required: ["motif", "explanation"],
          additionalProperties: false,
        },
      },
    },
    plugins: [{ id: "response-healing" }],
    reasoning: { enabled: false },
    provider: {
      require_parameters: true,
      data_collection: "deny",
      ...(process.env.OPENROUTER_ZDR === "true" ? { zdr: true } : {}),
    },
    max_tokens: 180,
  };

  let lastError;
  for (let attempt = 1; attempt <= OPENROUTER_MAX_ATTEMPTS; attempt++) {
    Sentry.logger.info("openrouter.request.started", {
      request_id: requestId,
      attempt,
      model: OPENROUTER_MODEL,
    });
    try {
      return await Sentry.startSpan(
        {
          name: `chat ${OPENROUTER_MODEL}`,
          op: "gen_ai.chat",
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "openrouter",
            "gen_ai.request.model": OPENROUTER_MODEL,
            "gen_ai.agent.name": MOVE_COACH_AGENT_NAME,
            "gen_ai.request.max_tokens": body.max_tokens,
            "gen_ai.system_instructions": body.messages[0].content,
            "gen_ai.input.messages": JSON.stringify([
              sentryTextMessage("user", body.messages[1].content),
            ]),
            "gen_ai.conversation.id": requestId,
            "sentry.origin": MOVE_COACH_SPAN_ORIGIN,
            "server.address": "openrouter.ai",
            "pawn_patrol.agent.attempt": attempt,
          },
        },
        async (span) => {
          try {
            const response = await fetch(OPENROUTER_URL, {
              method: "POST",
              signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
              headers: {
                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer":
                  process.env.APP_URL || "https://pawn-patrol.example",
                "X-OpenRouter-Title": "Pawn Patrol",
                "X-OpenRouter-Metadata": "enabled",
              },
              body: JSON.stringify(body),
            });
            const data = await response.json().catch(() => ({}));
            const result = parseOpenRouterExplanation(response, data);
            span.setAttributes({
              "gen_ai.response.model": result.model,
              "gen_ai.output.messages": JSON.stringify([
                sentryTextMessage("assistant", result.responseText),
              ]),
              "http.response.status_code": response.status,
            });
            if (result.responseId)
              span.setAttribute("gen_ai.response.id", result.responseId);
            if (result.finishReason) {
              span.setAttribute(
                "gen_ai.response.finish_reasons",
                JSON.stringify([result.finishReason]),
              );
            }
            if (result.provider)
              span.setAttribute("openrouter.provider.name", result.provider);
            setTokenUsage(span, result.usage);
            return { ...result, attempts: attempt };
          } catch (error) {
            const normalized =
              error instanceof OpenRouterError
                ? error
                : new OpenRouterError(
                    error?.name === "TimeoutError"
                      ? `Timed out after ${OPENROUTER_TIMEOUT_MS}ms`
                      : String(error?.message || error),
                    {
                      errorType:
                        error?.name === "TimeoutError" ? "timeout" : "network",
                      retryable: true,
                    },
                  );
            span.setStatus({
              code: SENTRY_SPAN_STATUS_ERROR,
              message: normalized.errorType || "internal_error",
            });
            span.setAttribute("error.type", normalized.errorType || "unknown");
            if (normalized.statusCode !== null) {
              span.setAttribute(
                "http.response.status_code",
                normalized.statusCode,
              );
            }
            if (normalized.provider)
              span.setAttribute(
                "openrouter.provider.name",
                normalized.provider,
              );
            throw normalized;
          }
        },
      );
    } catch (error) {
      lastError = error;
      Sentry.logger.warn("openrouter.request.attempt_failed", {
        request_id: requestId,
        attempt,
        status_code: error.statusCode,
        error_type: error.errorType,
        provider: error.provider,
      });
      if (!error.retryable || attempt === OPENROUTER_MAX_ATTEMPTS) break;
      const delayMs =
        error.retryAfterMs > 0
          ? Math.min(error.retryAfterMs, 10_000)
          : 600 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function runMoveCoach(facts, requestId) {
  return Sentry.withIsolationScope(async (isolationScope) => {
    isolationScope.setConversationId(requestId);
    return Sentry.startSpan(
      {
        name: `invoke_agent ${MOVE_COACH_AGENT_NAME}`,
        op: "gen_ai.invoke_agent",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": MOVE_COACH_AGENT_NAME,
          "gen_ai.provider.name": "openrouter",
          "gen_ai.request.model": OPENROUTER_MODEL,
          "gen_ai.system_instructions": MOVE_COACH_SYSTEM_INSTRUCTIONS,
          "gen_ai.input.messages": JSON.stringify([
            sentryTextMessage("user", JSON.stringify(facts)),
          ]),
          "gen_ai.conversation.id": requestId,
          "sentry.origin": MOVE_COACH_SPAN_ORIGIN,
        },
      },
      async (span) => {
        try {
          const result = await callOpenRouter(facts, requestId);
          span.setAttributes({
            "gen_ai.response.model": result.model,
            "gen_ai.output.messages": JSON.stringify([
              sentryTextMessage("assistant", result.explanation),
            ]),
          });
          if (result.responseId)
            span.setAttribute("gen_ai.response.id", result.responseId);
          setTokenUsage(span, result.usage);
          return result;
        } catch (error) {
          span.setStatus({
            code: SENTRY_SPAN_STATUS_ERROR,
            message: error.errorType || "internal_error",
          });
          span.setAttribute("error.type", error.errorType || "unknown");
          Sentry.captureException(error, {
            mechanism: { handled: true, type: MOVE_COACH_SPAN_ORIGIN },
            tags: { "gen_ai.agent.name": MOVE_COACH_AGENT_NAME },
          });
          throw error;
        }
      },
    );
  });
}

async function handleMoveExplanationRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  if (!consumeExplanationRateLimit(req)) {
    sendJson(res, 429, {
      error: "Too many explanation requests. Try again shortly.",
    });
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
    playedMove: analysis.playedLineDescription[0],
    playedLine: analysis.playedLineDescription,
    bestMove: analysis.bestLineDescription[0],
    bestLine: analysis.bestLineDescription,
    expectedPointsBefore: analysis.bestExpectedPoints,
    expectedPointsAfter: analysis.playedExpectedPoints,
  };
  const cacheKey = createHash("sha256")
    .update(JSON.stringify(facts))
    .digest("hex");
  const cached = explanationCache.get(cacheKey);
  if (cached) {
    sendJson(res, 200, {
      ...lines,
      ...cached,
      cached: true,
      requestId: randomUUID().slice(0, 8),
    });
    return;
  }

  const requestId = randomUUID().slice(0, 8);
  try {
    const result = await runMoveCoach(facts, requestId);
    const explanation = {
      motif: result.motif,
      explanation: result.explanation,
    };
    cacheExplanation(cacheKey, explanation);
    Sentry.logger.info("openrouter.request.succeeded", {
      request_id: requestId,
      attempts: result.attempts,
      model: result.model,
      provider: result.provider,
      response_id: result.responseId,
    });
    sendJson(res, 200, { ...lines, ...explanation, cached: false, requestId });
  } catch (error) {
    console.error("OpenRouter move explanation failed:", {
      requestId,
      statusCode: error?.statusCode ?? null,
      errorType: error?.errorType ?? "unknown",
      provider: error?.provider ?? null,
      message: String(error?.message || "Unknown OpenRouter error").slice(
        0,
        240,
      ),
    });
    sendJson(res, 502, {
      ...lines,
      requestId,
      error:
        "The AI explanation is unavailable; the verified engine lines are shown instead.",
    });
  }
}

const authRateLimits = new Map();

function consumeAuthRateLimit(req) {
  const key = clientAddress(req);
  const now = Date.now();
  const existing = authRateLimits.get(key);
  if (!existing || now - existing.startedAt >= 10 * 60 * 1000) {
    authRateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 30;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(hash, "hex"));
}

function publicUser(user) {
  return {
    username: user.username,
    rating: user.rating,
    ratedGames: user.ratedGames,
    wins: user.wins,
    losses: user.losses,
    draws: user.draws,
  };
}

function bearerToken(req, url) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).slice(0, 64);
  return (url.searchParams.get("token") || "").slice(0, 64);
}

async function handleAuthRequest(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const token = bearerToken(req, url);
      const user = token ? await gameStore.getSessionUser(token) : null;
      if (!user) sendJson(res, 401, { error: "Not signed in." });
      else sendJson(res, 200, { user: publicUser(user) });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }
    if (url.pathname === "/api/auth/logout") {
      const token = bearerToken(req, url);
      if (token) await gameStore.deleteSession(token);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!consumeAuthRateLimit(req)) {
      sendJson(res, 429, { error: "Too many attempts. Try again shortly." });
      return;
    }
    const body = await readJsonBody(req);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/.test(username)) {
      sendJson(res, 400, {
        error: "Names are 3-20 letters, digits, dashes, or underscores.",
      });
      return;
    }
    if (password.length < 6 || password.length > 100) {
      sendJson(res, 400, { error: "Passwords need at least 6 characters." });
      return;
    }
    let user = null;
    if (url.pathname === "/api/auth/register") {
      user = await gameStore.createUser({
        id: randomUUID(),
        username,
        passwordHash: hashPassword(password),
      });
      if (!user) {
        sendJson(res, 409, { error: "That name is already taken." });
        return;
      }
    } else if (url.pathname === "/api/auth/login") {
      const existing = await gameStore.getUserByUsername(username);
      if (!existing || !verifyPassword(password, existing.passwordHash)) {
        sendJson(res, 401, { error: "Wrong name or password." });
        return;
      }
      user = existing;
    } else {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const token = randomBytes(32).toString("hex").slice(0, 64);
    await gameStore.createSession(token, user.id);
    sendJson(res, 200, { token, user: publicUser(user) });
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    console.error("Auth request failed:", error);
    sendJson(res, 500, { error: "Sign-in is unavailable right now." });
  }
}

async function handleLeaderboardRequest(req, res, url) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    const players = await gameStore.listLeaderboard(
      url.searchParams.get("limit") ?? 50,
    );
    sendJson(res, 200, { players: players.map(publicUser) });
  } catch (error) {
    console.error("Leaderboard request failed:", error);
    sendJson(res, 500, { error: "Failed to load the leaderboard" });
  }
}

function handleGamesRequest(req, res, url) {
  if (req.method !== "GET") return false;
  const playerKey = (url.searchParams.get("playerKey") || "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 64);
  if (url.pathname === "/api/games") {
    void (async () => {
      const token = bearerToken(req, url);
      const user = token ? await gameStore.getSessionUser(token) : null;
      sendJson(res, 200, {
        games: user
          ? await gameStore.listGamesForUser(
              user.id,
              url.searchParams.get("limit") ?? 20,
            )
          : await gameStore.listGames(
              playerKey,
              url.searchParams.get("limit") ?? 20,
            ),
      });
    })().catch((error) => {
      console.error("Game list request failed:", error);
      sendJson(res, 500, { error: "Failed to load games" });
    });
    return true;
  }
  const match = url.pathname.match(/^\/api\/games\/([^/]+)$/);
  if (!match) return false;
  void (async () => {
    const gameId = decodeURIComponent(match[1]);
    const token = bearerToken(req, url);
    const user = token ? await gameStore.getSessionUser(token) : null;
    const ownedGame = user
      ? await gameStore.getGameForUser(gameId, user.id)
      : playerKey
        ? await gameStore.getGame(gameId, playerKey)
        : null;
    const game = ownedGame ?? (await gameStore.getSharedGame(gameId));
    sendJson(res, game ? 200 : 404, game ?? { error: "Game not found" });
  })().catch((error) => {
    console.error("Game detail request failed:", error);
    sendJson(res, 500, { error: "Failed to load game" });
  });
  return true;
}

async function sentryApiResponse(
  path,
  options = {},
  baseUrl = "https://sentry.io/api/0",
) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SEER_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  const responseText = await response.text();
  if (!response.ok) {
    let detail = responseText;
    try {
      const payload = JSON.parse(responseText);
      detail = payload.detail ?? payload.error ?? responseText;
    } catch {
      detail = responseText;
    }
    const error = new Error(
      `Sentry API ${response.status}: ${String(detail).slice(0, 500)}`,
    );
    error.statusCode = response.status;
    throw error;
  }
  return {
    body: responseText ? JSON.parse(responseText) : null,
    headers: response.headers,
  };
}

async function sentryApi(
  path,
  options = {},
  baseUrl = "https://sentry.io/api/0",
) {
  return (await sentryApiResponse(path, options, baseUrl)).body;
}

function sentryDataApi(path, options) {
  return sentryApi(path, options, SENTRY_DATA_API_BASE);
}

const exploreRateLimits = new Map();
const EXPLORE_GAME_FIELDS = {
  timestamp: "timestamp",
  gameId: "tags[chess.game.id,string]",
  opening: "tags[chess.opening.name,string]",
  family: "tags[chess.opening.family,string]",
  color: "tags[chess.player.color,string]",
  outcome: "tags[chess.player.outcome,string]",
  blunders: "tags[chess.player.blunders,number]",
  mistakes: "tags[chess.player.mistakes,number]",
  inaccuracies: "tags[chess.player.inaccuracies,number]",
  expectedPointsLoss: "tags[chess.player.expected_points_loss,number]",
};
const EXPLORE_GRADE_FIELDS = {
  timestamp: "timestamp",
  gameId: "tags[chess.game.id,string]",
  opening: "tags[chess.opening.name,string]",
  family: "tags[chess.opening.family,string]",
  color: "tags[chess.move.color,string]",
  ply: "tags[chess.move.ply,number]",
  san: "tags[chess.move.san,string]",
  grade: "tags[chess.move.grade,string]",
  expectedPointsLoss: "tags[chess.move.expected_points_loss,number]",
};

const EXPLORE_COUNT_FIELDS = {
  gameId: "tags[chess.game.id,string]",
  grade: "tags[chess.move.grade,string]",
  count: "count()",
  avgLoss: "avg(tags[chess.move.expected_points_loss,number])",
};

function consumeExploreRateLimit(req) {
  const key = clientAddress(req);
  const now = Date.now();
  const existing = exploreRateLimits.get(key);
  if (!existing || now - existing.startedAt >= 10 * 60 * 1000) {
    exploreRateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 20;
}

function quoteSentrySearch(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function explorePlan(question) {
  const normalized = question.toLowerCase();
  const opening = findOpeningMention(question);
  const against = /\bagainst\b/.test(normalized);
  let color = null;
  if (/\b(as|with|playing)\s+white\b/.test(normalized)) color = "white";
  if (/\b(as|with|playing)\s+black\b/.test(normalized)) color = "black";
  if (!color && opening && against) {
    color = opening.side === "white" ? "black" : "white";
  }
  const strongest =
    /\b(strongest|best|highest(?:\s|-)?scoring|most successful)\b/.test(
      normalized,
    ) || /\b(win the most|most wins|winningest)\b/.test(normalized);
  return { opening, color, against, strongest };
}

function numericField(row, field) {
  const value = Number(row?.[field]);
  return Number.isFinite(value) ? value : 0;
}

function outcomePoints(outcome) {
  if (outcome === "win") return 1;
  if (outcome === "draw") return 0.5;
  return 0;
}

function summarizeExploreRows(rows) {
  const groups = new Map();
  let total = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let score = 0;
  let blunders = 0;
  let mistakes = 0;
  let inaccuracies = 0;
  let expectedPointsLoss = 0;
  let gradedGames = 0;
  for (const row of rows) {
    const games = 1;
    const hasGradeData = row.__hasGradeData !== false;
    const outcome = row[EXPLORE_GAME_FIELDS.outcome];
    const family = row[EXPLORE_GAME_FIELDS.family] || "Unknown opening";
    const values = {
      score: outcomePoints(outcome),
      blunders: numericField(row, EXPLORE_GAME_FIELDS.blunders),
      mistakes: numericField(row, EXPLORE_GAME_FIELDS.mistakes),
      inaccuracies: numericField(row, EXPLORE_GAME_FIELDS.inaccuracies),
      expectedPointsLoss: numericField(
        row,
        EXPLORE_GAME_FIELDS.expectedPointsLoss,
      ),
    };
    total += games;
    if (outcome === "win") wins += games;
    else if (outcome === "loss") losses += games;
    else if (outcome === "draw") draws += games;
    score += values.score * games;
    if (hasGradeData) {
      gradedGames += games;
      blunders += values.blunders * games;
      mistakes += values.mistakes * games;
      inaccuracies += values.inaccuracies * games;
      expectedPointsLoss += values.expectedPointsLoss * games;
    }
    const group = groups.get(family) ?? {
      opening: family,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      score: 0,
      blunders: 0,
      gradedGames: 0,
    };
    group.games += games;
    group.wins += outcome === "win" ? games : 0;
    group.losses += outcome === "loss" ? games : 0;
    group.draws += outcome === "draw" ? games : 0;
    group.score += values.score * games;
    if (hasGradeData) {
      group.blunders += values.blunders * games;
      group.gradedGames += games;
    }
    groups.set(family, group);
  }
  const average = (value) => (total ? value / total : 0);
  const breakdown = [...groups.values()]
    .map((group) => ({
      opening: group.opening,
      games: group.games,
      wins: group.wins,
      losses: group.losses,
      draws: group.draws,
      scorePercent: group.games ? (group.score / group.games) * 100 : 0,
      avgBlunders: group.gradedGames
        ? group.blunders / group.gradedGames
        : 0,
    }))
    .sort((left, right) => right.games - left.games)
    .slice(0, 20);
  return {
    total,
    wins,
    losses,
    draws,
    scorePercent: average(score) * 100,
    gradedGames,
    avgBlunders: gradedGames ? blunders / gradedGames : 0,
    avgMistakes: gradedGames ? mistakes / gradedGames : 0,
    avgInaccuracies: gradedGames ? inaccuracies / gradedGames : 0,
    avgExpectedPointsLoss: gradedGames
      ? expectedPointsLoss / gradedGames
      : 0,
    breakdown,
  };
}

function exploreLogRows(rows, gamesById = new Map()) {
  return rows.map((row) => ({
    timestamp: row[EXPLORE_GRADE_FIELDS.timestamp] ?? null,
    gameId: row[EXPLORE_GRADE_FIELDS.gameId] ?? null,
    opening:
      row[EXPLORE_GRADE_FIELDS.opening] ??
      row[EXPLORE_GRADE_FIELDS.family] ??
      gamesById.get(row[EXPLORE_GRADE_FIELDS.gameId])?.opening?.name ??
      "Unknown opening",
    color: row[EXPLORE_GRADE_FIELDS.color] ?? null,
    ply: numericField(row, EXPLORE_GRADE_FIELDS.ply),
    san: row[EXPLORE_GRADE_FIELDS.san] ?? null,
    grade: row[EXPLORE_GRADE_FIELDS.grade] ?? null,
    expectedPointsLoss: numericField(
      row,
      EXPLORE_GRADE_FIELDS.expectedPointsLoss,
    ),
  }));
}

function exploreGameRows(rows, gradeCountRows) {
  const countsByGame = new Map();
  for (const row of gradeCountRows) {
    const gameId = row[EXPLORE_COUNT_FIELDS.gameId];
    if (!gameId) continue;
    const buckets = countsByGame.get(gameId) ?? [];
    buckets.push({
      grade: row[EXPLORE_COUNT_FIELDS.grade],
      count: numericField(row, EXPLORE_COUNT_FIELDS.count),
      avgLoss: numericField(row, EXPLORE_COUNT_FIELDS.avgLoss),
    });
    countsByGame.set(gameId, buckets);
  }
  return rows.flatMap((row) => {
    const gameId = row[EXPLORE_GAME_FIELDS.gameId];
    const outcome = row[EXPLORE_GAME_FIELDS.outcome];
    if (!gameId || !["win", "loss", "draw"].includes(outcome)) return [];
    const buckets = countsByGame.get(gameId) ?? [];
    const gradeCount = (name) =>
      buckets
        .filter((bucket) => bucket.grade === name)
        .reduce((sum, bucket) => sum + bucket.count, 0);
    const gradedMoves = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    const lossSum = buckets.reduce(
      (sum, bucket) => sum + bucket.avgLoss * bucket.count,
      0,
    );
    return [
      {
        [EXPLORE_GAME_FIELDS.timestamp]:
          row[EXPLORE_GAME_FIELDS.timestamp] ?? null,
        [EXPLORE_GAME_FIELDS.gameId]: gameId,
        [EXPLORE_GAME_FIELDS.opening]:
          row[EXPLORE_GAME_FIELDS.opening] ?? "Unknown opening",
        [EXPLORE_GAME_FIELDS.family]:
          row[EXPLORE_GAME_FIELDS.family] ?? "Unknown opening",
        [EXPLORE_GAME_FIELDS.color]: row[EXPLORE_GAME_FIELDS.color] ?? null,
        [EXPLORE_GAME_FIELDS.outcome]: outcome,
        [EXPLORE_GAME_FIELDS.blunders]: gradeCount("blunder"),
        [EXPLORE_GAME_FIELDS.mistakes]: gradeCount("mistake"),
        [EXPLORE_GAME_FIELDS.inaccuracies]: gradeCount("inaccuracy"),
        [EXPLORE_GAME_FIELDS.expectedPointsLoss]: gradedMoves
          ? lossSum / gradedMoves
          : 0,
        __hasGradeData: buckets.length > 0,
      },
    ];
  });
}

function exploreAnswer(summary, plan) {
  if (!summary.total) {
    return "I couldn't find any fully analyzed games matching that question yet. Finish a game and allow its Stockfish review to complete, then try again after Sentry has indexed the logs.";
  }
  const subject = plan.opening
    ? `${plan.against ? "against " : "in "}${plan.opening.family}${plan.color ? ` as ${plan.color === "white" ? "White" : "Black"}` : ""}`
    : plan.color
      ? `as ${plan.color === "white" ? "White" : "Black"}`
      : "across all openings";
  const record = `${summary.wins}–${summary.losses}–${summary.draws}`;
  let answer = `Over the last 30 days, you earned ${summary.scorePercent.toFixed(0)}% of available points ${subject} across ${summary.total} game${summary.total === 1 ? "" : "s"} (${record}).`;
  if (summary.gradedGames) {
    answer += ` Across ${summary.gradedGames} game${summary.gradedGames === 1 ? "" : "s"} with matching Sentry grade logs, you averaged ${summary.avgBlunders.toFixed(1)} blunders and ${summary.avgMistakes.toFixed(1)} mistakes.`;
  }
  if (!plan.opening && summary.breakdown.length > 1) {
    const eligible = summary.breakdown.filter((item) => item.games >= 2);
    const candidates = eligible.length ? eligible : summary.breakdown;
    const comparison = [...candidates].sort((left, right) => {
      if (plan.strongest) {
        return (
          right.wins - left.wins ||
          right.scorePercent - left.scorePercent ||
          right.games - left.games
        );
      }
      return left.scorePercent - right.scorePercent;
    })[0];
    answer += plan.strongest
      ? ` Your strongest opening family is ${comparison.opening}, with ${comparison.wins} win${comparison.wins === 1 ? "" : "s"} from ${comparison.games} game${comparison.games === 1 ? "" : "s"} (${comparison.scorePercent.toFixed(0)}% score from wins and draws).`
      : ` Your lowest-scoring opening family is ${comparison.opening} at ${comparison.scorePercent.toFixed(0)}% across ${comparison.games} game${comparison.games === 1 ? "" : "s"}.`;
  }
  return answer;
}

async function handleExploreRequest(req, res, url) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  if (!SEER_TOKEN) {
    sendJson(res, 503, { error: "Sentry Explore is not configured." });
    return;
  }
  if (!consumeExploreRateLimit(req)) {
    sendJson(res, 429, { error: "Too many questions. Try again shortly." });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const question =
      typeof body?.question === "string" ? body.question.trim().slice(0, 240) : "";
    if (question.length < 3) {
      sendJson(res, 400, { error: "Ask a question about your games." });
      return;
    }
    const token = bearerToken(req, url);
    const user = token ? await gameStore.getSessionUser(token) : null;
    const playerKey =
      typeof body?.playerKey === "string"
        ? body.playerKey.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64)
        : "";
    if (!user && !playerKey) {
      sendJson(res, 401, {
        error: "Play a game on this device or sign in before exploring your history.",
      });
      return;
    }
    const plan = explorePlan(question);
    const playerId = user
      ? telemetryPlayerId("user", user.id)
      : telemetryPlayerId("player", playerKey);
    const summaryMessage = `message:${quoteSentrySearch("chess.player.game.completed")}`;
    const gradedMessage = `message:${quoteSentrySearch("chess.move.graded")}`;
    const queryLogs = async (query, fields, extra = {}) => {
      const params = new URLSearchParams({
        dataset: "logs",
        project: SENTRY_PROJECT_ID,
        statsPeriod: "30d",
        query,
        per_page: "100",
        ...extra,
      });
      for (const field of fields) params.append("field", field);
      const result = await sentryDataApi(
        `/organizations/${SENTRY_ORG}/events/?${params}`,
      );
      return Array.isArray(result?.data) ? result.data : [];
    };
    const summaryFilters = [summaryMessage, `chess.player.id:${playerId}`];
    if (plan.opening)
      summaryFilters.push(
        `chess.opening.family:${quoteSentrySearch(plan.opening.family)}`,
      );
    if (plan.color) summaryFilters.push(`chess.player.color:${plan.color}`);
    const summaryQuery = summaryFilters.join(" ");
    const summaryRows = await queryLogs(
      summaryQuery,
      Object.values(EXPLORE_GAME_FIELDS),
      { sort: "-timestamp" },
    );
    const gameIds = [
      ...new Set(
        summaryRows
          .map((row) => row[EXPLORE_GAME_FIELDS.gameId])
          .filter(Boolean),
      ),
    ];
    const idsByColor = { white: [], black: [] };
    for (const row of summaryRows) {
      const color = row[EXPLORE_GAME_FIELDS.color];
      const gameId = row[EXPLORE_GAME_FIELDS.gameId];
      if (gameId && (color === "white" || color === "black")) {
        idsByColor[color].push(gameId);
      }
    }
    const countQueries = [];
    for (const [color, ids] of Object.entries(idsByColor)) {
      for (let index = 0; index < ids.length; index += 8) {
        countQueries.push(
          `${gradedMessage} chess.move.color:${color} chess.game.id:[${ids.slice(index, index + 8).join(",")}]`,
        );
      }
    }
    const [gradeCountRows, gradeRows] = await Promise.all([
      Promise.all(
        countQueries.map((query) =>
          queryLogs(query, Object.values(EXPLORE_COUNT_FIELDS)),
        ),
      ).then((results) => results.flat()),
      gameIds.length
        ? queryLogs(
            `${gradedMessage} chess.game.id:[${gameIds.slice(0, 20).join(",")}]`,
            Object.values(EXPLORE_GRADE_FIELDS),
            { sort: "-timestamp" },
          )
        : [],
    ]);
    const gamesById = new Map(
      summaryRows.map((row) => [
        row[EXPLORE_GAME_FIELDS.gameId],
        {
          opening: {
            name: row[EXPLORE_GAME_FIELDS.opening],
            family: row[EXPLORE_GAME_FIELDS.family],
          },
        },
      ]),
    );
    const gameRows = exploreGameRows(summaryRows, gradeCountRows);
    const summary = summarizeExploreRows(gameRows);
    const logs = exploreLogRows(gradeRows, gamesById)
      .sort((left, right) => right.expectedPointsLoss - left.expectedPointsLoss)
      .slice(0, 25);
    sendJson(res, 200, {
      question,
      answer: exploreAnswer(summary, plan),
      summary,
      logs,
      query: summaryQuery,
      period: "30d",
    });
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    console.error("Sentry Explore request failed:", error.message);
    const errorMessage =
      error?.statusCode === 401 || error?.statusCode === 403
        ? "Sentry Explore is missing org:read access."
        : error?.statusCode === 404
          ? "Sentry Explore could not find the configured organization or project."
        : error?.statusCode === 400
          ? "Sentry rejected the generated Logs query."
          : "Sentry Explore could not answer right now.";
    sendJson(res, 502, { error: errorMessage });
  }
}

const SEER_STEP_LABELS = {
  get_issue_details: "Opening the game report",
  get_event_details: "Reading the game event",
  telemetry_live_search: "Searching the match telemetry",
  get_log_attributes: "Pulling the move-by-move logs",
  get_trace_waterfall: "Tracing the game timeline",
};

// Turns the in-progress Seer run into a short human-readable activity feed
// plus any long interim text, which is Seer drafting the review itself.
function extractActivity(autofix) {
  const blocks = Array.isArray(autofix?.blocks) ? autofix.blocks : [];
  const activity = [];
  let draft = null;
  for (const block of blocks) {
    const message = block?.message;
    if (!message || message.role === "user" || block.loading) continue;
    const content =
      typeof message.content === "string" ? message.content.trim() : "";
    if (content.length > 200) draft = content;
    else if (content) activity.push(content);
    for (const link of block.tool_links ?? []) {
      const label = SEER_STEP_LABELS[link?.kind] ?? "Digging deeper";
      if (label !== activity[activity.length - 1]) activity.push(label);
    }
  }
  return { activity: activity.slice(-5), draft };
}

function extractReview(autofix) {
  const blocks = Array.isArray(autofix?.blocks) ? autofix.blocks : [];
  const answers = blocks
    .map((block) => block?.message)
    .filter(
      (m) =>
        m &&
        m.role === "assistant" &&
        typeof m.content === "string" &&
        m.content.trim(),
    );
  return answers.length ? answers[answers.length - 1].content : null;
}

async function handleReviewRequest(req, res, url) {
  if (!SEER_TOKEN) {
    sendJson(res, 503, { error: "Game review is not configured." });
    return;
  }
  try {
    if (req.method === "POST" && url.pathname === "/api/review") {
      const gameId = (url.searchParams.get("gameId") || "")
        .replace(/[^a-zA-Z0-9-]/g, "")
        .slice(0, 64);
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
        sendJson(res, 404, {
          error: "Game not indexed yet. Try again shortly.",
        });
        return;
      }
      const issueId = issues[0].id;
      const existing = await sentryApi(
        `/organizations/${SENTRY_ORG}/issues/${issueId}/autofix/`,
      );
      if (!existing?.autofix || existing.autofix.status === "errored") {
        await sentryApi(
          `/organizations/${SENTRY_ORG}/issues/${issueId}/autofix/?mode=explorer`,
          {
            method: "POST",
            body: JSON.stringify({
              step: "root_cause",
              referrer: "api.web",
              user_context: REVIEW_PROMPT,
            }),
          },
        );
      }
      sendJson(res, 200, { issueId, shortId: issues[0].shortId });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/review/status") {
      const issueId = (url.searchParams.get("issueId") || "").replace(
        /\D/g,
        "",
      );
      if (!issueId) {
        sendJson(res, 400, { error: "issueId is required" });
        return;
      }
      const data = await sentryApi(
        `/organizations/${SENTRY_ORG}/issues/${issueId}/autofix/`,
      );
      const status = data?.autofix?.status ?? "none";
      const { activity, draft } = extractActivity(data?.autofix);
      sendJson(res, 200, {
        status,
        text: extractReview(data?.autofix),
        activity,
        draft,
      });
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
  if (url.pathname.startsWith("/api/auth/")) {
    void handleAuthRequest(req, res, url);
    return;
  }
  if (url.pathname === "/api/leaderboard") {
    void handleLeaderboardRequest(req, res, url);
    return;
  }
  if (url.pathname === "/api/explore") {
    void handleExploreRequest(req, res, url);
    return;
  }
  if (url.pathname === "/api/move-analysis") {
    void handleMoveAnalysisRequest(req, res);
    return;
  }
  if (url.pathname === "/api/best-move") {
    void handleBestMoveRequest(req, res);
    return;
  }
  if (url.pathname === "/api/bot-move") {
    void handleBotMove(req, res);
    return;
  }
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
    wss.handleUpgrade(req, socket, head, (ws) =>
      joinTable(req, ws).catch((error) => {
        console.error("Failed to join table:", error);
        ws.close(1011, "The room could not be joined");
      }),
    );
  } else if (handleNextUpgrade) {
    // Next dev-mode hot reload uses its own WebSocket.
    handleNextUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

loadMaia().catch((error) => console.error("Maia failed to load:", error));
server.listen(port, "0.0.0.0", () => {
  console.log(`Pawn Patrol listening on http://0.0.0.0:${port}`);
});
