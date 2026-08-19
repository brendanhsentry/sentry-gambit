import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Chess } from "chess.js";

const sourceDirectory = resolve(process.argv[2] || "");
const outputPath = resolve(process.argv[3] || "app/opening-book.mjs");
const positions = new Set();
const openings = new Map();
const families = new Map();
const sourceRevision = execFileSync("git", ["-C", sourceDirectory, "rev-parse", "--short=12", "HEAD"], {
  encoding: "utf8",
}).trim();

function positionKey(fen) {
  return fen.split(" ").slice(0, 4).join(" ");
}

for (const volume of ["a", "b", "c", "d", "e"]) {
  const rows = readFileSync(resolve(sourceDirectory, `${volume}.tsv`), "utf8").trim().split("\n");
  for (const [index, row] of rows.slice(1).entries()) {
    const [eco, name, pgn] = row.split("\t");
    const opening = new Chess();

    try {
      opening.loadPgn(pgn);
    } catch (error) {
      throw new Error(`Could not parse ${volume}.tsv line ${index + 2}: ${error.message}`);
    }

    const replay = new Chess();
    const moves = [];
    for (const move of opening.history({ verbose: true })) {
      replay.move({ from: move.from, to: move.to, promotion: move.promotion });
      moves.push(`${move.from}${move.to}${move.promotion ?? ""}`);
      positions.add(positionKey(replay.fen()));
    }
    const family = name.split(":", 1)[0];
    const side = moves.length % 2 === 0 ? "black" : "white";
    openings.set(moves.join(" "), { eco, name, family, side });
    const existingFamily = families.get(family);
    if (!existingFamily || moves.length < existingFamily.ply) {
      families.set(family, { family, side, ply: moves.length });
    }
  }
}

const serialized = [...positions].sort().join("\n");
const serializedOpenings = JSON.stringify([...openings.entries()]);
const serializedNames = JSON.stringify(
  [...new Set([...openings.values()].flatMap((opening) => [opening.name, opening.family]))]
    .sort((left, right) => right.length - left.length),
);
const serializedFamilies = JSON.stringify(Object.fromEntries(families));
writeFileSync(
  outputPath,
  `// Generated from lichess-org/chess-openings@${sourceRevision} (CC0-1.0).\nconst OPENING_POSITION_KEYS = new Set(\`${serialized}\`.split("\\n"));\nconst OPENINGS_BY_MOVES = new Map(${serializedOpenings});\nconst OPENING_NAMES = ${serializedNames};\nconst OPENING_FAMILIES = ${serializedFamilies};\n\nfunction normalize(value) {\n  return value.toLowerCase().normalize("NFKD").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();\n}\n\nexport function isOpeningPosition(fen) {\n  return OPENING_POSITION_KEYS.has(fen.split(" ").slice(0, 4).join(" "));\n}\n\nexport function classifyOpening(moves) {\n  let key = "";\n  let match = null;\n  for (let index = 0; index < moves.length; index += 1) {\n    key += (index ? " " : "") + moves[index];\n    const opening = OPENINGS_BY_MOVES.get(key);\n    if (opening) match = { ...opening, ply: index + 1 };\n  }\n  return match;\n}\n\nexport function findOpeningMention(value) {\n  const question = normalize(value);\n  const name = OPENING_NAMES.find((candidate) => question.includes(normalize(candidate)));\n  if (!name) return null;\n  const family = name.includes(":") ? name.split(":", 1)[0] : name;\n  return OPENING_FAMILIES[family] ?? null;\n}\n`,
);
