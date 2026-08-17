import type { Metadata } from "next";
import { ChessRoom } from "./ChessRoom";

export const metadata: Metadata = {
  title: "Sentry Gambit — Live chess",
  description: "Start a private chess table, share the code, and play live.",
};

export default function Home() {
  return <ChessRoom />;
}
