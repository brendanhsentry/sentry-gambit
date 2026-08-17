"use client";

import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { useEffect, useState } from "react";

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

export type ClassifiedMove = {
  grade: MoveGrade;
  expectedPointsLoss: number | null;
};

type EngineLine = {
  move: string;
  expectedPoints: number;
  pv: string[];
};

type EngineReview = {
  best: EngineLine;
  second: EngineLine | null;
  played: EngineLine;
  loss: number;
};

type AnalysisState = {
  moves: Array<ClassifiedMove | null>;
  completed: number;
  status: "idle" | "loading" | "analyzing" | "complete" | "error";
};

const ENGINE_PATH = "/stockfish/stockfish-18-lite-single.js";
const SEARCH_NODES = 12_000;

const OPENING_LINES = [
  "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7",
  "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d4",
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6",
  "e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3",
  "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 e4e5 f6d7",
  "e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5",
  "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7",
  "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4",
  "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6",
  "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4",
  "c2c4 e7e5 b1c3 g8f6 g2g3 d7d5 c4d5 f6d5",
  "g1f3 d7d5 g2g3 g8f6 f1g2 g7g6 e1g1 f8g7",
].map((line) => line.split(" "));

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

function isBookMove(moves: ReviewMove[], index: number) {
  const played = moves.slice(0, index + 1).map(uci);
  return OPENING_LINES.some((line) => played.every((move, ply) => line[ply] === move));
}

function expectedPointsFromInfo(tokens: string[]) {
  const wdlIndex = tokens.indexOf("wdl");
  if (wdlIndex >= 0) {
    const wins = Number(tokens[wdlIndex + 1]);
    const draws = Number(tokens[wdlIndex + 2]);
    const losses = Number(tokens[wdlIndex + 3]);
    const total = wins + draws + losses;
    if (total > 0) return (wins + draws * 0.5) / total;
  }

  const scoreIndex = tokens.indexOf("score");
  if (scoreIndex < 0) return null;
  const scoreType = tokens[scoreIndex + 1];
  const score = Number(tokens[scoreIndex + 2]);
  if (scoreType === "mate") return score > 0 ? 1 : 0;
  if (scoreType === "cp") return 1 / (1 + Math.exp(-score / 220));
  return null;
}

function parseEngineLine(line: string): { multipv: number; line: EngineLine } | null {
  if (!line.startsWith("info ") || !line.includes(" score ") || !line.includes(" pv ")) return null;
  const tokens = line.trim().split(/\s+/);
  const pvIndex = tokens.indexOf("pv");
  const expectedPoints = expectedPointsFromInfo(tokens);
  if (pvIndex < 0 || expectedPoints === null) return null;
  const pv = tokens.slice(pvIndex + 1);
  if (!pv.length) return null;
  const multipvIndex = tokens.indexOf("multipv");
  return {
    multipv: multipvIndex >= 0 ? Number(tokens[multipvIndex + 1]) : 1,
    line: { move: pv[0], expectedPoints, pv },
  };
}

class StockfishClient {
  private readonly worker: Worker;
  private listener: ((line: string) => void) | null = null;
  private readonly ready: Promise<void>;

  constructor() {
    this.worker = new Worker(ENGINE_PATH);
    this.worker.addEventListener("message", (event) => this.listener?.(String(event.data)));
    this.ready = this.initialize();
  }

  private waitFor(command: string, predicate: (line: string) => boolean) {
    return new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.listener = null;
        reject(new Error("The local chess engine timed out."));
      }, 20_000);
      this.listener = (line) => {
        if (!predicate(line)) return;
        window.clearTimeout(timeout);
        this.listener = null;
        resolve(line);
      };
      this.worker.postMessage(command);
    });
  }

  private async initialize() {
    await this.waitFor("uci", (line) => line === "uciok");
    this.worker.postMessage("setoption name Hash value 16");
    this.worker.postMessage("setoption name UCI_ShowWDL value true");
    await this.waitFor("isready", (line) => line === "readyok");
  }

  private async search(fen: string, multipv: number, searchMove?: string) {
    await this.ready;
    this.worker.postMessage(`setoption name MultiPV value ${multipv}`);
    await this.waitFor("isready", (line) => line === "readyok");
    this.worker.postMessage(`position fen ${fen}`);

    return new Promise<EngineLine[]>((resolve, reject) => {
      const lines = new Map<number, EngineLine>();
      const timeout = window.setTimeout(() => {
        this.listener = null;
        this.worker.postMessage("stop");
        reject(new Error("The local chess engine timed out."));
      }, 20_000);
      this.listener = (message) => {
        const parsed = parseEngineLine(message);
        if (parsed) lines.set(parsed.multipv, parsed.line);
        if (!message.startsWith("bestmove ")) return;
        window.clearTimeout(timeout);
        this.listener = null;
        const result = [...lines.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
        if (result.length) resolve(result);
        else reject(new Error("The local chess engine returned no evaluation."));
      };
      const restriction = searchMove ? ` searchmoves ${searchMove}` : "";
      this.worker.postMessage(`go nodes ${SEARCH_NODES}${restriction}`);
    });
  }

  async reviewMove(fen: string, playedMove: string): Promise<EngineReview> {
    const top = await this.search(fen, 2);
    const played = top.find((line) => line.move === playedMove) ?? (await this.search(fen, 1, playedMove))[0];
    const best = top[0];
    return {
      best,
      second: top[1] ?? null,
      played,
      loss: Math.max(0, best.expectedPoints - played.expectedPoints),
    };
  }

  terminate() {
    this.worker.terminate();
    this.listener = null;
  }
}

