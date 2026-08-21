"use client";

import type { Color, Dests, Key } from "@lichess-org/chessground/types";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { Chess, type Move } from "chess.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { playCapture, playCastle, playCheck, playMove } from "../board-sounds";
import { ChessgroundBoard } from "../ChessgroundBoard";
import { botMove, engineBestMove } from "../move-analysis";
import { TopBar } from "../TopBar";
import { OPENING_LESSONS, type OpeningLesson } from "./openings";

type Phase = "walkthrough" | "drill" | "line-reply" | "ready" | "practice" | "maia" | "finished";

function playerColor(side: "w" | "b"): Color {
  return side === "w" ? "white" : "black";
}

function soundForMove(move: Move) {
  if (move.san.startsWith("O-O")) playCastle();
  else if (move.san.includes("+")) playCheck();
  else if (move.captured) playCapture();
  else playMove();
}

function movePosition(fen: string, uci: string) {
  const chess = new Chess(fen);
  const move = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci[4] ? { promotion: uci[4] as "q" | "r" | "b" | "n" } : {}),
  });
  if (!move) throw new Error(`Invalid opening move: ${uci}`);
  return { chess, move };
}

function sanLine(line: string[]) {
  const chess = new Chess();
  return line.map((uci) => {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci[4] ? { promotion: uci[4] as "q" | "r" | "b" | "n" } : {}),
    });
    if (!move) throw new Error(`Invalid opening move: ${uci}`);
    return move.san;
  });
}

function positionAt(line: string[], moveCount: number) {
  const chess = new Chess();
  let lastMove: Key[] | undefined;
  for (const uci of line.slice(0, moveCount)) {
    const { move } = movePosition(chess.fen(), uci);
    chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci[4] ? { promotion: uci[4] as "q" | "r" | "b" | "n" } : {}),
    });
    lastMove = [move.from as Key, move.to as Key];
  }
  return { fen: chess.fen(), lastMove };
}

