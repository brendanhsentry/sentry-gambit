import { FieldValue, Firestore } from "@google-cloud/firestore";

export function openFirestoreGameStore() {
  const firestore = new Firestore({ ignoreUndefinedProperties: true });
  const games = firestore.collection("games");
  const users = firestore.collection("users");
  const usernames = firestore.collection("usernames");
  const sessions = firestore.collection("sessions");
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
      ...(move.analysis ? { analysis: move.analysis } : {}),
    };
  }

  function mapUser(doc) {
    if (!doc?.exists) return null;
    const data = doc.data();
    return {
      id: doc.id,
      username: data.username,
      passwordHash: data.passwordHash,
      rating: data.rating ?? 1200,
      ratedGames: data.ratedGames ?? 0,
      wins: data.wins ?? 0,
      losses: data.losses ?? 0,
      draws: data.draws ?? 0,
    };
  }

  function summary(doc, playerKey = null, userId = null) {
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
      playerColor: playerKey
        ? (data.playerColors?.[playerKey] ?? null)
        : userId
          ? data.whiteUserId === userId
            ? "w"
            : data.blackUserId === userId
              ? "b"
              : null
          : null,
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
            initialTimeMs: game.initialTimeMs ?? game.clock.w,
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
          botCoach: bot.coach === true,
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
    async getMoveAnalysis(gameId, ply) {
      await writeQueues.get(gameId);
      const doc = await games.doc(gameId).collection("moves").doc(String(ply)).get();
      if (!doc.exists) return null;
      const data = doc.data();
      return {
        from: data.from,
        to: data.to,
        promotion: data.promotion ?? null,
        analysis: data.analysis ?? null,
      };
    },
    saveMoveAnalysis(gameId, ply, analysis) {
      enqueue(gameId, () =>
        games.doc(gameId).collection("moves").doc(String(ply)).update({ analysis }),
      );
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
      return snapshot.docs.map((doc) => summary(doc, playerKey));
    },
    async listGamesForUser(userId, limit = 20) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
      if (!userId) return [];
      const [whiteGames, blackGames] = await Promise.all(
        ["whiteUserId", "blackUserId"].map((field) =>
          games
            .where(field, "==", userId)
            .get(),
        ),
      );
      const byId = new Map(
        [...whiteGames.docs, ...blackGames.docs].map((doc) => [doc.id, doc]),
      );
      return [...byId.values()]
        .filter((doc) => doc.data().status === "completed")
        .sort((left, right) => (right.data().finishedAt ?? 0) - (left.data().finishedAt ?? 0))
        .slice(0, safeLimit)
        .map((doc) => summary(doc, null, userId));
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
        ...summary(doc, playerKey),
        history: moves.docs.map((moveDoc) => mapMove(moveDoc.data())),
      };
    },
    async getGameForUser(gameId, userId) {
      if (!userId) return null;
      await writeQueues.get(gameId);
      const doc = await games.doc(gameId).get();
      const data = doc.data();
      if (
        !doc.exists ||
        data.status !== "completed" ||
        (data.whiteUserId !== userId && data.blackUserId !== userId)
      )
        return null;
      const moves = await games.doc(gameId).collection("moves").orderBy("ply").get();
      return {
        ...summary(doc, null, userId),
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
        initialTimeMs: data.initialTimeMs ?? 600_000,
        clock: { w: data.whiteTimeMs, b: data.blackTimeMs },
        playerColors: data.playerColors ?? {},
        seatUsers: {
          w: data.whiteUserId ?? null,
          b: data.blackUserId ?? null,
        },
        bot: data.botKey
          ? { key: data.botKey, color: data.botColor, coach: data.botCoach === true }
          : null,
        history: moves.docs.map((moveDoc) => mapMove(moveDoc.data())),
      };
    },
    setSeatUser(gameId, color, userId) {
      enqueue(gameId, () =>
        games.doc(gameId).update({
          [color === "w" ? "whiteUserId" : "blackUserId"]: userId,
          updatedAt: Date.now(),
        }),
      );
    },
    async createUser({ id, username, passwordHash }) {
      try {
        await usernames.doc(username.toLowerCase()).create({ userId: id });
      } catch (error) {
        if (error?.code === 6) return null;
        throw error;
      }
      await users.doc(id).create({
        username,
        passwordHash,
        rating: 1200,
        ratedGames: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        createdAt: Date.now(),
      });
      return mapUser(await users.doc(id).get());
    },
    async getUserByUsername(username) {
      const claim = await usernames.doc(username.toLowerCase()).get();
      if (!claim.exists) return null;
      return mapUser(await users.doc(claim.data().userId).get());
    },
    async getUserById(id) {
      return mapUser(await users.doc(id).get());
    },
    createSession(token, userId) {
      return sessions.doc(token).set({ userId, createdAt: Date.now() });
    },
    deleteSession(token) {
      return sessions.doc(token).delete();
    },
    async getSessionUser(token) {
      const session = await sessions.doc(token).get();
      if (!session.exists) return null;
      return mapUser(await users.doc(session.data().userId).get());
    },
    recordRatedResult(userId, newRating, outcome) {
      return users.doc(userId).update({
        rating: newRating,
        ratedGames: FieldValue.increment(1),
        wins: FieldValue.increment(outcome === "win" ? 1 : 0),
        losses: FieldValue.increment(outcome === "loss" ? 1 : 0),
        draws: FieldValue.increment(outcome === "draw" ? 1 : 0),
      });
    },
    async listLeaderboard(limit = 50) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
      // Filtering in code avoids a ratedGames+rating composite index.
      const snapshot = await users.orderBy("rating", "desc").limit(200).get();
      return snapshot.docs
        .map(mapUser)
        .filter((user) => user.ratedGames > 0)
        .slice(0, safeLimit);
    },
    close() {
      return firestore.terminate();
    },
  };
}
