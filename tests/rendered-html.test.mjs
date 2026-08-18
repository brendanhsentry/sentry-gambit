import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the Pawn Patrol product instead of the starter preview", async () => {
  const [page, layout, client, archive, server, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/ChessRoom.tsx", root), "utf8"),
    readFile(new URL("app/games/PastGamesView.tsx", root), "utf8"),
    readFile(new URL("server.mjs", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(page, /Pawn Patrol/);
  assert.match(layout, /og\.png/);
  assert.match(client, /new WebSocket/);
  assert.match(client, /chess\.moves/);
  assert.match(client, /href="\/games"/);
  assert.doesNotMatch(client, /DEEPSEEK|OPENROUTER|AGENT MONITOR/i);
  assert.match(archive, /Game ID/);
  assert.match(archive, /\/api\/games/);
  assert.match(archive, /Move sheet/);
  assert.match(archive, /Game replay/);
  assert.doesNotMatch(archive, />FEN</);
  assert.match(server, /WebSocketServer/);
  assert.match(server, /table\.chess\.move/);
  assert.match(server, /gen_ai\.invoke_agent/);
  assert.match(server, /gen_ai\.chat/);
  assert.doesNotMatch(server, /\/api\/agent-status/);
  assert.match(packageJson, /chess\.js/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
