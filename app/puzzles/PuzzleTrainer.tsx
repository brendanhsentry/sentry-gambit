"use client";

import type { Color, Dests, Key } from "@lichess-org/chessground/types";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { Chess, type PieceSymbol, type Square } from "chess.js";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  playCapture,
  playCastle,
  playCheck,
  playGameEnd,
  playMove,
  setSoundsMuted,
  soundsMuted,
} from "../board-sounds";
import { ChessgroundBoard } from "../ChessgroundBoard";
import { PIECE_GLYPHS } from "../chess-pieces";
import { TopBar } from "../TopBar";
import { PUZZLES } from "./puzzles";

type Phase = "playing" | "replying" | "solved";
type Promotion = { from: Key; to: Key };

function movePosition(fen: string, uci: string) {
  const chess = new Chess(fen);
  const move = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci[4]
      ? { promotion: uci[4] as "q" | "r" | "b" | "n" }
      : {}),
  });
  if (!move) throw new Error(`Invalid puzzle move: ${uci}`);
  return { chess, move };
}

function groundColor(color: "w" | "b"): Color {
  return color === "w" ? "white" : "black";
}

function playMoveSound(san: string) {
  if (san.startsWith("O-O")) playCastle();
  else if (san.includes("+") || san.includes("#")) playCheck();
  else if (san.includes("x")) playCapture();
  else playMove();
}

