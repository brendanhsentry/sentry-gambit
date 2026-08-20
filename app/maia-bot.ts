"use client";

import { Chess, type PieceSymbol, type Square } from "chess.js";
import { useCallback, useRef, useState } from "react";
import MOVE_INDEX_JSON from "./maia-moves.json";

const MOVE_INDEX = MOVE_INDEX_JSON as Record<string, number>;

export type BotKey = "levy" | "hikaru" | "magnus";

export const BOTS: Record<BotKey, { name: string; elo: number }> = {
  levy: { name: "Levy", elo: 1100 },
  hikaru: { name: "Hikaru", elo: 1500 },
  magnus: { name: "Magnus", elo: 1900 },
};

export type MaiaStatus = "idle" | "loading" | "ready" | "error";

// Maia 3 always sees the board from the side to move as white, so black
// positions are flipped before encoding and the chosen move flipped back.
const PIECE_ORDER = "PNBRQKpnbrqk";

function mirrorSquare(square: string) {
  return `${square[0]}${9 - Number(square[1])}`;
}

function mirrorUci(uci: string) {
  return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + uci.slice(4);
}

function swapCase(text: string) {
  return text.replace(/[a-zA-Z]/g, (char) =>
    char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase(),
  );
}

function mirrorFen(fen: string) {
  const [placement, , castling, enPassant, half, full] = fen.split(" ");
  const ranks = placement.split("/").reverse().map(swapCase).join("/");
  const flippedCastling = castling === "-" ? "-" : swapCase(castling);
  const flippedEp = enPassant === "-" ? "-" : mirrorSquare(enPassant);
  return `${ranks} w ${flippedCastling} ${flippedEp} ${half} ${full}`;
}

function fenToTokens(fen: string) {
  const tokens = new Float32Array(64 * 12);
  const rows = fen.split(" ")[0].split("/");
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const char of rows[rank]) {
      const empty = Number(char);
      if (Number.isInteger(empty)) {
        file += empty;
        continue;
      }
      tokens[((7 - rank) * 8 + file) * 12 + PIECE_ORDER.indexOf(char)] = 1;
      file += 1;
    }
  }
  return tokens;
}

export function useMaiaEngine() {
  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);
  const pendingRef = useRef(
    new Map<number, { resolve: (logits: Float32Array) => void; reject: (error: Error) => void }>(),
  );
  const nextIdRef = useRef(0);
  const [status, setStatus] = useState<MaiaStatus>("idle");
  const [progress, setProgress] = useState(0);

  const load = useCallback(() => {
    if (readyRef.current) return readyRef.current;
    setStatus("loading");
    setProgress(0);
    const worker = new Worker("/maia-worker.js");
    workerRef.current = worker;
    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === "progress") {
          setProgress(msg.progress);
        } else if (msg.type === "ready") {
          setStatus("ready");
          resolve();
        } else if (msg.type === "result") {
          pendingRef.current.get(msg.id)?.resolve(new Float32Array(msg.logits));
          pendingRef.current.delete(msg.id);
        } else if (msg.type === "error") {
          if (msg.id !== undefined) {
            pendingRef.current.get(msg.id)?.reject(new Error(msg.message));
            pendingRef.current.delete(msg.id);
          } else {
            reject(new Error(msg.message));
          }
        }
      };
      worker.onerror = () => reject(new Error("The bot engine crashed."));
      worker.postMessage({ type: "init", modelUrl: "/maia3/maia3.onnx" });
    });
    ready.catch(() => {
      setStatus("error");
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      if (readyRef.current === ready) readyRef.current = null;
    });
    readyRef.current = ready;
    return ready;
  }, []);

  const pickMove = useCallback(
    async (fen: string, elo: number) => {
      await load();
      const mirrored = fen.split(" ")[1] === "b";
      const board = new Chess(mirrored ? mirrorFen(fen) : fen);
      const candidates = board.moves({ verbose: true }).map((move) => ({
        uci: move.from + move.to + (move.promotion ?? ""),
        index: MOVE_INDEX[move.from + move.to + (move.promotion ?? "")],
      }));
      if (!candidates.length) throw new Error("No legal moves");

      const id = nextIdRef.current++;
      const logits = await new Promise<Float32Array>((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        workerRef.current?.postMessage({
          type: "infer",
          id,
          tokens: fenToTokens(board.fen()).buffer,
          eloSelf: elo,
          eloOppo: elo,
        });
      });

      // Sample from the human-move distribution over legal moves.
      const maxLogit = Math.max(...candidates.map((c) => logits[c.index]));
      const weights = candidates.map((c) => Math.exp(logits[c.index] - maxLogit));
      let draw = Math.random() * weights.reduce((a, b) => a + b, 0);
      let chosen = candidates[0];
      for (let i = 0; i < candidates.length; i++) {
        draw -= weights[i];
        if (draw <= 0) {
          chosen = candidates[i];
          break;
        }
      }

      const uci = mirrored ? mirrorUci(chosen.uci) : chosen.uci;
      return {
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: (uci[4] as PieceSymbol | undefined) ?? undefined,
      };
    },
    [load],
  );

  return { status, progress, load, pickMove };
}
