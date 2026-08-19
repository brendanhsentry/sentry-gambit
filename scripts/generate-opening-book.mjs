import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Chess } from "chess.js";

const sourceDirectory = resolve(process.argv[2] || "");
const outputPath = resolve(process.argv[3] || "app/opening-book.mjs");
const positions = new Set();
const openings = new Map();
const families = new Map();
const positionNames = new Map();
const sourceRevision = execFileSync(
  "git",
  ["-C", sourceDirectory, "rev-parse", "--short=12", "HEAD"],
  { encoding: "utf8" },
).trim();

function positionKey(fen) {
  return fen.split(" ").slice(0, 4).join(" ");
}

for (const volume of ["a", "b", "c", "d", "e"]) {
  const rows = readFileSync(resolve(sourceDirectory, `${volume}.tsv`), "utf8")
    .trim()
    .split("\n");
  for (const [index, row] of rows.slice(1).entries()) {
    const [eco, name, pgn] = row.split("\t");
    const opening = new Chess();

    try {
      opening.loadPgn(pgn);
    } catch (error) {
      throw new Error(
        `Could not parse ${volume}.tsv line ${index + 2}: ${error.message}`,
      );
    }

    const replay = new Chess();
    const moves = [];
    for (const move of opening.history({ verbose: true })) {
      replay.move({ from: move.from, to: move.to, promotion: move.promotion });
      moves.push(`${move.from}${move.to}${move.promotion ?? ""}`);
      positions.add(positionKey(replay.fen()));
    }
    const finalPosition = positionKey(replay.fen());
    if (!positionNames.has(finalPosition)) positionNames.set(finalPosition, name);
    const family = name.split(":", 1)[0];
    const side = moves.length % 2 === 0 ? "black" : "white";
    openings.set(moves.join(" "), { eco, name, family, side });
    const existingFamily = families.get(family);
    if (!existingFamily || moves.length < existingFamily.ply) {
      families.set(family, { family, side, ply: moves.length });
    }
  }
}

const serializedPositions = JSON.stringify([...positions].sort());
const serializedOpenings = JSON.stringify([...openings.entries()]);
const serializedMentions = JSON.stringify(
  [...new Set([...openings.values()].flatMap(({ name, family }) => [name, family]))]
    .sort((left, right) => right.length - left.length),
);
const serializedFamilies = JSON.stringify(Object.fromEntries(families));
const serializedPositionNames = JSON.stringify(
  [...positionNames.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1,
  ),
);

writeFileSync(
  outputPath,
  `// Generated from lichess-org/chess-openings@${sourceRevision} (CC0-1.0).
const OPENING_POSITION_KEYS = new Set(${serializedPositions});
const OPENINGS_BY_MOVES = new Map(${serializedOpenings});
const OPENING_MENTIONS = ${serializedMentions};
const OPENING_FAMILIES = ${serializedFamilies};
const OPENING_NAMES_BY_POSITION = new Map(${serializedPositionNames});

function normalize(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function isOpeningPosition(fen) {
  return OPENING_POSITION_KEYS.has(fen.split(" ").slice(0, 4).join(" "));
}

export function openingName(fen) {
  return OPENING_NAMES_BY_POSITION.get(fen.split(" ").slice(0, 4).join(" ")) ?? null;
}

export function classifyOpening(moves) {
  let key = "";
  let match = null;
  for (let index = 0; index < moves.length; index += 1) {
    key += (index ? " " : "") + moves[index];
    const opening = OPENINGS_BY_MOVES.get(key);
    if (opening) match = { ...opening, ply: index + 1 };
  }
  return match;
}

export function findOpeningMention(value) {
  const question = normalize(value);
  const name = OPENING_MENTIONS.find((candidate) => question.includes(normalize(candidate)));
  if (!name) return null;
  const family = name.includes(":") ? name.split(":", 1)[0] : name;
  return OPENING_FAMILIES[family] ?? null;
}
`,
);
