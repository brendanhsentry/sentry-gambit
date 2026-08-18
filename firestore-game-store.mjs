import { FieldValue, Firestore } from "@google-cloud/firestore";

export function openFirestoreGameStore() {
  const firestore = new Firestore({ ignoreUndefinedProperties: true });
  const games = firestore.collection("games");
  const writeQueues = new Map();

  // Writes for one game run in order; failures are logged, never thrown at callers.
  function enqueue(gameId, task) {
    const tail = (writeQueues.get(gameId) ?? Promise.resolve()).then(task).catch((error) => {
      console.error(`Firestore write failed for game ${gameId}:`, error);
    });
    writeQueues.set(gameId, tail);
    tail.finally(() => {
      if (writeQueues.get(gameId) === tail) writeQueues.delete(gameId);
    });
    return tail;
  }

  function summary(doc) {
    const data = doc.data();
    return {
      id: doc.id,
      room: data.room,
      players: { w: data.whiteName ?? null, b: data.blackName ?? null },
      result: data.result ?? null,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt ?? null,
      finalFen: data.finalFen,
      clock: { w: data.whiteTimeMs, b: data.blackTimeMs },
      plyCount: data.plyCount ?? 0,
    };
  }

  return {
    createGame(game) {
      const now = Date.now();
      enqueue(game.id, async () => {
        try {
          await games.doc(game.id).create({
            room: game.room,
            status: "in_progress",
            startedAt: now,
            updatedAt: now,
            finalFen: game.fen,
            whiteTimeMs: game.clock.w,
            blackTimeMs: game.clock.b,
            playerKeys: [],
            plyCount: 0,
          });
        } catch (error) {
          if (error?.code !== 6) throw error;
        }
      });
    },
    updatePlayers(gameId, players) {
      enqueue(gameId, () =>
        games.doc(gameId).update({
          whiteName: players.w ?? null,
          blackName: players.b ?? null,
          updatedAt: Date.now(),
        }),
      );
    },
    addPlayer(gameId, playerKey) {
      enqueue(gameId, () =>
        games.doc(gameId).update({
          playerKeys: FieldValue.arrayUnion(playerKey),
          updatedAt: Date.now(),
        }),
      );
    },
    recordMove(gameId, ply, move, fen, clock) {
      const now = Date.now();
      enqueue(gameId, () => {
        const batch = firestore.batch();
        batch.set(games.doc(gameId).collection("moves").doc(String(ply)), {
          ply,
          color: move.color,
          san: move.san,
          from: move.from,
          to: move.to,
          promotion: move.promotion ?? null,
          fenAfter: fen,
          playedAt: now,
        });
        batch.update(games.doc(gameId), {
          finalFen: fen,
          whiteTimeMs: clock.w,
          blackTimeMs: clock.b,
          plyCount: ply,
          updatedAt: now,
        });
        return batch.commit();
      });
    },
    finishGame(gameId, result, fen, clock) {
      const now = Date.now();
      enqueue(gameId, () =>
        games.doc(gameId).update({
          result,
          status: "completed",
          finishedAt: now,
          updatedAt: now,
          finalFen: fen,
          whiteTimeMs: clock.w,
          blackTimeMs: clock.b,
        }),
      );
    },
    deleteGame(gameId) {
      enqueue(gameId, () => firestore.recursiveDelete(games.doc(gameId)));
    },
    async listGames(playerKey, limit = 20) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
      if (!playerKey) return [];
      const snapshot = await games
        .where("playerKeys", "array-contains", playerKey)
        .where("status", "==", "completed")
        .orderBy("finishedAt", "desc")
        .limit(safeLimit)
        .get();
      return snapshot.docs.map(summary);
    },
    async getGame(gameId, playerKey) {
      if (!playerKey) return null;
      const doc = await games.doc(gameId).get();
      const data = doc.data();
      if (!doc.exists || data.status !== "completed") return null;
      if (!(data.playerKeys ?? []).includes(playerKey)) return null;
      const moves = await games.doc(gameId).collection("moves").orderBy("ply").get();
      return {
        ...summary(doc),
        history: moves.docs.map((moveDoc) => {
          const move = moveDoc.data();
          return {
            from: move.from,
            to: move.to,
            san: move.san,
            color: move.color,
            ...(move.promotion ? { promotion: move.promotion } : {}),
            fenAfter: move.fenAfter,
            playedAt: move.playedAt,
          };
        }),
      };
    },
    close() {
      return firestore.terminate();
    },
  };
}
