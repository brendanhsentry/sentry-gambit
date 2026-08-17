import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the Castle & Clock product instead of the starter preview", async () => {
  const [page, layout, client, worker, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/ChessRoom.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(page, /Castle & Clock/);
  assert.match(layout, /og\.png/);
  assert.match(client, /new WebSocket/);
  assert.match(client, /chess\.moves/);
  assert.match(worker, /WebSocketPair/);
  assert.match(worker, /table\.chess\.move/);
  assert.match(packageJson, /chess\.js/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
