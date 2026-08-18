import type { PieceSymbol } from "chess.js";

// Use one filled silhouette for both colors. The text variation selector keeps
// mobile browsers from substituting colorful emoji-style chess pieces.
export const PIECE_GLYPHS: Record<PieceSymbol, string> = {
  p: "♟︎",
  n: "♞︎",
  b: "♝︎",
  r: "♜︎",
  q: "♛︎",
  k: "♚︎",
};