const PIECE_VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function materialBalance(chess: Chess, color: Color) {
  let balance = 0;
  for (const rank of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const file of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const piece = chess.get(`${file}${rank}` as Square);
      if (piece) balance += (piece.color === color ? 1 : -1) * PIECE_VALUE[piece.type];
    }
  }
  return balance;
}

function applyUci(chess: Chess, move: string) {
  return chess.move({
    from: move.slice(0, 2),
    to: move.slice(2, 4),
    promotion: (move[4] as PieceSymbol | undefined) ?? "q",
  });
}

function detectsSacrifice(fen: string, playedMove: string, pv: string[], mover: Color) {
  const line = new Chess(fen);
  const before = materialBalance(line, mover);
  let worst = before;
  const continuation = pv[0] === playedMove ? pv : [playedMove, ...pv];

  try {
    for (const move of continuation.slice(0, 5)) {
      applyUci(line, move);
      worst = Math.min(worst, materialBalance(line, mover));
    }
  } catch {
    return false;
  }

  return before - worst >= 1.75;
}

function classifyMove(
  review: EngineReview,
  fen: string,
  move: ReviewMove,
  previousReview: EngineReview | null,
): ClassifiedMove {
  const loss = review.loss;
  const isBest = review.best.move === uci(move);
  const secondEp = review.second?.expectedPoints ?? review.best.expectedPoints;
  const criticalGap = review.best.expectedPoints - secondEp;
  const sacrifice = detectsSacrifice(fen, uci(move), review.played.pv, move.color);

  if (
    loss <= 0.02 &&
    sacrifice &&
    review.played.expectedPoints >= 0.45 &&
    secondEp < 0.9
  ) {
    return { grade: "brilliant", expectedPointsLoss: loss };
  }

  const changesOutcome =
    (review.best.expectedPoints >= 0.72 && secondEp < 0.55) ||
    (review.best.expectedPoints >= 0.45 && secondEp < 0.25);
  if (loss <= 0.02 && (criticalGap >= 0.12 || changesOutcome)) {
    return { grade: "great", expectedPointsLoss: loss };
  }

  const opponentCreatedOpportunity = previousReview?.loss !== undefined && previousReview.loss >= 0.1;
  if (
    opponentCreatedOpportunity &&
    review.best.expectedPoints >= 0.7 &&
    review.played.expectedPoints < 0.58 &&
    loss >= 0.1
  ) {
    return { grade: "miss", expectedPointsLoss: loss };
  }

  if (isBest) return { grade: "best", expectedPointsLoss: loss };
  if (loss <= 0.02) return { grade: "excellent", expectedPointsLoss: loss };
  if (loss <= 0.05) return { grade: "good", expectedPointsLoss: loss };
  if (loss <= 0.1) return { grade: "inaccuracy", expectedPointsLoss: loss };
  if (loss <= 0.2) return { grade: "mistake", expectedPointsLoss: loss };
  return { grade: "blunder", expectedPointsLoss: loss };
}

export function useMoveAnalysis(gameId: string, history: ReviewMove[], enabled: boolean): AnalysisState {
  const [analysis, setAnalysis] = useState<AnalysisState>({
    moves: [],
    completed: 0,
    status: "idle",
  });

  const historyKey = JSON.stringify(history);

  useEffect(() => {
    let cancelled = false;
    let engine: StockfishClient | null = null;
    const moves = JSON.parse(historyKey) as ReviewMove[];

    async function run() {
      await Promise.resolve();
      if (cancelled) return;
      setAnalysis({ moves: Array(moves.length).fill(null), completed: 0, status: enabled ? "loading" : "idle" });
      if (!enabled || !moves.length) return;

      const results: Array<ClassifiedMove | null> = Array(moves.length).fill(null);
      const rawReviews: Array<EngineReview | null> = Array(moves.length).fill(null);
      const board = new Chess();
      engine = new StockfishClient();

      for (let index = 0; index < moves.length; index += 1) {
        if (cancelled) return;
        const move = moves[index];
        const beforeFen = board.fen();

        if (isBookMove(moves, index)) {
          results[index] = { grade: "book", expectedPointsLoss: null };
        } else {
          const review = await engine.reviewMove(beforeFen, uci(move));
          rawReviews[index] = review;
          results[index] = classifyMove(review, beforeFen, move, rawReviews[index - 1] ?? null);
        }

        board.move({ from: move.from, to: move.to, promotion: move.promotion ?? "q" });
        if (!cancelled) {
          setAnalysis({ moves: [...results], completed: index + 1, status: "analyzing" });
        }
      }

      if (!cancelled) setAnalysis({ moves: results, completed: moves.length, status: "complete" });
    }

    void run().catch(() => {
      if (!cancelled) setAnalysis((current) => ({ ...current, status: "error" }));
    });

    return () => {
      cancelled = true;
      engine?.terminate();
    };
  }, [enabled, gameId, historyKey]);

  return analysis;
}
