"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PIECE_GLYPHS } from "../chess-pieces";
import { ChessgroundBoard } from "../ChessgroundBoard";
import { IconSeer } from "../IconSeer";
import { TopBar } from "../TopBar";
import { authToken } from "../auth";
import { gradeLabel, useMoveAnalysis } from "../move-analysis";
import {
  formatClock,
  formatDate,
  formatDuration,
  pairMoves,
  playerName,
  replayPosition,
  resultTone,
  type SavedGame,
  type SavedGameSummary,
  type SavedMove,
} from "./game-replay";

type SeerReview =
  | { phase: "idle" }
  | { phase: "requesting" }
  | {
      phase: "running";
      gameId: string;
      issueId: string;
      shortId: string;
      activity: string[];
      draft: string | null;
    }
  | { phase: "done"; text: string; shortId: string }
  | { phase: "error"; message: string };

function browserPlayerKey() {
  const storageKey = "pawn-patrol-player-key";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = window.crypto.randomUUID();
  window.localStorage.setItem(storageKey, created);
  return created;
}

export function PastGamesView() {
  const [games, setGames] = useState<SavedGameSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedGame, setSelectedGame] = useState<SavedGame | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [replayPly, setReplayPly] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [seer, setSeer] = useState<SeerReview>({ phase: "idle" });
  const selectedGameIdRef = useRef<string | null>(null);

  const loadGame = useCallback(async (gameId: string) => {
    selectedGameIdRef.current = gameId;
    setSelectedId(gameId);
    setDetailLoading(true);
    setError("");
    setSeer({ phase: "idle" });
    try {
      const key = browserPlayerKey();
      const token = authToken();
      const response = await fetch(
        `/api/games/${encodeURIComponent(gameId)}?playerKey=${encodeURIComponent(key)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!response.ok) throw new Error("Game not found");
      const game = (await response.json()) as SavedGame;
      if (selectedGameIdRef.current !== gameId) return;
      setSelectedGame(game);
      setReplayPly(game.history.length);
      setIsPlaying(false);
    } catch {
      if (selectedGameIdRef.current !== gameId) return;
      setSelectedGame(null);
      setError("That saved game could not be opened.");
    } finally {
      if (selectedGameIdRef.current === gameId) setDetailLoading(false);
    }
  }, []);

  const loadGames = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const key = browserPlayerKey();
      const token = authToken();
      const response = await fetch(
        `/api/games?limit=100&playerKey=${encodeURIComponent(key)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!response.ok) throw new Error("Archive unavailable");
      const data = (await response.json()) as { games: SavedGameSummary[] };
      setGames(data.games);
      const nextId =
        selectedId && data.games.some((game) => game.id === selectedId)
          ? selectedId
          : data.games[0]?.id;
      if (nextId) await loadGame(nextId);
      else {
        selectedGameIdRef.current = null;
        setSelectedId(null);
        setSelectedGame(null);
        setSeer({ phase: "idle" });
      }
    } catch {
      selectedGameIdRef.current = null;
      setGames([]);
      setSelectedGame(null);
      setSeer({ phase: "idle" });
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
    return games.filter((game) =>
      [game.id, game.room, game.players.w, game.players.b, game.result].some(
        (value) => value?.toLowerCase().includes(normalized),
      ),
    );
  }, [games, query]);

  const movePairs = useMemo(
    () => pairMoves(selectedGame?.history ?? []),
    [selectedGame],
  );
  const replay = useMemo(
    () => replayPosition(selectedGame, replayPly),
    [selectedGame, replayPly],
  );
  const lastPly = selectedGame?.history.length ?? 0;
  const analysis = useMoveAnalysis(
    selectedGame?.id ?? "past-game",
    selectedGame?.history ?? [],
    Boolean(selectedGame?.history.length),
  );
  const positionExpectedPoints =
    replayPly === 0
      ? 0.5
      : (analysis.moves[replayPly - 1]?.positionExpectedPoints ?? null);
  const whiteExpectedPercent =
    positionExpectedPoints === null
      ? 50
      : Math.round(positionExpectedPoints * 100);

  const requestSeerReview = useCallback(async () => {
    const gameId = selectedGame?.id;
    if (!gameId) return;
    setSeer({ phase: "requesting" });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (selectedGameIdRef.current !== gameId) return;
      try {
        const response = await fetch(
          `/api/review?gameId=${encodeURIComponent(gameId)}`,
          { method: "POST" },
        );
        if (selectedGameIdRef.current !== gameId) return;
        if (response.ok) {
          const data = await response.json();
          setSeer({
            phase: "running",
            gameId,
            issueId: String(data.issueId),
            shortId: String(data.shortId ?? ""),
            activity: [],
            draft: null,
          });
          return;
        }
        if (response.status !== 404) {
          const data = await response
            .json()
            .catch(() => ({}) as { error?: string });
          setSeer({
            phase: "error",
            message: data.error ?? "The review could not be started.",
          });
          return;
        }
      } catch {
        // Retry recent games while Sentry finishes indexing them.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 5_000));
    }

    if (selectedGameIdRef.current === gameId) {
      setSeer({
        phase: "error",
        message: "This game has not reached Seer yet. Try again in a minute.",
      });
    }
  }, [selectedGame?.id]);

  useEffect(() => {
    if (seer.phase !== "running") return;
    let active = true;

    const checkStatus = async () => {
      try {
        const response = await fetch(
          `/api/review/status?issueId=${encodeURIComponent(seer.issueId)}`,
        );
        if (
          !response.ok ||
          !active ||
          selectedGameIdRef.current !== seer.gameId
        )
          return;
        const data = await response.json();
        if (data.status === "completed" && data.text) {
          setSeer({
            phase: "done",
            text: String(data.text),
            shortId: seer.shortId,
          });
        } else if (
          data.status === "errored" ||
          data.status === "failed" ||
          data.status === "cancelled"
        ) {
          setSeer({
            phase: "error",
            message: "Seer hit an error while reviewing. Try again.",
          });
        } else {
          const activity = Array.isArray(data.activity) ? data.activity : [];
          const draft = typeof data.draft === "string" ? data.draft : null;
          setSeer((current) =>
            current.phase === "running" &&
            (current.draft !== draft ||
              JSON.stringify(current.activity) !== JSON.stringify(activity))
              ? { ...current, activity, draft }
              : current,
          );
        }
      } catch {
        // Keep polling through temporary network failures.
      }
    };

    void checkStatus();
    const interval = window.setInterval(() => void checkStatus(), 3_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [seer]);

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

  async function copyGameReference() {
    if (!selectedGame) return;
    const value = selectedGame.shareable
      ? `${window.location.origin}/games/${selectedGame.id}`
      : selectedGame.id;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError(
        selectedGame.shareable
          ? "The replay link could not be copied."
          : "The game ID could not be copied.",
      );
    }
  }

  return (
    <main className="app-shell archive-shell">
      <TopBar />

      <section className="archive-page">
        <div className="archive-title-row">
          <div>
            <span className="panel-kicker">YOUR ARCHIVE</span>
            <h1>Past games</h1>
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
              <button onClick={() => void loadGames()} disabled={loading}>
                Refresh
              </button>
            </div>

            <div className="game-record-list">
              {loading ? (
                <div className="archive-empty">
                  <span>♟</span>
                  <p>Opening the archive…</p>
                </div>
              ) : filteredGames.length ? (
                filteredGames.map((game) => (
                  <button
                    key={game.id}
                    className={selectedId === game.id ? "is-active" : ""}
                    onClick={() => void loadGame(game.id)}
                  >
                    <span className="record-date">
                      {formatDate(game.finishedAt)}
                    </span>
                    <strong>
                      {playerName(game, "w")} <i>vs</i> {playerName(game, "b")}
                    </strong>
                    <span className="record-result">{game.result}</span>
                    <span className="record-meta">
                      <code>{game.id}</code>
                      <small>{game.plyCount} plies</small>
                    </span>
                  </button>
                ))
              ) : (
                <div className="archive-empty">
                  <span>{PIECE_GLYPHS.p}</span>
                  <p>
                    {games.length
                      ? "No records match your search."
                      : "Finished games you play will appear here."}
                  </p>
                </div>
              )}
            </div>
          </aside>

          <article className="game-record-detail" aria-live="polite">
            {detailLoading ? (
              <div className="record-placeholder">
                <span>♞</span>
                <p>Loading game record…</p>
              </div>
            ) : selectedGame ? (
              <>
                <div className="record-heading">
                  <div>
                    <span
                      className={`result-chip result-chip--${resultTone(selectedGame.result)}`}
                    >
                      {selectedGame.result}
                    </span>
                    <h2>
                      {playerName(selectedGame, "w")} <i>vs</i>{" "}
                      {playerName(selectedGame, "b")}
                    </h2>
                    <p>{formatDate(selectedGame.finishedAt)}</p>
                  </div>
                  <div className="record-room">
                    <span>ROOM</span>
                    <strong>{selectedGame.room}</strong>
                  </div>
                </div>

                <div className="record-facts">
                  <div className="record-fact--id">
                    <span>Game ID</span>
                    <code>{selectedGame.id}</code>
                    <button onClick={copyGameReference}>
                      {copied
                        ? "Copied"
                        : selectedGame.shareable
                          ? "Copy replay link"
                          : "Copy ID"}
                    </button>
                  </div>
                  <p>
                    Started {formatDate(selectedGame.startedAt)} ·{" "}
                    {formatDuration(
                      selectedGame.startedAt,
                      selectedGame.finishedAt,
                    )}{" "}
                    · {selectedGame.history.length} plies · White{" "}
                    {formatClock(selectedGame.clock.w)} · Black{" "}
                    {formatClock(selectedGame.clock.b)}
                  </p>
                </div>

                <section
                  className="record-seer"
                  aria-labelledby="record-seer-title"
                >
                  <div className="record-seer-head">
                    <div>
                      <span className="seer-eye">
                        <IconSeer
                          size={18}
                          animation={
                            seer.phase === "requesting" ||
                            seer.phase === "running"
                              ? "loading"
                              : undefined
                          }
                        />
                      </span>
                      <div>
                        <h3 id="record-seer-title">Ask Seer</h3>
                        <p>Get an AI post-game review of this saved match.</p>
                      </div>
                    </div>
                    <button
                      className="record-seer-button"
                      onClick={() => void requestSeerReview()}
                      disabled={
                        seer.phase === "requesting" || seer.phase === "running"
                      }
                    >
                      <IconSeer size={15} />
                      {seer.phase === "requesting"
                        ? "Finding game…"
                        : seer.phase === "running"
                          ? "Reviewing…"
                          : seer.phase === "done"
                            ? "Ask again"
                            : "Ask Seer"}
                    </button>
                  </div>
                  <div className="record-seer-body" aria-live="polite">
                    {seer.phase === "idle" && (
                      <p>
                        Seer will replay the game, identify the turning points,
                        and explain what decided the result.
                      </p>
                    )}
                    {(seer.phase === "requesting" ||
                      seer.phase === "running") && (
                      <p className="record-seer-progress">
                        {seer.phase === "requesting"
                          ? "Finding this game in Sentry…"
                          : seer.draft
                            ? "Seer is writing the review…"
                            : "Seer is reviewing every move. You can keep using the replay while it works."}
                      </p>
                    )}
                    {seer.phase === "running" && seer.activity.length > 0 && (
                      <div className="seer-scan-log">
                        {seer.activity.map((line, index) => (
                          <div
                            key={`${index}-${line}`}
                            className={
                              index === seer.activity.length - 1
                                ? "seer-step--current"
                                : undefined
                            }
                          >
                            {line}
                          </div>
                        ))}
                      </div>
                    )}
                    {seer.phase === "running" && seer.draft && (
                      <div className="seer-draft">
                        <span className="seer-draft-label">LIVE DRAFT</span>
                        <div className="seer-clip">
                          <div className="seer-md seer-md--preview">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {seer.draft}
                            </ReactMarkdown>
                          </div>
                          <div className="seer-fade" aria-hidden />
                        </div>
                      </div>
                    )}
                    {seer.phase === "done" && (
                      <div className="record-seer-review">
                        {seer.shortId && (
                          <span className="seer-chip">{seer.shortId}</span>
                        )}
                        <div className="seer-md">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {seer.text}
                          </ReactMarkdown>
                        </div>
                      </div>
                    )}
                    {seer.phase === "error" && (
                      <p className="seer-error">
                        {seer.message}{" "}
                        <button
                          className="seer-retry"
                          onClick={() => void requestSeerReview()}
                        >
                          Retry
                        </button>
                      </p>
                    )}
                  </div>
                </section>

                <section className="record-replay">
                  <div className="record-section-title">
                    <h3>Game replay</h3>
                    <span aria-live="polite">
                      {replayPly === 0
                        ? "STARTING POSITION"
                        : `POSITION ${replayPly} OF ${lastPly}`}
                      {analysis.status === "loading" ||
                      analysis.status === "analyzing"
                        ? ` · GRADING ${analysis.completed}/${lastPly}`
                        : analysis.status === "complete"
                          ? " · GRADES READY"
                          : analysis.status === "error"
                            ? " · GRADES UNAVAILABLE"
                            : ""}
                    </span>
                  </div>
                  <div className="record-replay-layout">
                    <div className="record-board-column">
                      <div className="record-board-with-eval">
                        <div
                          className={`record-eval-bar${positionExpectedPoints === null ? " is-loading" : ""}`}
                          role="img"
                          aria-label={
                            positionExpectedPoints === null
                              ? "Stockfish is evaluating this position"
                              : `Stockfish evaluation: White has ${whiteExpectedPercent}% expected score`
                          }
                        >
                          <div
                            className="record-eval-bar-black"
                            style={{ height: `${100 - whiteExpectedPercent}%` }}
                          />
                          <div
                            className="record-eval-bar-white"
                            style={{ height: `${whiteExpectedPercent}%` }}
                          />
                        </div>
                        <div className="record-board">
                          <ChessgroundBoard
                            fen={replay.fen}
                            orientation="white"
                            turnColor={
                              replay.chess.turn() === "w" ? "white" : "black"
                            }
                            check={
                              replay.chess.isCheck()
                                ? replay.chess.turn() === "w"
                                  ? "white"
                                  : "black"
                                : false
                            }
                            lastMove={replay.lastMove}
                            viewOnly
                            ariaLabel={`Chess position after ${replayPly} of ${lastPly} moves`}
                          />
                        </div>
                      </div>
                      <p className="record-eval-label" aria-live="polite">
                        {positionExpectedPoints === null
                          ? "Stockfish is evaluating this position…"
                          : `White ${whiteExpectedPercent}% expected score`}
                      </p>
                      <div
                        className="record-replay-controls"
                        aria-label="Replay controls"
                      >
                        <button
                          onClick={() => goToPly(0)}
                          disabled={replayPly === 0}
                          aria-label="Go to starting position"
                        >
                          |‹
                        </button>
                        <button
                          onClick={() => goToPly(replayPly - 1)}
                          disabled={replayPly === 0}
                          aria-label="Previous move"
                        >
                          ‹
                        </button>
                        <button
                          className="record-play-button"
                          onClick={togglePlayback}
                          disabled={!lastPly}
                          aria-label={
                            isPlaying ? "Pause replay" : "Play replay"
                          }
                        >
                          {isPlaying
                            ? "Pause"
                            : replayPly === lastPly
                              ? "Replay"
                              : "Play"}
                        </button>
                        <button
                          onClick={() => goToPly(replayPly + 1)}
                          disabled={replayPly === lastPly}
                          aria-label="Next move"
                        >
                          ›
                        </button>
                        <button
                          onClick={() => goToPly(lastPly)}
                          disabled={replayPly === lastPly}
                          aria-label="Go to final position"
                        >
                          ›|
                        </button>
                      </div>
                    </div>

                    <div className="record-moves">
                      <div
                        className="record-move-table"
                        role="table"
                        aria-label="Move sheet"
                      >
                        <div className="record-move-head" role="row">
                          <span>#</span>
                          <span>White</span>
                          <span>Black</span>
                        </div>
                        {movePairs.map((pair) => (
                          <div
                            className="record-move-row"
                            role="row"
                            key={pair.number}
                          >
                            <span>{pair.number}.</span>
                            {(
                              [pair.w, pair.b] as Array<SavedMove | undefined>
                            ).map((move, index) => {
                              const ply = (pair.number - 1) * 2 + index + 1;
                              const reviewed = analysis.moves[ply - 1];
                              const grade = reviewed
                                ? gradeLabel(reviewed.grade)
                                : null;
                              return move ? (
                                <button
                                  key={index}
                                  className={
                                    replayPly === ply ? "is-current" : ""
                                  }
                                  title={`${grade ? `${grade} · ` : ""}Played ${formatDate(move.playedAt)}${reviewed?.expectedPointsLoss === null || reviewed?.expectedPointsLoss === undefined ? "" : ` · ${(reviewed.expectedPointsLoss * 100).toFixed(1)} expected points lost`}`}
                                  onClick={() => goToPly(ply)}
                                  aria-label={`Show position after ${move.san}${grade ? `, graded ${grade}` : ""}`}
                                >
                                  <span className="record-move-notation">
                                    <strong>{move.san}</strong>
                                    <small>
                                      {move.from} → {move.to}
                                      {move.promotion
                                        ? ` = ${move.promotion.toUpperCase()}`
                                        : ""}
                                    </small>
                                  </span>
                                  {reviewed && (
                                    <span
                                      className={`move-grade move-grade--${reviewed.grade}`}
                                    >
                                      {grade}
                                    </span>
                                  )}
                                </button>
                              ) : (
                                <div key={index} className="empty-cell">
                                  —
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <div className="record-placeholder">
                <span>{PIECE_GLYPHS.p}</span>
                <p>Select a game to inspect its record.</p>
              </div>
            )}
            {error && (
              <div className="notice" role="status">
                {error}
              </div>
            )}
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
