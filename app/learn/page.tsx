import type { Metadata } from "next";
import { LearnTrainer } from "./LearnTrainer";

export const metadata: Metadata = {
  title: "Learn openings",
  description: "Drill concrete opening variations, then practice them against Maia.",
};

export default function LearnPage() {
  return <LearnTrainer />;
}
