"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChessgroundBoard } from "../../ChessgroundBoard";
import {
  formatClock,
  formatDate,
  formatDuration,
  pairMoves,
  playerName,
  replayPosition,
  resultTone,
  type SavedGame,
  type SavedMove,
} from "../game-replay";

export function SharedGameView({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<SavedGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [replayPly, setReplayPly] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const movePairs = useMemo(() => pairMoves(game?.history ?? []), [game]);
  const replay = useMemo(
    () => replayPosition(game, replayPly),
    [game, replayPly],
  );
  const lastPly = game?.history.length ?? 0;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(
            `/api/games/${encodeURIComponent(gameId)}`,
            { signal: controller.signal },
          );
          if (response.ok) {
            const loaded = (await response.json()) as SavedGame;
            if (!active) return;
            setGame(loaded);
            setReplayPly(loaded.history.length);
            setLoading(false);
            return;
          }
          if (response.status !== 404 || attempt === 2) break;
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        } catch {
          if (controller.signal.aborted) return;
          break;
        }
      }
      if (!active) return;
      setUnavailable(true);
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [gameId]);

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

  useEffect(() => {
    if (!game) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      goToPly(replayPly + (event.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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

  return (
    <main className="app-shell archive-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Pawn Patrol home">
          <span className="brand-mark">
            <Image
              src="/pawn-patrol-sentry-correct.png"
              alt=""
              width={30}
              height={30}
              priority
              unoptimized
            />
          </span>
          <span>
            PAWN <em>PATROL</em>
          </span>
        </Link>
        <div className="topbar-note">SHARED GAME</div>
        <Link className="text-button" href="/">
          Start a game
        </Link>
      </header>

      <section className="archive-page shared-replay-page">
        <div className="archive-title-row">
          <div>
            <span className="panel-kicker">PERMANENT RECORD</span>
            <h1>Game replay</h1>
            <p>A read-only record of a completed Pawn Patrol game.</p>
          </div>
        </div>

        <article className="game-record-detail shared-game-record" aria-live="polite">
          {loading ? (
            <div className="record-placeholder">
              <span>♞</span>
              <p>Loading game replay…</p>
            </div>
          ) : unavailable || !game ? (
            <div className="record-placeholder">
              <span>♟</span>
              <h2>Game unavailable</h2>
              <p>This game is unfinished, private, deleted, or does not exist.</p>
              <Link className="text-button" href="/">
                Return to Pawn Patrol
              </Link>
            </div>
          ) : (
            <>
              <div className="record-heading">
                <div>
                  <span
                    className={`result-chip result-chip--${resultTone(game.result)}`}
                  >
                    {game.result}
                  </span>
                  <h2>
                    {playerName(game, "w")} <i>vs</i> {playerName(game, "b")}
                  </h2>
                  <p>{formatDate(game.finishedAt)}</p>
                </div>
                <div className="record-room">
                  <span>ROOM</span>
                  <strong>{game.room}</strong>
                </div>
              </div>

              <dl className="record-facts">
                <div className="record-fact--id">
                  <dt>Game ID</dt>
                  <dd>
                    <code>{game.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{formatDate(game.startedAt)}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{formatDuration(game.startedAt, game.finishedAt)}</dd>
                </div>
                <div>
                  <dt>Moves</dt>
                  <dd>{game.history.length} plies</dd>
                </div>
                <div>
                  <dt>White clock</dt>
                  <dd>{formatClock(game.clock.w)}</dd>
                </div>
                <div>
                  <dt>Black clock</dt>
                  <dd>{formatClock(game.clock.b)}</dd>
                </div>
              </dl>

              <section className="record-replay">
                <div className="record-section-title">
                  <h3>Move by move</h3>
                  <span aria-live="polite">
                    {replayPly === 0
                      ? "STARTING POSITION"
                      : `POSITION ${replayPly} OF ${lastPly}`}
                  </span>
                </div>
                <div className="record-replay-layout">
                  <div className="record-board-column">
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
                        aria-label={isPlaying ? "Pause replay" : "Play replay"}
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
                            return move ? (
                              <button
                                key={index}
                                className={replayPly === ply ? "is-current" : ""}
                                title={`Played ${formatDate(move.playedAt)}`}
                                onClick={() => goToPly(ply)}
                                aria-label={`Show position after ${move.san}`}
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
          )}
        </article>
      </section>

      <footer>
        <span>PAWN PATROL · EST. 2026</span>
        <span>PERMANENT GAME RECORD · READ-ONLY REPLAY</span>
      </footer>
    </main>
  );
}
