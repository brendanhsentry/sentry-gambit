"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type PlayerColor = "w" | "b";

type PastGameSummary = {
  id: string;
  room: string;
  players: Record<PlayerColor, string | null>;
  result: string;
  startedAt: number;
  finishedAt: number;
  finalFen: string;
  clock: Record<PlayerColor, number>;
  plyCount: number;
};

type SavedMove = {
  from: string;
  to: string;
  san: string;
  color: PlayerColor;
  promotion?: string;
  fenAfter: string;
  playedAt: number;
};

type PastGame = PastGameSummary & { history: SavedMove[] };

function browserPlayerKey() {
  const storageKey = "pawn-patrol-player-key";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = window.crypto.randomUUID();
  window.localStorage.setItem(storageKey, created);
  return created;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatDuration(startedAt: number, finishedAt: number) {
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatClock(ms: number) {
  const safe = Math.max(0, ms);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function playerName(game: PastGameSummary, color: PlayerColor) {
  return game.players[color] || (color === "w" ? "White" : "Black");
}

function resultTone(result: string) {
  return result.toLowerCase().startsWith("draw") ? "draw" : "decisive";
}

export function PastGamesView() {
  const [games, setGames] = useState<PastGameSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedGame, setSelectedGame] = useState<PastGame | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const loadGame = useCallback(async (gameId: string) => {
    setSelectedId(gameId);
    setDetailLoading(true);
    setError("");
    try {
      const key = browserPlayerKey();
      const response = await fetch(
        `/api/games/${encodeURIComponent(gameId)}?playerKey=${encodeURIComponent(key)}`,
      );
      if (!response.ok) throw new Error("Game not found");
      setSelectedGame(await response.json() as PastGame);
    } catch {
      setSelectedGame(null);
      setError("That saved game could not be opened.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadGames = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const key = browserPlayerKey();
      const response = await fetch(`/api/games?limit=100&playerKey=${encodeURIComponent(key)}`);
      if (!response.ok) throw new Error("Archive unavailable");
      const data = await response.json() as { games: PastGameSummary[] };
      setGames(data.games);
      const nextId = selectedId && data.games.some((game) => game.id === selectedId)
        ? selectedId
        : data.games[0]?.id;
      if (nextId) await loadGame(nextId);
      else {
        setSelectedId(null);
        setSelectedGame(null);
      }
    } catch {
      setGames([]);
      setSelectedGame(null);
      setError("Your game archive is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [loadGame, selectedId]);

  useEffect(() => {
    // Load the archive owned by this browser once the client storage is available.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGames();
    // The selected ID is intentionally excluded: choosing a game should not refetch the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredGames = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return games;
    return games.filter((game) => [
      game.id,
      game.room,
      game.players.w,
      game.players.b,
      game.result,
    ].some((value) => value?.toLowerCase().includes(normalized)));
  }, [games, query]);

  const movePairs = useMemo(() => {
    if (!selectedGame) return [];
    return selectedGame.history.reduce<Array<{ number: number; w?: SavedMove; b?: SavedMove }>>(
      (pairs, move, index) => {
        if (index % 2 === 0) pairs.push({ number: Math.floor(index / 2) + 1, w: move });
        else pairs[pairs.length - 1].b = move;
        return pairs;
      },
      [],
    );
  }, [selectedGame]);

  async function copyGameId() {
    if (!selectedGame) return;
    try {
      await navigator.clipboard.writeText(selectedGame.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError("The game ID could not be copied.");
    }
  }

  return (
    <main className="app-shell archive-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Pawn Patrol home">
          <span className="brand-mark">♞</span>
          <span>PAWN <em>PATROL</em></span>
        </Link>
        <div className="topbar-note">GAME RECORDS · SQLITE ARCHIVE</div>
        <Link className="text-button" href="/">Back to tables</Link>
      </header>

      <section className="archive-page">
        <div className="archive-title-row">
          <div>
            <span className="panel-kicker">YOUR ARCHIVE</span>
            <h1>Past games</h1>
            <p>Every completed game and move saved from this browser.</p>
          </div>
          <div className="archive-count">
            <strong>{games.length}</strong>
            <span>{games.length === 1 ? "game" : "games"} recorded</span>
          </div>
        </div>

        <div className="archive-browser">
          <aside className="archive-index" aria-label="Past games">
            <div className="archive-tools">
              <label>
                <span>SEARCH RECORDS</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Player, room, result, ID…"
                />
              </label>
              <button onClick={() => void loadGames()} disabled={loading}>Refresh</button>
            </div>

            <div className="game-record-list">
              {loading ? (
                <div className="archive-empty"><span>♟</span><p>Opening the archive…</p></div>
              ) : filteredGames.length ? filteredGames.map((game) => (
                <button
                  key={game.id}
                  className={selectedId === game.id ? "is-active" : ""}
                  onClick={() => void loadGame(game.id)}
                >
                  <span className="record-date">{formatDate(game.finishedAt)}</span>
                  <strong>{playerName(game, "w")} <i>vs</i> {playerName(game, "b")}</strong>
                  <span className="record-result">{game.result}</span>
                  <span className="record-meta">
                    <code>{game.id}</code><small>{game.plyCount} plies</small>
                  </span>
                </button>
              )) : (
                <div className="archive-empty">
                  <span>♙</span>
                  <p>{games.length ? "No records match your search." : "Finished games you play will appear here."}</p>
                </div>
              )}
            </div>
          </aside>

          <article className="game-record-detail" aria-live="polite">
            {detailLoading ? (
              <div className="record-placeholder"><span>♞</span><p>Loading game record…</p></div>
            ) : selectedGame ? (
              <>
                <div className="record-heading">
                  <div>
                    <span className={`result-chip result-chip--${resultTone(selectedGame.result)}`}>
                      {selectedGame.result}
                    </span>
                    <h2>{playerName(selectedGame, "w")} <i>vs</i> {playerName(selectedGame, "b")}</h2>
                    <p>{formatDate(selectedGame.finishedAt)}</p>
                  </div>
                  <div className="record-room"><span>ROOM</span><strong>{selectedGame.room}</strong></div>
                </div>

                <dl className="record-facts">
                  <div className="record-fact--id">
                    <dt>Game ID</dt>
                    <dd><code>{selectedGame.id}</code><button onClick={copyGameId}>{copied ? "Copied" : "Copy"}</button></dd>
                  </div>
                  <div><dt>Started</dt><dd>{formatDate(selectedGame.startedAt)}</dd></div>
                  <div><dt>Duration</dt><dd>{formatDuration(selectedGame.startedAt, selectedGame.finishedAt)}</dd></div>
                  <div><dt>Moves</dt><dd>{selectedGame.history.length} plies</dd></div>
                  <div><dt>White clock</dt><dd>{formatClock(selectedGame.clock.w)}</dd></div>
                  <div><dt>Black clock</dt><dd>{formatClock(selectedGame.clock.b)}</dd></div>
                </dl>

                <section className="record-moves">
                  <div className="record-section-title"><h3>Move sheet</h3><span>ALGEBRAIC NOTATION</span></div>
                  <div className="record-move-table" role="table" aria-label="Saved moves">
                    <div className="record-move-head" role="row">
                      <span>#</span><span>White</span><span>Black</span>
                    </div>
                    {movePairs.map((pair) => (
                      <div className="record-move-row" role="row" key={pair.number}>
                        <span>{pair.number}.</span>
                        {([pair.w, pair.b] as Array<SavedMove | undefined>).map((move, index) => move ? (
                          <div key={index} title={`Played ${formatDate(move.playedAt)} · position ${move.fenAfter}`}>
                            <strong>{move.san}</strong>
                            <small>{move.from} → {move.to}{move.promotion ? ` = ${move.promotion.toUpperCase()}` : ""}</small>
                          </div>
                        ) : <div key={index} className="empty-cell">—</div>)}
                      </div>
                    ))}
                  </div>
                </section>

                <section className="final-position">
                  <div className="record-section-title"><h3>Final position</h3><span>FEN</span></div>
                  <code>{selectedGame.finalFen}</code>
                </section>
              </>
            ) : (
              <div className="record-placeholder"><span>♙</span><p>Select a game to inspect its record.</p></div>
            )}
            {error && <div className="notice" role="status">{error}</div>}
          </article>
        </div>
      </section>

      <footer>
        <span>PAWN PATROL · EST. 2026</span>
        <span>COMPLETED GAMES · MOVE HISTORY · FINAL POSITIONS</span>
      </footer>
    </main>
  );
}
