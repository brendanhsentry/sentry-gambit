import type { Metadata } from "next";
import { PuzzleTrainer } from "./PuzzleTrainer";

export const metadata: Metadata = {
  title: "Chess puzzles",
  description: "Practice tactical chess positions on Pawn Patrol.",
};

export default function PuzzlesPage() {
  return <PuzzleTrainer />;
}