export function PuzzleTrainer() {
  const [puzzleIndex, setPuzzleIndex] = useState(0);
  const [fen, setFen] = useState(PUZZLES[0].fen);
  const [lineIndex, setLineIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("playing");
  const [lastMove, setLastMove] = useState<Key[] | undefined>();
  const [hintLevel, setHintLevel] = useState(0);
  const [mistakes, setMistakes] = useState(0);
  const [wrongMove, setWrongMove] = useState<Key[] | null>(null);
  const [promotion, setPromotion] = useState<Promotion | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [solvedIds, setSolvedIds] = useState<Set<string>>(new Set());
  const [muted, setMuted] = useState(false);
  const replyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // The stored preference is only readable after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMuted(soundsMuted());
  }, []);

  function toggleMute() {
    const next = !muted;
    setSoundsMuted(next);
    setMuted(next);
  }

  const puzzle = PUZZLES[puzzleIndex];
  const chess = useMemo(() => new Chess(fen), [fen]);
  const orientation = useMemo(
    () => groundColor(new Chess(puzzle.fen).turn()),
    [puzzle.fen],
  );

  useEffect(() => {
    const saved = window.localStorage.getItem("pawn-patrol-solved-puzzles");
    if (!saved) return;
    try {
      const ids = JSON.parse(saved) as string[];
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSolvedIds(new Set(ids.filter((id) => PUZZLES.some((p) => p.id === id))));
    } catch {
      window.localStorage.removeItem("pawn-patrol-solved-puzzles");
    }
  }, []);

  useEffect(
    () => () => {
      if (replyTimerRef.current !== null)
        window.clearTimeout(replyTimerRef.current);
    },
    [],
  );

  const selectPuzzle = useCallback((index: number) => {
    if (replyTimerRef.current !== null) {
      window.clearTimeout(replyTimerRef.current);
      replyTimerRef.current = null;
    }
    const next = PUZZLES[index];
    setPuzzleIndex(index);
    setFen(next.fen);
    setLineIndex(0);
    setPhase("playing");
    setLastMove(undefined);
    setHintLevel(0);
    setMistakes(0);
    setWrongMove(null);
    setPromotion(null);
    setResetToken((value) => value + 1);
  }, []);

  const markSolved = useCallback((id: string) => {
    setPhase("solved");
    playGameEnd();
    setSolvedIds((current) => {
      const next = new Set(current).add(id);
      window.localStorage.setItem(
        "pawn-patrol-solved-puzzles",
        JSON.stringify([...next]),
      );
      return next;
    });
  }, []);

  const legalDests = useMemo(() => {
    const dests: Dests = new Map();
    if (phase !== "playing") return dests;
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key;
      const destinations = dests.get(from);
      if (destinations) destinations.push(move.to as Key);
      else dests.set(from, [move.to as Key]);
    }
    return dests;
  }, [chess, phase]);

  const expectedMove = puzzle.line[lineIndex];
  const hintShapes = useMemo((): DrawShape[] => {
    if (!expectedMove || phase !== "playing") return [];
    const shapes: DrawShape[] = [];
    if (hintLevel > 0)
      shapes.push({ orig: expectedMove.slice(0, 2) as Key, brush: "yellow" });
    if (hintLevel > 1)
      shapes.push({
        orig: expectedMove.slice(0, 2) as Key,
        dest: expectedMove.slice(2, 4) as Key,
        brush: "yellow",
      });
    if (wrongMove)
      shapes.push({ orig: wrongMove[0], dest: wrongMove[1], brush: "red" });
    return shapes;
  }, [expectedMove, hintLevel, phase, wrongMove]);

  function handleMove(from: Key, to: Key, promotionPiece?: PieceSymbol) {
    if (phase !== "playing" || !expectedMove) return;
    const promotionOptions = chess
      .moves({ square: from as Square, verbose: true })
      .filter((move) => move.to === to && move.promotion);
    if (!promotionPiece && promotionOptions.length) {
      setPromotion({ from, to });
      return;
    }

    setPromotion(null);
    if (`${from}${to}${promotionPiece ?? ""}` !== expectedMove) {
      setMistakes((value) => value + 1);
      setWrongMove([from, to]);
      setResetToken((value) => value + 1);
      return;
    }

    setWrongMove(null);
    const afterPlayer = movePosition(fen, expectedMove);
    playMoveSound(afterPlayer.move.san);
    setFen(afterPlayer.chess.fen());
    setLastMove([from, to]);
    const replyIndex = lineIndex + 1;
    setLineIndex(replyIndex);
    if (replyIndex >= puzzle.line.length) {
      markSolved(puzzle.id);
      return;
    }

    setPhase("replying");
    replyTimerRef.current = window.setTimeout(() => {
      const reply = puzzle.line[replyIndex];
      const afterReply = movePosition(afterPlayer.chess.fen(), reply);
      playMoveSound(afterReply.move.san);
      const nextIndex = replyIndex + 1;
      setFen(afterReply.chess.fen());
      setLastMove([
        reply.slice(0, 2) as Key,
        reply.slice(2, 4) as Key,
      ]);
      setLineIndex(nextIndex);
      setHintLevel(0);
      setPhase(nextIndex >= puzzle.line.length ? "solved" : "playing");
      if (nextIndex >= puzzle.line.length) markSolved(puzzle.id);
      replyTimerRef.current = null;
    }, 520);
  }

  function nextPuzzle() {
    for (let offset = 1; offset <= PUZZLES.length; offset += 1) {
      const index = (puzzleIndex + offset) % PUZZLES.length;
      if (!solvedIds.has(PUZZLES[index].id)) {
        selectPuzzle(index);
        return;
      }
    }
    selectPuzzle((puzzleIndex + 1) % PUZZLES.length);
  }

  const turnColor = groundColor(chess.turn());
  const playerColor = groundColor(new Chess(puzzle.fen).turn());

  const solutionSan = useMemo(() => {
    const replay = new Chess(puzzle.fen);
    return puzzle.line
      .map(
        (uci) =>
          replay.move({
            from: uci.slice(0, 2),
            to: uci.slice(2, 4),
            ...(uci[4] ? { promotion: uci[4] as "q" | "r" | "b" | "n" } : {}),
          }).san,
      )
      .join(" ");
  }, [puzzle]);

  return (
    <main className="app-shell puzzle-shell">
      <TopBar />

      <section className="puzzle-page">
        <div className="puzzle-title-row">
          <div>
            <span className="panel-kicker">TACTICAL TRAINING</span>
            <h1>Find the move</h1>
          </div>
          <div
            className="puzzle-progress"
            aria-label={`${solvedIds.size} puzzles solved`}
          >
            <div className="puzzle-progress-count">
              <strong>{solvedIds.size}</strong>
              <span>of {PUZZLES.length} solved</span>
            </div>
            <div className="puzzle-progress-track">
              <i
                style={{
                  width: `${(solvedIds.size / PUZZLES.length) * 100}%`,
                }}
              />
            </div>
          </div>
        </div>

        <div className="puzzle-layout">
          <section className="puzzle-board-panel" aria-label="Current puzzle">
            <div className="puzzle-board-meta">
              <span>{puzzle.difficulty}</span>
              <span className="puzzle-board-tools">
                <button
                  className="sound-toggle"
                  onClick={toggleMute}
                  aria-label={muted ? "Unmute sounds" : "Mute sounds"}
                  title={muted ? "Unmute sounds" : "Mute sounds"}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M8 3 4.5 6H2v4h2.5L8 13V3Z" />
                    {muted ? (
                      <path d="m10.5 6.5 4 3m0-3-4 3" />
                    ) : (
                      <path d="M10.5 6a3.2 3.2 0 0 1 0 4M12.5 4.5a5.6 5.6 0 0 1 0 7" />
                    )}
                  </svg>
                </button>
              </span>
            </div>
            <div className="puzzle-board-wrap">
              <ChessgroundBoard
                fen={fen}
                orientation={orientation}
                turnColor={turnColor}
                check={chess.isCheck() ? turnColor : false}
                lastMove={lastMove}
                movableColor={phase === "playing" ? playerColor : undefined}
                dests={legalDests}
                autoShapes={hintShapes}
                onMove={handleMove}
                resetKey={`${puzzle.id}-${resetToken}-${promotion ? `${promotion.from}${promotion.to}` : ""}`}
                ariaLabel={`Puzzle board, ${orientation} orientation`}
              />
              {promotion && (
                <div
                  className="promotion-picker"
                  role="dialog"
                  aria-label="Choose promotion piece"
                >
                  <span>Promote pawn to</span>
                  <div>
                    {(["q", "r", "b", "n"] as PieceSymbol[]).map((piece) => (
                      <button
                        key={piece}
                        onClick={() =>
                          handleMove(promotion.from, promotion.to, piece)
                        }
                        aria-label={`Promote to ${piece}`}
                      >
                        {PIECE_GLYPHS[piece]}
                      </button>
                    ))}
                  </div>
                  <button
                    className="promotion-cancel"
                    onClick={() => setPromotion(null)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </section>

          <aside className="puzzle-panel">
            <div className="puzzle-heading">
              <span className="panel-kicker">
                PUZZLE {puzzleIndex + 1} / {PUZZLES.length}
              </span>
              <h2>Puzzle {String(puzzleIndex + 1).padStart(2, "0")}</h2>
            </div>

            <div
              className={`puzzle-feedback puzzle-feedback--${phase}${wrongMove ? " puzzle-feedback--wrong" : ""}`}
              aria-live="polite"
            >
              {phase === "solved" ? (
                <>
                  <strong>✓ Tactic found</strong>
                  <p>{puzzle.explanation}</p>
                  <span className="puzzle-solution">{solutionSan}</span>
                  <small>
                    {mistakes
                      ? `${mistakes} ${mistakes === 1 ? "retry" : "retries"}`
                      : "Clean solve"}
                  </small>
                </>
              ) : phase === "replying" ? (
                <>
                  <strong>Correct move</strong>
                  <p>Opponent is replying…</p>
                </>
              ) : wrongMove ? (
                <>
                  <strong>Not the tactic</strong>
                  <p>The move is legal, but there is a stronger continuation.</p>
                </>
              ) : (
                <>
                  <strong>Your move</strong>
                  <p>{orientation === "white" ? "White" : "Black"} to play.</p>
                </>
              )}
            </div>

            {phase !== "solved" && (
              <div className="puzzle-hint">
                <div>
                  <span>NEED A NUDGE?</span>
                  {hintLevel > 0 && <p>{puzzle.hint}</p>}
                </div>
                <button
                  onClick={() => setHintLevel((level) => Math.min(2, level + 1))}
                  disabled={hintLevel === 2 || phase === "replying"}
                >
                  {hintLevel === 0
                    ? "Show hint"
                    : hintLevel === 1
                      ? "Show move"
                      : "Move shown"}
                </button>
              </div>
            )}

            <div className="puzzle-actions">
              <button onClick={() => selectPuzzle(puzzleIndex)}>Reset</button>
              {phase === "solved" && (
                <button className="puzzle-next" onClick={nextPuzzle}>
                  Next puzzle →
                </button>
              )}
            </div>

            <div className="puzzle-list" aria-label="Puzzle list">
              {PUZZLES.map((item, index) => (
                <Fragment key={item.id}>
                  {(index === 0 ||
                    PUZZLES[index - 1].difficulty !== item.difficulty) && (
                    <span className="puzzle-list-label">{item.difficulty}</span>
                  )}
                  <button
                    className={index === puzzleIndex ? "is-active" : ""}
                    onClick={() => selectPuzzle(index)}
                    aria-current={index === puzzleIndex ? "true" : undefined}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>Puzzle {String(index + 1).padStart(2, "0")}</strong>
                    <small>{solvedIds.has(item.id) ? "✓" : ""}</small>
                  </button>
                </Fragment>
              ))}
            </div>
          </aside>
        </div>
      </section>

      <footer>
        <span>PAWN PATROL · EST. 2026</span>
        <span>CALCULATE · COMMIT · CONVERT</span>
      </footer>
    </main>
  );
}
