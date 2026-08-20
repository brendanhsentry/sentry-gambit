import type { Metadata } from "next";
import { HomeClient } from "./HomeClient";

export const metadata: Metadata = {
  title: "Pawn Patrol — Live chess",
  description: "Start a private chess table, share the code, and play live.",
};

export default function Home() {
  return <HomeClient />;
}
