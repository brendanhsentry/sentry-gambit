export type BotKey = "levy" | "hikaru" | "magnus" | "grandmaster";

export const BOTS: Record<BotKey, { name: string; elo: number }> = {
  levy: { name: "Garry", elo: 1100 },
  hikaru: { name: "Mikhail", elo: 1500 },
  magnus: { name: "Magnus", elo: 1900 },
  grandmaster: { name: "Bobby", elo: 2200 },
};
