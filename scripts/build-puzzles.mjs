import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { Chess } from "chess.js";

// Usage: node scripts/build-puzzles.mjs lichess_db_puzzle.csv [app/puzzles/lichess-puzzles.json]
// Source: https://database.lichess.org/#puzzles (CC0).
const sourcePath = resolve(process.argv[2] || "lichess_db_puzzle.csv");
const outputPath = resolve(process.argv[3] || "app/puzzles/lichess-puzzles.json");

const BANDS = [
  [1800, 2099],
  [2100, 2399],
  [2400, 2900],
];
const PER_BAND = 150;
const MIN_PLAYS = 1000;
const MIN_POPULARITY = 92;
const MAX_DEVIATION = 75;
const META_THEMES = new Set([
  "advantage", "crushing", "equality", "mate", "short", "long", "veryLong",
  "oneMove", "master", "masterVsMaster", "superGM", "opening", "middlegame",
  "endgame", "rookEndgame", "queenEndgame", "bishopEndgame", "knightEndgame",
  "pawnEndgame", "queenRookEndgame",
]);

let seed = 20260821;
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

function humanize(theme) {
  return theme
    .replace(/([A-Z])/g, " $1")
    .replace(/(\d+)/g, " $1")
    .trim()
    .toLowerCase();
}

function convert(row) {
  const [id, fen, moves, rating, , , , themes] = row.split(",");
  const uci = moves.split(" ");
  const chess = new Chess(fen);
  const setup = chess.move(uci[0]);
  if (!setup) return null;
  const fenAfterSetup = chess.fen();
  for (const move of uci.slice(1)) if (!chess.move(move)) return null;
  return {
    id,
    rating: Number(rating),
    themes: themes.split(" ").filter((t) => !META_THEMES.has(t)).map(humanize),
    fen: fenAfterSetup,
    lastMove: [uci[0].slice(0, 2), uci[0].slice(2, 4)],
    line: uci.slice(1),
  };
}

const buckets = BANDS.map(() => []);
const seen = BANDS.map(() => 0);
const reader = createInterface({ input: createReadStream(sourcePath) });
let header = true;
for await (const row of reader) {
  if (header) { header = false; continue; }
  const cells = row.split(",");
  const rating = Number(cells[3]);
  const deviation = Number(cells[4]);
  const popularity = Number(cells[5]);
  const plays = Number(cells[6]);
  if (deviation > MAX_DEVIATION || popularity < MIN_POPULARITY || plays < MIN_PLAYS) continue;
  const band = BANDS.findIndex(([lo, hi]) => rating >= lo && rating <= hi);
  if (band < 0) continue;
  // Reservoir sampling keeps a uniform random pick per band in one pass.
  seen[band] += 1;
  const bucket = buckets[band];
  if (bucket.length < PER_BAND) bucket.push(row);
  else {
    const slot = Math.floor(random() * seen[band]);
    if (slot < PER_BAND) bucket[slot] = row;
  }
}

const puzzles = buckets
  .flat()
  .map(convert)
  .filter(Boolean)
  .sort((a, b) => a.rating - b.rating);
writeFileSync(outputPath, JSON.stringify(puzzles));
console.log(`wrote ${puzzles.length} puzzles to ${outputPath} (candidates per band: ${seen.join(", ")})`);
