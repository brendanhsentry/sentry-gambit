"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChessgroundBoard } from "../../ChessgroundBoard";
import { authToken } from "../../auth";
import { TopBar } from "../../TopBar";
import { gradeLabel, useMoveAnalysis } from "../../move-analysis";
import {
  formatClock,
  formatDate,
  formatDuration,
  moveCountLabel,
  pairMoves,
  playerName,
  playerPerspective,
  replayPosition,
  resultTone,
  type SavedGame,
  type SavedMove,
} from "../game-replay";

type MoveExplanation =
  | { phase: "loading" }
  | {
      phase: "done" | "error";
      explanation: string | null;
      playedLine: string[];
      bestLine: string[];
      requestId?: string;
      message?: string;
    };

const EXPLAINABLE_GRADES = new Set([
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
]);

export function SharedGameView({ gameId }: { gameId: string }) {
  const searchParams = useSearchParams();
  const requestedPlyValue = searchParams.get("ply");
  const requestedPly =
    requestedPlyValue === null ? null : Number(requestedPlyValue);
  const [game, setGame] = useState<SavedGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [replayPly, setReplayPly] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysisPly, setAnalysisPly] = useState<number | null>(null);
  const [moveExplanations, setMoveExplanations] = useState<
    Record<number, MoveExplanation>
  >({});
  const explanationRequestsRef = useRef(new Set<number>());
  const movePairs = useMemo(() => pairMoves(game?.history ?? []), [game]);
  const replay = useMemo(
    () => replayPosition(game, replayPly),
    [game, replayPly],
  );
  const lastPly = game?.history.length ?? 0;
  const playerPerspectiveForGame = game ? playerPerspective(game) : null;
  const analysis = useMoveAnalysis(
    game?.id ?? gameId,
    game?.history ?? [],
    Boolean(game?.history.length),
  );
  const positionExpectedPoints =
    replayPly === 0
      ? 0.5
      : (analysis.moves[replayPly - 1]?.positionExpectedPoints ?? null);
  const whiteExpectedPercent =
    positionExpectedPoints === null
      ? 50
      : Math.round(positionExpectedPoints * 100);
  const selectedReview = analysisPly ? analysis.moves[analysisPly - 1] : null;
  const selectedExplanation = analysisPly
    ? moveExplanations[analysisPly]
    : null;
  const explainableMoves = analysis.moves.flatMap((reviewed, index) =>
    reviewed?.evidence && EXPLAINABLE_GRADES.has(reviewed.grade)
      ? [{ index, reviewed, move: game?.history[index] }]
      : [],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      const playerKey = window.localStorage.getItem("pawn-patrol-player-key");
      const query = playerKey
        ? `?playerKey=${encodeURIComponent(playerKey)}`
        : "";
      const token = authToken();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(
            `/api/games/${encodeURIComponent(gameId)}${query}`,
            {
              signal: controller.signal,
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            },
          );
          if (response.ok) {
            const loaded = (await response.json()) as SavedGame;
            if (!active) return;
            setGame(loaded);
            setReplayPly(
              requestedPly !== null && Number.isInteger(requestedPly)
                ? Math.max(0, Math.min(loaded.history.length, requestedPly))
                : loaded.history.length,
            );
            setAnalysisPly(null);
            setMoveExplanations({});
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
  }, [gameId, requestedPly]);

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

  async function requestMoveExplanation(index: number) {
    const ply = index + 1;
    setAnalysisPly(ply);
    goToPly(ply);

    const reviewed = analysis.moves[index];
    if (
      !reviewed?.evidence ||
      !EXPLAINABLE_GRADES.has(reviewed.grade)
    )
      return;

    const existing = moveExplanations[ply];
    if (existing?.phase === "loading" || existing?.phase === "done") return;
    if (explanationRequestsRef.current.has(ply)) return;
    explanationRequestsRef.current.add(ply);
    setMoveExplanations((current) => ({
      ...current,
      [ply]: { phase: "loading" },
    }));
    try {
      const response = await fetch("/api/move-explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade: reviewed.grade, ...reviewed.evidence }),
      });
      const data = (await response.json()) as {
        explanation?: string;
        playedLine?: string[];
        bestLine?: string[];
        requestId?: string;
        error?: string;
      };
      const playedLine = Array.isArray(data.playedLine) ? data.playedLine : [];
      const bestLine = Array.isArray(data.bestLine) ? data.bestLine : [];
      const explanation = data.explanation;
      if (!response.ok || !explanation) {
        setMoveExplanations((current) => ({
          ...current,
          [ply]: {
            phase: "error",
            explanation: null,
            playedLine,
            bestLine,
            requestId: data.requestId,
            message: data.error ?? "The AI explanation is unavailable.",
          },
        }));
        return;
      }
      setMoveExplanations((current) => ({
        ...current,
        [ply]: {
          phase: "done",
          explanation,
          playedLine,
          bestLine,
          requestId: data.requestId,
        },
      }));
    } catch {
      setMoveExplanations((current) => ({
        ...current,
        [ply]: {
          phase: "error",
          explanation: null,
          playedLine: [],
          bestLine: [],
          message: "The AI explanation could not be reached.",
        },
      }));
    } finally {
      explanationRequestsRef.current.delete(ply);
    }
  }

  return (
    <main className="app-shell archive-shell">
      <TopBar />

      <section className="archive-page shared-replay-page">
        <div className="archive-title-row">
          <div>
            <span className="panel-kicker">PERMANENT RECORD</span>
            <h1>Game replay</h1>
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
                  {playerPerspectiveForGame && (
                    <span className="player-result-chip">
                      You played {playerPerspectiveForGame.color} ·{" "}
                      <span
                        className={`record-outcome record-outcome--${playerPerspectiveForGame.tone}`}
                      >
                        <span
                          className="record-outcome-dot"
                          aria-hidden="true"
                        />
                        {playerPerspectiveForGame.outcome}
                      </span>
                    </span>
                  )}
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

              <div className="record-facts">
                <div className="record-fact--id">
                  <span>Game ID</span>
                  <code>{game.id}</code>
                </div>
                <p>
                  Started {formatDate(game.startedAt)} ·{" "}
                  {formatDuration(game.startedAt, game.finishedAt)} ·{" "}
                  {moveCountLabel(game.history.length)} · White {formatClock(game.clock.w)}{" "}
                  · Black {formatClock(game.clock.b)}
                </p>
              </div>

              <section className="record-replay">
                <div className="record-section-title">
                  <h3>Move by move</h3>
                  <span aria-live="polite">
                    {replayPly === 0
                      ? "STARTING POSITION"
                      : `POSITION ${replayPly} OF ${lastPly}`}
                    {analysis.status === "loading" ||
                    analysis.status === "analyzing"
                      ? ` · GRADING ${analysis.completed}/${lastPly}`
                      : analysis.status === "complete"
                        ? " · GRADED"
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
                          orientation={
                            game.playerColor === "b" ? "black" : "white"
                          }
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
                          ariaLabel={`Chess position after ${replayPly} of ${lastPly} moves, ${game.playerColor === "b" ? "black" : "white"} orientation`}
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
                            const reviewed = analysis.moves[ply - 1];
                            const grade = reviewed
                              ? gradeLabel(reviewed.grade)
                              : null;
                            return move ? (
                              <button
                                key={index}
                                className={replayPly === ply ? "is-current" : ""}
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

                <section className="ai-coach" aria-labelledby="replay-ai-coach-title">
                  <div className="ai-coach-head">
                    <span id="replay-ai-coach-title">COACH</span>
                  </div>
                  {analysis.status === "loading" ||
                  analysis.status === "analyzing" ||
                  analysis.status === "idle" ? (
                    <p>
                      Stockfish is grading every move. Coach tips will appear
                      here when the review finishes.
                    </p>
                  ) : analysis.status === "error" ? (
                    <p>
                      Stockfish could not finish the local review, so the AI
                      coach does not have reliable evidence yet.
                    </p>
                  ) : explainableMoves.length ? (
                    <>
                      <p>
                        Choose a flagged move to ask the AI coach what went
                        wrong and how to improve it.
                      </p>
                      <div className="ai-coach-moves">
                        {explainableMoves.map(({ index, reviewed, move }) => (
                          <button
                            key={index}
                            onClick={() => void requestMoveExplanation(index)}
                          >
                            <strong>
                              {Math.floor(index / 2) + 1}
                              {index % 2 ? "…" : "."} {move?.san}
                            </strong>
                            <span
                              className={`move-grade move-grade--${reviewed.grade}`}
                            >
                              {gradeLabel(reviewed.grade)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p>
                      Stockfish did not flag any moves that need an AI coach
                      explanation in this game.
                    </p>
                  )}
                </section>

                {analysisPly &&
                  selectedReview?.evidence &&
                  EXPLAINABLE_GRADES.has(selectedReview.grade) && (
                    <div className="move-explanation" aria-live="polite">
                      <div className="move-explanation-head">
                        <span
                          className={`move-grade move-grade--${selectedReview.grade}`}
                        >
                          {gradeLabel(selectedReview.grade)}
                        </span>
                        <strong>
                          {Math.ceil(analysisPly / 2)}
                          {analysisPly % 2 ? "." : "…"}{" "}
                          {game.history[analysisPly - 1]?.san}
                        </strong>
                        {selectedReview.expectedPointsLoss !== null && (
                          <small>
                            {(selectedReview.expectedPointsLoss * 100).toFixed(
                              1,
                            )}{" "}
                            expected points lost
                          </small>
                        )}
                      </div>
                      {selectedExplanation?.phase === "loading" ||
                      !selectedExplanation ? (
                        <p className="move-explanation-loading">
                          Asking the coach to explain Stockfish&apos;s line…
                        </p>
                      ) : (
                        <>
                          {selectedExplanation.phase === "done" && (
                            <p className="move-explanation-copy">
                              {selectedExplanation.explanation}
                            </p>
                          )}
                          {selectedExplanation.phase === "error" && (
                            <p className="move-explanation-error">
                              {selectedExplanation.message}
                              <button
                                onClick={() =>
                                  void requestMoveExplanation(analysisPly - 1)
                                }
                              >
                                Retry
                              </button>
                            </p>
                          )}
                          {selectedExplanation.requestId && (
                            <p className="move-explanation-request">
                              Agent run #{selectedExplanation.requestId}
                            </p>
                          )}
                          {selectedExplanation.playedLine.length > 0 && (
                            <div className="engine-line">
                              <span>ENGINE CONTINUATION</span>
                              <code>
                                {selectedExplanation.playedLine.join(" ")}
                              </code>
                            </div>
                          )}
                          {selectedExplanation.bestLine.length > 0 && (
                            <div className="engine-line engine-line--best">
                              <span>BETTER LINE</span>
                              <code>
                                {selectedExplanation.bestLine.join(" ")}
                              </code>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
              </section>
            </>
          )}
        </article>
      </section>

      <footer>
        <span>PAWN PATROL · EST. 2026</span>
        <span>PERMANENT GAME RECORD · MOVE-BY-MOVE REPLAY</span>
      </footer>
    </main>
  );
}
