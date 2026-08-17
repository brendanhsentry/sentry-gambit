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
      black_time_ms INTEGER NOT NULL
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

  const statements = {
    insertGame: database.prepare(`
      INSERT OR IGNORE INTO games (
        id, room, started_at, updated_at, final_fen, white_time_ms, black_time_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updatePlayers: database.prepare(`
      UPDATE games SET white_name = ?, black_name = ?, updated_at = ? WHERE id = ?
    `),
    addPlayer: database.prepare(`
      INSERT OR IGNORE INTO game_players (game_id, player_key, color) VALUES (?, ?, ?)
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
    selectGames: database.prepare(`
      SELECT games.id, games.room, games.white_name, games.black_name, games.result,
        games.started_at, games.finished_at, games.final_fen,
        games.white_time_ms, games.black_time_ms, COUNT(moves.ply) AS ply_count
      FROM games LEFT JOIN moves ON moves.game_id = games.id
      WHERE games.status = 'completed' AND EXISTS (
        SELECT 1 FROM game_players
        WHERE game_players.game_id = games.id AND game_players.player_key = ?
      )
      GROUP BY games.id ORDER BY games.finished_at DESC LIMIT ?
    `),
    selectGame: database.prepare(`
      SELECT id, room, white_name, black_name, result, started_at, finished_at,
        final_fen, white_time_ms, black_time_ms
      FROM games WHERE id = ? AND status = 'completed' AND EXISTS (
        SELECT 1 FROM game_players
        WHERE game_players.game_id = games.id AND game_players.player_key = ?
      )
    `),
    selectMoves: database.prepare(`
      SELECT color, san, from_square, to_square, promotion, fen_after, played_at
      FROM moves WHERE game_id = ? ORDER BY ply
    `),
  };

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
    };
  }

  return {
    createGame(game) {
      const now = Date.now();
      statements.insertGame.run(game.id, game.room, now, now, game.fen, game.clock.w, game.clock.b);
    },
    updatePlayers(gameId, players) {
      statements.updatePlayers.run(players.w, players.b, Date.now(), gameId);
    },
    addPlayer(gameId, playerKey, color) {
      statements.addPlayer.run(gameId, playerKey, color);
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
        history: statements.selectMoves.all(gameId).map((move) => ({
          from: move.from_square,
          to: move.to_square,
          san: move.san,
          color: move.color,
          ...(move.promotion ? { promotion: move.promotion } : {}),
          fenAfter: move.fen_after,
          playedAt: move.played_at,
        })),
      };
    },
    close() {
      database.close();
    },
  };
}
