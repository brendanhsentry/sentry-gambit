import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Chess } from "chess.js";

const sourceDirectory = resolve(process.argv[2] || "");
const outputPath = resolve(process.argv[3] || "app/opening-book.ts");
const positions = new Set();
const sourceRevision = execFileSync("git", ["-C", sourceDirectory, "rev-parse", "--short=12", "HEAD"], {
  encoding: "utf8",
}).trim();

function positionKey(fen) {
  return fen.split(" ").slice(0, 4).join(" ");
}

for (const volume of ["a", "b", "c", "d", "e"]) {
  const rows = readFileSync(resolve(sourceDirectory, `${volume}.tsv`), "utf8").trim().split("\n");
  for (const [index, row] of rows.slice(1).entries()) {
    const [, , pgn] = row.split("\t");
    const opening = new Chess();

    try {
      opening.loadPgn(pgn);
    } catch (error) {
      throw new Error(`Could not parse ${volume}.tsv line ${index + 2}: ${error.message}`);
    }

    const replay = new Chess();
    for (const move of opening.history({ verbose: true })) {
      replay.move({ from: move.from, to: move.to, promotion: move.promotion });
      positions.add(positionKey(replay.fen()));
    }
  }
}

const serialized = [...positions].sort().join("\n");
writeFileSync(
  outputPath,
  `// Generated from lichess-org/chess-openings@${sourceRevision} (CC0-1.0).\nconst OPENING_POSITION_KEYS = new Set(\`${serialized}\`.split("\\n"));\n\nexport function isOpeningPosition(fen: string) {\n  return OPENING_POSITION_KEYS.has(fen.split(" ").slice(0, 4).join(" "));\n}\n`,
);
