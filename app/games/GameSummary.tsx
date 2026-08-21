import type { ReviewMove, ClassifiedMove } from "../move-analysis";
import { classifyOpening } from "../opening-book.mjs";

type Side = { accuracy: number | null; mistakes: number; blunders: number };

function sideStats(moves: Array<ClassifiedMove | null>, color: "w" | "b"): Side {
  const own = moves.filter((_, index) => (index % 2 === 0 ? "w" : "b") === color);
  const losses = own.flatMap((move) =>
    move ? [move.expectedPointsLoss ?? 0] : [],
  );
  const accuracy = losses.length
    ? Math.round(100 * (1 - losses.reduce((sum, loss) => sum + loss, 0) / losses.length))
    : null;
  return {
    accuracy,
    mistakes: own.filter((m) => m && (m.grade === "mistake" || m.grade === "inaccuracy" || m.grade === "miss")).length,
    blunders: own.filter((m) => m?.grade === "blunder").length,
  };
}

export function GameSummary({
  history,
  moves,
  players,
  complete,
}: {
  history: ReviewMove[];
  moves: Array<ClassifiedMove | null>;
  players: { w: string | null; b: string | null };
  complete: boolean;
}) {
  if (!history.length) return null;
  const opening = classifyOpening(
    history.map((move) => `${move.from}${move.to}${move.promotion ?? ""}`),
  ) as { name: string } | null;
  const sides = (["w", "b"] as const).map((color) => ({
    color,
    name: players[color] || (color === "w" ? "White" : "Black"),
    ...sideStats(moves, color),
  }));
  return (
    <div className="game-summary" aria-label="Game summary">
      <span>{opening?.name ?? "Game summary"}</span>
      <div className="game-summary-grid">
        {sides.map((side) => (
          <div key={side.color} className="game-summary-side">
            <strong>{side.name}</strong>
            <b>{complete && side.accuracy !== null ? `${side.accuracy}%` : "—"}</b>
            <small>
              {complete
                ? `${side.mistakes} ${side.mistakes === 1 ? "mistake" : "mistakes"} · ${side.blunders} ${side.blunders === 1 ? "blunder" : "blunders"}`
                : "Grading…"}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}
