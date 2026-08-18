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

  function mapMove(move) {
    return {
      from: move.from,
      to: move.to,
      san: move.san,
      color: move.color,
      ...(move.promotion ? { promotion: move.promotion } : {}),
      fenAfter: move.fenAfter,
      playedAt: move.playedAt,
    };
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
      shareable: data.shareable === true,
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
            shareable: true,
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
    setBot(gameId, bot) {
      enqueue(gameId, () =>
        games.doc(gameId).update({
          botKey: bot.key,
          botColor: bot.color,
          updatedAt: Date.now(),
        }),
      );
    },
    addPlayer(gameId, playerKey, color) {
      enqueue(gameId, () =>
        games.doc(gameId).update({
          playerKeys: FieldValue.arrayUnion(playerKey),
          [`playerColors.${playerKey}`]: color,
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
    undoMoves(gameId, fromPly, fen, clock) {
      const now = Date.now();
      enqueue(gameId, async () => {
        const stale = await games
          .doc(gameId)
          .collection("moves")
          .where("ply", ">=", fromPly)
          .get();
        const batch = firestore.batch();
        stale.docs.forEach((doc) => batch.delete(doc.ref));
        batch.update(games.doc(gameId), {
          finalFen: fen,
          whiteTimeMs: clock.w,
          blackTimeMs: clock.b,
          plyCount: fromPly - 1,
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
      await writeQueues.get(gameId);
      const doc = await games.doc(gameId).get();
      const data = doc.data();
      if (!doc.exists || data.status !== "completed") return null;
      if (!(data.playerKeys ?? []).includes(playerKey)) return null;
      const moves = await games.doc(gameId).collection("moves").orderBy("ply").get();
      return {
        ...summary(doc),
        history: moves.docs.map((moveDoc) => mapMove(moveDoc.data())),
      };
    },
    async getSharedGame(gameId) {
      await writeQueues.get(gameId);
      const doc = await games.doc(gameId).get();
      const data = doc.data();
      if (
        !doc.exists ||
        data.status !== "completed" ||
        data.shareable !== true
      )
        return null;
      const moves = await games
        .doc(gameId)
        .collection("moves")
        .orderBy("ply")
        .get();
      return {
        ...summary(doc),
        history: moves.docs.map((moveDoc) => mapMove(moveDoc.data())),
      };
    },
    async getLiveGame(room, maxAgeMs) {
      const snapshot = await games
        .where("room", "==", room)
        .where("status", "==", "in_progress")
        .get();
      const doc = snapshot.docs
        .sort((a, b) => (b.data().updatedAt ?? 0) - (a.data().updatedAt ?? 0))[0];
      if (!doc) return null;
      const data = doc.data();
      if (Date.now() - data.updatedAt > maxAgeMs) return null;
      const moves = await games.doc(doc.id).collection("moves").orderBy("ply").get();
      return {
        id: doc.id,
        room: data.room,
        clock: { w: data.whiteTimeMs, b: data.blackTimeMs },
        playerColors: data.playerColors ?? {},
        bot: data.botKey ? { key: data.botKey, color: data.botColor } : null,
        history: moves.docs.map((moveDoc) => mapMove(moveDoc.data())),
      };
    },
    close() {
      return firestore.terminate();
    },
  };
}
