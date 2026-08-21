"use client";

import { type Move, type PieceSymbol } from "chess.js";
import { useEffect, useRef, useState } from "react";

export type ReviewMove = Pick<Move, "from" | "to" | "san" | "color"> & {
  promotion?: PieceSymbol;
};

export type MoveGrade =
  | "brilliant"
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "book"
  | "inaccuracy"
  | "mistake"
  | "miss"
  | "blunder";

export type MoveAnalysisEvidence = {
  fenBefore: string;
  playedMove: string;
  playedLine: string[];
  bestLine: string[];
  bestExpectedPoints: number;
  playedExpectedPoints: number;
};

export type ClassifiedMove = {
  grade: MoveGrade;
  expectedPointsLoss: number | null;
  positionExpectedPoints: number | null;
  evidence: MoveAnalysisEvidence | null;
};

type AnalysisState = {
  moves: Array<ClassifiedMove | null>;
  completed: number;
  status: "idle" | "loading" | "analyzing" | "complete" | "error";
};

type AnalysisCache = {
  gameId: string;
  history: ReviewMove[];
  moves: Array<ClassifiedMove | null>;
};

const GRADE_LABELS: Record<MoveGrade, string> = {
  brilliant: "Brilliant",
  great: "Great",
  best: "Best",
  excellent: "Excellent",
  good: "Good",
  book: "Book",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  miss: "Miss",
  blunder: "Blunder",
};

export function gradeLabel(grade: MoveGrade) {
  return GRADE_LABELS[grade];
}

function uci(move: ReviewMove) {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

async function postForMove(path: string, body: object): Promise<{ move: string }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { move?: string };
  if (!response.ok || !data.move) throw new Error("The engine is unavailable.");
  return { move: data.move };
}

export function engineBestMove(fen: string) {
  return postForMove("/api/best-move", { fen });
}

export function botMove(fen: string, elo: number) {
  return postForMove("/api/bot-move", { fen, elo });
}

export function useMoveAnalysis(
  gameId: string,
  history: ReviewMove[],
  enabled: boolean,
): AnalysisState {
  const [analysis, setAnalysis] = useState<AnalysisState>({
    moves: [],
    completed: 0,
    status: "idle",
  });
  const cacheRef = useRef<AnalysisCache | null>(null);
  const historyKey = JSON.stringify(history);

  useEffect(() => {
    const controller = new AbortController();
    const moves = JSON.parse(historyKey) as ReviewMove[];

    async function run() {
      if (!enabled || !moves.length) {
        setAnalysis({ moves: Array(moves.length).fill(null), completed: 0, status: "idle" });
        return;
      }

      const cached = cacheRef.current;
      let startIndex = 0;
      if (cached?.gameId === gameId) {
        const comparableMoves = Math.min(cached.history.length, moves.length);
        while (
          startIndex < comparableMoves &&
          uci(cached.history[startIndex]) === uci(moves[startIndex])
        ) {
          startIndex += 1;
        }
      }
      const results: Array<ClassifiedMove | null> = cached?.gameId === gameId
        ? [
            ...cached.moves.slice(0, startIndex),
            ...Array(moves.length - startIndex).fill(null),
          ]
        : Array(moves.length).fill(null);

      cacheRef.current = {
        gameId,
        history: moves.slice(0, startIndex),
        moves: results.slice(0, startIndex),
      };

      setAnalysis({
        moves: [...results],
        completed: startIndex,
        status: startIndex === moves.length ? "complete" : "loading",
      });

      for (let index = startIndex; index < moves.length; index += 1) {
        const response = await fetch("/api/move-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ gameId, ply: index + 1, history: moves }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          analysis?: ClassifiedMove;
        };
        if (controller.signal.aborted) return;
        if (!response.ok || !data.analysis) throw new Error("Analysis unavailable.");
        results[index] = data.analysis;
        cacheRef.current = {
          gameId,
          history: moves.slice(0, index + 1),
          moves: results.slice(0, index + 1),
        };
        setAnalysis({ moves: [...results], completed: index + 1, status: "analyzing" });
      }

      setAnalysis({ moves: results, completed: moves.length, status: "complete" });
    }

    void run().catch((error) => {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setAnalysis((current) => ({ ...current, status: "error" }));
      }
    });
    return () => controller.abort();
  }, [enabled, gameId, historyKey]);

  return analysis;
}