export function LearnTrainer() {
  const [lesson, setLesson] = useState<OpeningLesson>(OPENING_LESSONS[0]);
  const [fen, setFen] = useState(new Chess().fen());
  const [lineIndex, setLineIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("walkthrough");
  const [lastMove, setLastMove] = useState<Key[] | undefined>();
  const [message, setMessage] = useState("Play the highlighted line on the board.");
  const [wrongMove, setWrongMove] = useState<Key[] | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [hint, setHint] = useState<{ san: string; uci: string } | null>(null);
  const [engineLoading, setEngineLoading] = useState(false);

  const chess = useMemo(() => new Chess(fen), [fen]);
  const side = playerColor(lesson.side);
  const sans = useMemo(() => sanLine(lesson.line), [lesson]);
  const openingFamilies = useMemo(
    () => [...new Map(OPENING_LESSONS.map((item) => [item.opening, item])).values()],
    [],
  );
  const variations = useMemo(
    () => OPENING_LESSONS.filter((item) => item.opening === lesson.opening),
    [lesson.opening],
  );
  const isPlayerTurn = chess.turn() === lesson.side;
  const displayMessage =
    phase === "drill" && isPlayerTurn
      ? `Your move: ${lesson.notes[lineIndex]}`
      : phase === "walkthrough"
        ? lineIndex === 0
          ? "Use Next move to replay the line with the idea behind each move."
          : `${sans[lineIndex - 1]}: ${lesson.notes[lineIndex - 1]}`
      : message;

  const resetLesson = useCallback((nextLesson = lesson) => {
    setLesson(nextLesson);
    setFen(new Chess().fen());
    setLineIndex(0);
    setPhase("walkthrough");
    setLastMove(undefined);
    setMessage("Use Next move to replay the selected line.");
    setWrongMove(null);
    setHint(null);
    setResetKey((value) => value + 1);
  }, [lesson]);

  useEffect(() => {
    if (phase !== "drill") return;
    const nextMove = lesson.line[lineIndex];
    if (!nextMove) return;
    const board = new Chess(fen);
    if (board.turn() === lesson.side) return;
    const timer = window.setTimeout(() => {
      const next = movePosition(fen, nextMove);
      soundForMove(next.move);
      setFen(next.chess.fen());
      setLastMove([nextMove.slice(0, 2) as Key, nextMove.slice(2, 4) as Key]);
      const nextIndex = lineIndex + 1;
      setLineIndex(nextIndex);
      if (nextIndex >= lesson.line.length) {
        setMessage("Line complete. Continue from this exact position against Maia.");
        setPhase("ready");
      } else {
        setMessage(lesson.notes[lineIndex]);
        setPhase("drill");
      }
    }, 480);
    return () => window.clearTimeout(timer);
  }, [fen, lesson, lineIndex, phase]);

  useEffect(() => {
    if (phase !== "maia") return;
    let cancelled = false;
    void botMove(fen, 1500)
      .then(({ move }) => {
        if (cancelled) return;
        const next = movePosition(fen, move);
        soundForMove(next.move);
        setFen(next.chess.fen());
        setLastMove([move.slice(0, 2) as Key, move.slice(2, 4) as Key]);
        if (next.chess.isGameOver()) {
          setPhase("finished");
          setMessage("Practice game complete.");
        } else {
          setPhase("practice");
          setMessage("Your move. The opening line is over; play the position.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhase("practice");
          setMessage("Maia is unavailable right now. Try the next move again shortly.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fen, phase]);

  const legalDests = useMemo(() => {
    const dests: Dests = new Map();
    if (!isPlayerTurn || !["drill", "practice"].includes(phase)) return dests;
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key;
      const destinations = dests.get(from);
      if (destinations) destinations.push(move.to as Key);
      else dests.set(from, [move.to as Key]);
    }
    return dests;
  }, [chess, isPlayerTurn, phase]);

  const hintShapes = useMemo<DrawShape[]>(() => {
    if (!hint) return [];
    return [{ orig: hint.uci.slice(0, 2) as Key, dest: hint.uci.slice(2, 4) as Key, brush: "green" }];
  }, [hint]);

  function handleMove(from: Key, to: Key) {
    const uci = `${from}${to}`;
    if (phase === "drill") {
      const expected = lesson.line[lineIndex];
      if (uci !== expected) {
        setWrongMove([from, to]);
        setMessage(`That is legal, but this line calls for ${sans[lineIndex]}. ${lesson.notes[lineIndex]}`);
        setResetKey((value) => value + 1);
        return;
      }
      const next = movePosition(fen, uci);
      soundForMove(next.move);
      setFen(next.chess.fen());
      setLastMove([from, to]);
      setLineIndex((index) => index + 1);
      setWrongMove(null);
      setHint(null);
      if (lineIndex + 1 >= lesson.line.length) {
        setPhase("ready");
        setMessage("Line complete. Continue from this exact position against Maia.");
      }
      return;
    }
    if (phase !== "practice") return;
    const next = movePosition(fen, uci);
    soundForMove(next.move);
    setFen(next.chess.fen());
    setLastMove([from, to]);
    setHint(null);
    if (next.chess.isGameOver()) {
      setPhase("finished");
      setMessage("Practice game complete.");
    } else {
      setMessage("Maia is choosing a human-like reply…");
      setPhase("maia");
    }
  }

  function stepLine(direction: -1 | 1) {
    const nextIndex = Math.max(0, Math.min(lesson.line.length, lineIndex + direction));
    const next = positionAt(lesson.line, nextIndex);
    setFen(next.fen);
    setLastMove(next.lastMove);
    setLineIndex(nextIndex);
    setWrongMove(null);
    setHint(null);
    setResetKey((value) => value + 1);
  }

  function startDrill() {
    const initial = positionAt(lesson.line, 0);
    setFen(initial.fen);
    setLastMove(undefined);
    setLineIndex(0);
    setPhase("drill");
    setMessage(lesson.side === "w" ? "Your move. Build the selected line." : "Maia starts the line as White.");
    setWrongMove(null);
    setHint(null);
    setResetKey((value) => value + 1);
  }

  function startPractice() {
    setWrongMove(null);
    setHint(null);
    if (chess.turn() === lesson.side) {
      setPhase("practice");
      setMessage("Your move. Maia takes over from the position you just learned.");
    } else {
      setMessage("Maia is choosing a human-like reply…");
      setPhase("maia");
    }
  }

  async function requestHint() {
    setEngineLoading(true);
    try {
      const { move } = await engineBestMove(fen);
      const san = movePosition(fen, move).move.san;
      setHint({ san, uci: move });
      setMessage(`Stockfish's top move here is ${san}.`);
    } catch {
      setMessage("Stockfish is unavailable right now.");
    } finally {
      setEngineLoading(false);
    }
  }

  return (
    <main className="app-shell learn-shell">
      <TopBar />
      <section className="learn-page">
        <header className="learn-header">
          <div>
            <span className="panel-kicker">OPENING LAB</span>
            <h1>Learn a line. Then play it.</h1>
            <p>Drill the concrete variation first. Maia takes over from the final position.</p>
          </div>
        </header>

        <div className="learn-layout">
          <section className="learn-board-panel" aria-label="Opening board">
            <div className="learn-board-meta">
              <span>{phase === "walkthrough" ? "LINE WALKTHROUGH" : phase === "practice" || phase === "maia" || phase === "finished" ? "MAIA PRACTICE" : "LINE DRILL"}</span>
              <span>You play {lesson.side === "w" ? "White" : "Black"}</span>
            </div>
            <div className="learn-board-wrap">
              <ChessgroundBoard
                fen={fen}
                orientation={side}
                turnColor={chess.turn() === "w" ? "white" : "black"}
                check={chess.isCheck() ? (chess.turn() === "w" ? "white" : "black") : false}
                lastMove={lastMove}
                movableColor={isPlayerTurn && ["drill", "practice"].includes(phase) ? side : undefined}
                dests={legalDests}
                autoShapes={hintShapes}
                onMove={handleMove}
                resetKey={`${lesson.id}-${resetKey}`}
                ariaLabel={`${lesson.opening} board, playing ${lesson.side === "w" ? "White" : "Black"}`}
              />
            </div>
          </section>

          <aside className="learn-panel">
            <div className="learn-repertoire-picker">
              <span className="panel-kicker">CHOOSE REPERTOIRE</span>
              <div className="learn-picker-fields">
                <label>
                  <span>Opening</span>
                  <select
                    value={lesson.opening}
                    onChange={(event) => {
                      const next = openingFamilies.find((item) => item.opening === event.target.value);
                      if (next) resetLesson(next);
                    }}
                  >
                    {openingFamilies.map((item) => (
                      <option key={item.opening} value={item.opening}>
                        {item.opening} · {item.side === "w" ? "White" : "Black"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Opponent variation</span>
                  <select
                    value={lesson.id}
                    onChange={(event) => {
                      const next = variations.find((item) => item.id === event.target.value);
                      if (next) resetLesson(next);
                    }}
                  >
                    {variations.map((item) => (
                      <option key={item.id} value={item.id}>{item.variation}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <span className="panel-kicker">YOU PLAY {lesson.side === "w" ? "WHITE" : "BLACK"}</span>
            <h2>{lesson.opening}</h2>
            <p className="learn-summary">{lesson.summary}</p>
            <div className="learn-branch-answer">
              <strong>{lesson.opponentMove}</strong>
              <p>{lesson.answer}</p>
            </div>
            <div className={`learn-feedback${wrongMove ? " learn-feedback--wrong" : ""}`} aria-live="polite">
              <strong>{phase === "walkthrough" ? `Move ${lineIndex} of ${lesson.line.length}` : phase === "ready" ? "Line learned" : phase === "practice" || phase === "maia" ? "Maia practice" : "Current move"}</strong>
              <p>{displayMessage}</p>
            </div>
            <div className="learn-actions">
              {phase === "walkthrough" ? (
                <>
                  <button onClick={() => stepLine(-1)} disabled={lineIndex === 0}>← Previous</button>
                  <button onClick={() => stepLine(1)} disabled={lineIndex === lesson.line.length}>Next move →</button>
                  <button className="learn-primary" onClick={startDrill}>Drill this line</button>
                </>
              ) : (
                <button onClick={() => resetLesson()}>View line</button>
              )}
              {phase === "ready" && <button className="learn-primary" onClick={startPractice}>Play Maia from here →</button>}
              {(phase === "practice" || phase === "maia") && <button onClick={() => void requestHint()} disabled={engineLoading || phase === "maia"}>{engineLoading ? "Checking…" : "Stockfish hint"}</button>}
              {phase === "finished" && <button className="learn-primary" onClick={() => resetLesson()}>Run it back</button>}
            </div>
            <div className="learn-idea">
              <span>WHY THIS LINE</span>
              <p>{lesson.keyIdea}</p>
            </div>
            <div className="learn-moves" aria-label="Opening moves">
              {sans.map((san, index) => (
                <span key={`${san}-${index}`} className={index === lineIndex ? "is-next" : index < lineIndex ? "is-played" : undefined}>
                  {index % 2 === 0 && <b>{Math.floor(index / 2) + 1}.</b>} {san}
                </span>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
