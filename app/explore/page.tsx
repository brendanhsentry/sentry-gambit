import type { Metadata } from "next";
import { ExploreView } from "./ExploreView";

export const metadata: Metadata = {
  title: "Explore your games — Pawn Patrol",
  description: "Ask questions about your Pawn Patrol game history.",
};

export default function ExplorePage() {
  return <ExploreView />;
}
