import type { Metadata } from "next";
import { PastGamesView } from "./PastGamesView";

export const metadata: Metadata = {
  title: "Past games — Pawn Patrol",
  description: "Browse completed Pawn Patrol games and their saved move history.",
};

export default function PastGamesPage() {
  return <PastGamesView />;
}
