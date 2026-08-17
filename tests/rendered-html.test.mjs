import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the Pawn Patrol product instead of the starter preview", async () => {
  const [page, layout, client, server, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/ChessRoom.tsx", root), "utf8"),
    readFile(new URL("server.mjs", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(page, /Pawn Patrol/);
  assert.match(layout, /og\.png/);
  assert.match(client, /new WebSocket/);
  assert.match(client, /chess\.moves/);
  assert.match(server, /WebSocketServer/);
  assert.match(server, /table\.chess\.move/);
  assert.match(packageJson, /chess\.js/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
