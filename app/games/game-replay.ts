import { Chess } from "chess.js";
import type { Key } from "@lichess-org/chessground/types";
import type { ClassifiedMove, ReviewMove } from "../move-analysis";

export type PlayerColor = "w" | "b";

export type SavedGameSummary = {
  id: string;
  room: string;
  players: Record<PlayerColor, string | null>;
  result: string;
  startedAt: number;
  finishedAt: number;
  finalFen: string;
  clock: Record<PlayerColor, number>;
  plyCount: number;
  shareable: boolean;
  playerColor?: PlayerColor | null;
};

export type SavedMove = ReviewMove & {
  fenAfter: string;
  playedAt: number;
  analysis?: ClassifiedMove | null;
};

export type SavedGame = SavedGameSummary & { history: SavedMove[] };

export const START_FEN = new Chess().fen();

export function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatDuration(startedAt: number, finishedAt: number) {
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function formatClock(ms: number) {
  const safe = Math.max(0, ms);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function moveCountLabel(plies: number) {
  const moves = Math.ceil(plies / 2);
  return `${moves} ${moves === 1 ? "move" : "moves"}`;
}

export function playerName(game: SavedGameSummary, color: PlayerColor) {
  return game.players[color] || (color === "w" ? "White" : "Black");
}

export function playerPerspective(game: SavedGameSummary) {
  if (!game.playerColor) return null;

  const color = game.playerColor === "w" ? "White" : "Black";
  if (game.result.toLowerCase().startsWith("draw")) {
    return { color, outcome: "Drew" };
  }

  const winner = game.result.startsWith("White wins")
    ? "w"
    : game.result.startsWith("Black wins")
      ? "b"
      : null;
  if (!winner) return { color, outcome: "Finished" };

  return { color, outcome: winner === game.playerColor ? "Won" : "Lost" };
}

export function resultTone(result: string) {
  return result.toLowerCase().startsWith("draw") ? "draw" : "decisive";
}

export function pairMoves(history: SavedMove[]) {
  return history.reduce<
    Array<{ number: number; w?: SavedMove; b?: SavedMove }>
  >((pairs, move, index) => {
    if (index % 2 === 0)
      pairs.push({ number: Math.floor(index / 2) + 1, w: move });
    else pairs[pairs.length - 1].b = move;
    return pairs;
  }, []);
}

export function replayPosition(game: SavedGame | null, ply: number) {
  const fen =
    ply === 0
      ? START_FEN
      : (game?.history[ply - 1]?.fenAfter ?? game?.finalFen ?? START_FEN);
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    chess = new Chess();
  }
  const move = game?.history[ply - 1];
  return {
    fen,
    chess,
    move,
    lastMove: move
      ? ([move.from as Key, move.to as Key] as Key[])
      : undefined,
  };
}
