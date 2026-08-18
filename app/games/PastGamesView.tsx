"use client";

import { Chess, type Square } from "chess.js";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PIECE_GLYPHS } from "../chess-pieces";

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

const START_FEN = new Chess().fen();
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS = [8, 7, 6, 5, 4, 3, 2, 1] as const;
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
  const [replayPly, setReplayPly] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

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
      const game = await response.json() as PastGame;
      setSelectedGame(game);
      setReplayPly(game.history.length);
      setIsPlaying(false);
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

  const replayFen = replayPly === 0
    ? START_FEN
    : selectedGame?.history[replayPly - 1]?.fenAfter ?? selectedGame?.finalFen ?? START_FEN;
  const replayBoard = useMemo(() => {
    try {
      return new Chess(replayFen);
    } catch {
      return new Chess();
    }
  }, [replayFen]);
  const replayMove = selectedGame?.history[replayPly - 1];
  const lastPly = selectedGame?.history.length ?? 0;

  useEffect(() => {
    if (!isPlaying || replayPly >= lastPly) return;
    const timer = window.setTimeout(() => {
      setReplayPly((current) => {
        const next = Math.min(current + 1, lastPly);
        if (next === lastPly) setIsPlaying(false);
        return next;
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [isPlaying, lastPly, replayPly]);

  function goToPly(ply: number) {
    setReplayPly(Math.max(0, Math.min(lastPly, ply)));
    setIsPlaying(false);
  }

  function togglePlayback() {
    if (!lastPly) return;
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (replayPly === lastPly) setReplayPly(0);
    setIsPlaying(true);
  }

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
          <span className="brand-mark">
            <Image src="/pawn-patrol-sentry-correct.png" alt="" width={30} height={30} priority unoptimized />
          </span>
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
                  <span>{PIECE_GLYPHS.p}</span>
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

                <section className="record-replay">
                  <div className="record-section-title">
                    <h3>Game replay</h3>
                    <span aria-live="polite">{replayPly === 0 ? "STARTING POSITION" : `POSITION ${replayPly} OF ${lastPly}`}</span>
                  </div>
                  <div className="record-replay-layout">
                    <div className="record-board-column">
                      <div className="record-board">
                        <div className="chessboard" role="grid" aria-label={`Chess position after ${replayPly} of ${lastPly} moves`}>
                          {RANKS.flatMap((rank, rankIndex) => FILES.map((file, fileIndex) => {
                            const square = `${file}${rank}` as Square;
                            const piece = replayBoard.get(square);
                            const dark = (rank + fileIndex) % 2 === 1;
                            const wasMoved = replayMove?.from === square || replayMove?.to === square;
                            return (
                              <div
                                key={square}
                                className={`square ${dark ? "square--dark" : "square--light"} ${wasMoved ? "was-moved" : ""}`}
                                role="gridcell"
                                aria-label={`${square}${piece ? `, ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ""}`}
                              >
                                {fileIndex === 0 && <span className="rank-label">{rank}</span>}
                                {rankIndex === 7 && <span className="file-label">{file}</span>}
                                {piece && <span className={`piece piece--${piece.color}`}>{PIECE_GLYPHS[piece.type]}</span>}
                              </div>
                            );
                          }))}
                        </div>
                      </div>
                      <div className="record-replay-controls" aria-label="Replay controls">
                        <button onClick={() => goToPly(0)} disabled={replayPly === 0} aria-label="Go to starting position">|‹</button>
                        <button onClick={() => goToPly(replayPly - 1)} disabled={replayPly === 0} aria-label="Previous move">‹</button>
                        <button className="record-play-button" onClick={togglePlayback} disabled={!lastPly} aria-label={isPlaying ? "Pause replay" : "Play replay"}>
                          {isPlaying ? "Pause" : replayPly === lastPly ? "Replay" : "Play"}
                        </button>
                        <button onClick={() => goToPly(replayPly + 1)} disabled={replayPly === lastPly} aria-label="Next move">›</button>
                        <button onClick={() => goToPly(lastPly)} disabled={replayPly === lastPly} aria-label="Go to final position">›|</button>
                      </div>
                    </div>

                    <div className="record-moves">
                      <div className="record-move-table" role="table" aria-label="Move sheet">
                        <div className="record-move-head" role="row">
                          <span>#</span><span>White</span><span>Black</span>
                        </div>
                        {movePairs.map((pair) => (
                          <div className="record-move-row" role="row" key={pair.number}>
                            <span>{pair.number}.</span>
                            {([pair.w, pair.b] as Array<SavedMove | undefined>).map((move, index) => {
                              const ply = (pair.number - 1) * 2 + index + 1;
                              return move ? (
                                <button
                                  key={index}
                                  className={replayPly === ply ? "is-current" : ""}
                                  title={`Played ${formatDate(move.playedAt)}`}
                                  onClick={() => goToPly(ply)}
                                  aria-label={`Show position after ${move.san}`}
                                >
                                  <strong>{move.san}</strong>
                                  <small>{move.from} → {move.to}{move.promotion ? ` = ${move.promotion.toUpperCase()}` : ""}</small>
                                </button>
                              ) : <div key={index} className="empty-cell">—</div>;
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <div className="record-placeholder"><span>{PIECE_GLYPHS.p}</span><p>Select a game to inspect its record.</p></div>
            )}
            {error && <div className="notice" role="status">{error}</div>}
          </article>
        </div>
      </section>

      <footer>
        <span>PAWN PATROL · EST. 2026</span>
        <span>COMPLETED GAMES · MOVE HISTORY · INTERACTIVE REPLAYS</span>
      </footer>
    </main>
  );
}
