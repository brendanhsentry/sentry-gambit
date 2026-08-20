/** Server-side Maia 3: picks human-like moves for the bot opponents. */
import { Chess } from "chess.js";
import { createRequire } from "node:module";
import * as ort from "onnxruntime-node";

const require = createRequire(import.meta.url);
const MOVE_INDEX = require("./app/maia-moves.json");
export const MAIA_MODEL_PATH = "models/maia3.onnx";

// Maia 3 always sees the board from the side to move as white, so black
// positions are flipped before encoding and the chosen move flipped back.
const PIECE_ORDER = "PNBRQKpnbrqk";

function mirrorSquare(square) {
  return `${square[0]}${9 - Number(square[1])}`;
}

function mirrorUci(uci) {
  return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + uci.slice(4);
}

function swapCase(text) {
  return text.replace(/[a-zA-Z]/g, (char) =>
    char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase(),
  );
}

function mirrorFen(fen) {
  const [placement, , castling, enPassant, half, full] = fen.split(" ");
  const ranks = placement.split("/").reverse().map(swapCase).join("/");
  const flippedCastling = castling === "-" ? "-" : swapCase(castling);
  const flippedEp = enPassant === "-" ? "-" : mirrorSquare(enPassant);
  return `${ranks} w ${flippedCastling} ${flippedEp} ${half} ${full}`;
}

function fenToTokens(fen) {
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

let sessionPromise = null;

export function loadMaia() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MAIA_MODEL_PATH, {
      intraOpNumThreads: 2,
    }).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/** Samples a move from Maia's human-move distribution; returns UCI. */
export async function pickMaiaMove(fen, elo) {
  const session = await loadMaia();
  const mirrored = fen.split(" ")[1] === "b";
  const board = new Chess(mirrored ? mirrorFen(fen) : fen);
  const candidates = board.moves({ verbose: true }).map((move) => {
    const uci = move.from + move.to + (move.promotion ?? "");
    return { uci, index: MOVE_INDEX[uci] };
  });
  if (!candidates.length) throw new Error("No legal moves");

  const result = await session.run({
    tokens: new ort.Tensor("float32", fenToTokens(board.fen()), [1, 64, 12]),
    elo_self: new ort.Tensor("float32", Float32Array.from([elo]), [1]),
    elo_oppo: new ort.Tensor("float32", Float32Array.from([elo]), [1]),
  });
  const logits = result.logits_move.data;

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
  return mirrored ? mirrorUci(chosen.uci) : chosen.uci;
}
