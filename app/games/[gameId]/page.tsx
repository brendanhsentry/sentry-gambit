import type { Metadata } from "next";
import { SharedGameView } from "./SharedGameView";

export const metadata: Metadata = {
  title: "Game replay",
  description: "Replay a completed Pawn Patrol game.",
  robots: { index: false, follow: false },
};

export default async function SharedGamePage({
  params,
}: {
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = await params;
  return <SharedGameView gameId={gameId} />;
}
