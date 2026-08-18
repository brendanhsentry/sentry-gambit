import type { Metadata } from "next";
import { LeaderboardView } from "./LeaderboardView";

export const metadata: Metadata = {
  title: "Leaderboard — Pawn Patrol",
  description: "Elo ratings for signed-in Pawn Patrol players.",
};

export default function LeaderboardPage() {
  return <LeaderboardView />;
}
