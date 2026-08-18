import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openGameStore, openJsonGameStore } from "../game-store.mjs";

test("stores completed games and their replayable move history", () => {
  const store = openGameStore(":memory:");
  const clock = { w: 600_000, b: 600_000 };
  store.createGame({ id: "game-1", room: "ABC123", fen: "start", clock });
  store.updatePlayers("game-1", { w: "Ada", b: "Grace" });
  store.addPlayer("game-1", "ada-browser", "w");
  store.recordMove("game-1", 1, { color: "w", san: "e4", from: "e2", to: "e4" }, "fen-after-e4", { w: 598_000, b: 600_000 });

  assert.deepEqual(store.listGames("ada-browser"), []);
  store.finishGame("game-1", "White wins by resignation", "fen-after-e4", { w: 598_000, b: 600_000 });

  assert.deepEqual(store.listGames("unknown-browser"), []);
  const [summary] = store.listGames("ada-browser");
  assert.equal(summary.plyCount, 1);
  assert.deepEqual(summary.players, { w: "Ada", b: "Grace" });
  const game = store.getGame("game-1", "ada-browser");
  assert.equal(game.result, "White wins by resignation");
  assert.equal(game.history[0].san, "e4");
  assert.equal(game.history[0].fenAfter, "fen-after-e4");
  store.close();
});

test("JSON archive survives closing and reopening the store", () => {
  const directory = mkdtempSync(join(tmpdir(), "pawn-patrol-archive-"));
  try {
    const clock = { w: 600_000, b: 600_000 };
    const firstStore = openJsonGameStore(directory);
    firstStore.createGame({ id: "game-2", room: "PERSIST", fen: "start", clock });
    firstStore.updatePlayers("game-2", { w: "Ada", b: "Grace" });
    firstStore.addPlayer("game-2", "ada-browser", "w");
    firstStore.addPlayer("game-2", "grace-browser", "b");
    firstStore.recordMove(
      "game-2",
      1,
      { color: "w", san: "e4", from: "e2", to: "e4" },
      "fen-after-e4",
      { w: 598_000, b: 600_000 },
    );
    firstStore.finishGame(
      "game-2",
      "White wins by resignation",
      "fen-after-e4",
      { w: 598_000, b: 600_000 },
    );
    firstStore.close();

    const secondStore = openJsonGameStore(directory);
    assert.equal(secondStore.listGames("ada-browser")[0].id, "game-2");
    assert.equal(secondStore.listGames("grace-browser")[0].id, "game-2");
    assert.equal(secondStore.getGame("game-2", "ada-browser").history[0].san, "e4");
    assert.deepEqual(secondStore.listGames("unknown-browser"), []);
    secondStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
