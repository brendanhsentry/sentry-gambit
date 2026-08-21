import type { Key } from "@lichess-org/chessground/types";
import data from "./lichess-puzzles.json";

export type Difficulty = "Advanced" | "Expert" | "Master";

export type Puzzle = {
  id: string;
  rating: number;
  difficulty: Difficulty;
  themes: string[];
  fen: string;
  lastMove: [Key, Key];
  line: string[];
};

function difficulty(rating: number): Difficulty {
  if (rating >= 2400) return "Master";
  if (rating >= 2100) return "Expert";
  return "Advanced";
}

// Sampled from the CC0 Lichess puzzle database; see scripts/build-puzzles.mjs.
export const PUZZLES: Puzzle[] = (data as Omit<Puzzle, "difficulty">[]).map(
  (puzzle) => ({ ...puzzle, difficulty: difficulty(puzzle.rating) }),
);
