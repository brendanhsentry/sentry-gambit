import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DATABASE_PATH = resolve(
  process.env.DATABASE_PATH || "data/pawn-patrol.sqlite",
);

export function openGameStore(databasePath = DEFAULT_DATABASE_PATH) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      white_name TEXT,
      black_name TEXT,
      result TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      final_fen TEXT NOT NULL,
      white_time_ms INTEGER NOT NULL,
      black_time_ms INTEGER NOT NULL,
      initial_time_ms INTEGER NOT NULL DEFAULT 600000,
      shareable INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS moves (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      ply INTEGER NOT NULL,
      color TEXT NOT NULL,
      san TEXT NOT NULL,
      from_square TEXT NOT NULL,
      to_square TEXT NOT NULL,
      promotion TEXT,
      fen_after TEXT NOT NULL,
      played_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, ply)
    );

    CREATE TABLE IF NOT EXISTS game_players (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_key TEXT NOT NULL,
      color TEXT NOT NULL,
      PRIMARY KEY (game_id, player_key)
    );

    CREATE INDEX IF NOT EXISTS games_finished_at_idx
      ON games(status, finished_at DESC);
    CREATE INDEX IF NOT EXISTS game_players_player_idx
      ON game_players(player_key, game_id);
  `);

  const gameColumns = database.prepare("PRAGMA table_info(games)").all();
  if (!gameColumns.some((column) => column.name === "shareable")) {
    database.exec(
      "ALTER TABLE games ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!gameColumns.some((column) => column.name === "bot_key")) {
    database.exec("ALTER TABLE games ADD COLUMN bot_key TEXT");
    database.exec("ALTER TABLE games ADD COLUMN bot_color TEXT");
  }
  if (!gameColumns.some((column) => column.name === "initial_time_ms")) {
    database.exec(
      "ALTER TABLE games ADD COLUMN initial_time_ms INTEGER NOT NULL DEFAULT 600000",
    );
  }

  const statements = {
    insertGame: database.prepare(`
      INSERT OR IGNORE INTO games (
        id, room, started_at, updated_at, final_fen, white_time_ms, black_time_ms,
        initial_time_ms, shareable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `),
    updatePlayers: database.prepare(`
      UPDATE games SET white_name = ?, black_name = ?, updated_at = ? WHERE id = ?
    `),
    addPlayer: database.prepare(`
      INSERT OR IGNORE INTO game_players (game_id, player_key, color) VALUES (?, ?, ?)
    `),
    setBot: database.prepare(`
      UPDATE games SET bot_key = ?, bot_color = ?, updated_at = ? WHERE id = ?
    `),
    insertMove: database.prepare(`
      INSERT OR REPLACE INTO moves (
        game_id, ply, color, san, from_square, to_square, promotion, fen_after, played_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updatePosition: database.prepare(`
      UPDATE games SET final_fen = ?, white_time_ms = ?, black_time_ms = ?, updated_at = ?
      WHERE id = ?
    `),
    finishGame: database.prepare(`
      UPDATE games SET result = ?, status = 'completed', finished_at = ?, updated_at = ?,
        final_fen = ?, white_time_ms = ?, black_time_ms = ? WHERE id = ?
    `),
    deleteGame: database.prepare("DELETE FROM games WHERE id = ?"),
    deleteMovesFrom: database.prepare(
      "DELETE FROM moves WHERE game_id = ? AND ply >= ?",
    ),
    selectGames: database.prepare(`
      SELECT games.id, games.room, games.white_name, games.black_name, games.result,
        games.started_at, games.finished_at, games.final_fen,
        games.white_time_ms, games.black_time_ms, games.shareable,
        COUNT(moves.ply) AS ply_count
      FROM games LEFT JOIN moves ON moves.game_id = games.id
      WHERE games.status = 'completed' AND EXISTS (
        SELECT 1 FROM game_players
        WHERE game_players.game_id = games.id AND game_players.player_key = ?
      )
      GROUP BY games.id ORDER BY games.finished_at DESC LIMIT ?
    `),
    selectGame: database.prepare(`
      SELECT id, room, white_name, black_name, result, started_at, finished_at,
        final_fen, white_time_ms, black_time_ms, shareable
      FROM games WHERE id = ? AND status = 'completed' AND EXISTS (
        SELECT 1 FROM game_players
        WHERE game_players.game_id = games.id AND game_players.player_key = ?
      )
    `),
    selectSharedGame: database.prepare(`
      SELECT id, room, white_name, black_name, result, started_at, finished_at,
        final_fen, white_time_ms, black_time_ms, shareable
      FROM games
      WHERE id = ? AND status = 'completed' AND shareable = 1
    `),
    selectMoves: database.prepare(`
      SELECT color, san, from_square, to_square, promotion, fen_after, played_at
      FROM moves WHERE game_id = ? ORDER BY ply
    `),
    selectLiveGame: database.prepare(`
      SELECT id, room, white_time_ms, black_time_ms, initial_time_ms,
        bot_key, bot_color
      FROM games WHERE room = ? AND status = 'in_progress' AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 1
    `),
    selectPlayerColors: database.prepare(`
      SELECT player_key, color FROM game_players WHERE game_id = ?
    `),
  };

  function mapMove(move) {
    return {
      from: move.from_square,
      to: move.to_square,
      san: move.san,
      color: move.color,
      ...(move.promotion ? { promotion: move.promotion } : {}),
      fenAfter: move.fen_after,
      playedAt: move.played_at,
    };
  }

  function summary(row) {
    return {
      id: row.id,
      room: row.room,
      players: { w: row.white_name, b: row.black_name },
      result: row.result,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      finalFen: row.final_fen,
      clock: { w: row.white_time_ms, b: row.black_time_ms },
      plyCount: Number(row.ply_count ?? 0),
      shareable: Boolean(row.shareable),
    };
  }

  return {
    createGame(game) {
      const now = Date.now();
      statements.insertGame.run(
        game.id,
        game.room,
        now,
        now,
        game.fen,
        game.clock.w,
        game.clock.b,
        game.initialTimeMs ?? game.clock.w,
      );
    },
    updatePlayers(gameId, players) {
      statements.updatePlayers.run(players.w, players.b, Date.now(), gameId);
    },
    addPlayer(gameId, playerKey, color) {
      statements.addPlayer.run(gameId, playerKey, color);
    },
    setBot(gameId, bot) {
      statements.setBot.run(bot.key, bot.color, Date.now(), gameId);
    },
    recordMove(gameId, ply, move, fen, clock) {
      const now = Date.now();
      database.exec("BEGIN IMMEDIATE");
      try {
        statements.insertMove.run(gameId, ply, move.color, move.san, move.from, move.to, move.promotion ?? null, fen, now);
        statements.updatePosition.run(fen, clock.w, clock.b, now, gameId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    undoMoves(gameId, fromPly, fen, clock) {
      const now = Date.now();
      database.exec("BEGIN IMMEDIATE");
      try {
        statements.deleteMovesFrom.run(gameId, fromPly);
        statements.updatePosition.run(fen, clock.w, clock.b, now, gameId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    finishGame(gameId, result, fen, clock) {
      const now = Date.now();
      statements.finishGame.run(result, now, now, fen, clock.w, clock.b, gameId);
    },
    deleteGame(gameId) {
      statements.deleteGame.run(gameId);
    },
    listGames(playerKey, limit = 20) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
      if (!playerKey) return [];
      return statements.selectGames.all(playerKey, safeLimit).map(summary);
    },
    getGame(gameId, playerKey) {
      if (!playerKey) return null;
      const row = statements.selectGame.get(gameId, playerKey);
      if (!row) return null;
      return {
        ...summary(row),
        history: statements.selectMoves.all(gameId).map(mapMove),
      };
    },
    getSharedGame(gameId) {
      const row = statements.selectSharedGame.get(gameId);
      if (!row) return null;
      return {
        ...summary(row),
        history: statements.selectMoves.all(gameId).map(mapMove),
      };
    },
    getLiveGame(room, maxAgeMs) {
      const row = statements.selectLiveGame.get(room, Date.now() - maxAgeMs);
      if (!row) return null;
      const playerColors = {};
      for (const player of statements.selectPlayerColors.all(row.id)) {
        playerColors[player.player_key] = player.color;
      }
      return {
        id: row.id,
        room: row.room,
        initialTimeMs: row.initial_time_ms,
        clock: { w: row.white_time_ms, b: row.black_time_ms },
        playerColors,
        bot: row.bot_key ? { key: row.bot_key, color: row.bot_color } : null,
        history: statements.selectMoves.all(row.id).map(mapMove),
      };
    },
    close() {
      database.close();
    },
  };
}
