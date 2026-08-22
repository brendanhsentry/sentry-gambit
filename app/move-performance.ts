"use client";

import * as Sentry from "@sentry/react";

const DSN =
  "https://69f4666f8a913ed118913d18660fe20d@o4511927634296832.ingest.us.sentry.io/4511927685939200";
const ANIMATION_WINDOW_MS = 260;
const SLOW_FRAME_MS = 20;

type MoveSource = "local" | "remote";

type ActiveMove = {
  source: MoveSource;
  startedAt: number;
  span: ReturnType<typeof Sentry.startInactiveSpan>;
  stateAt: number | null;
  boardAt: number | null;
  fen: string | null;
  lastFrameAt: number | null;
  maxFrameMs: number;
  slowFrames: number;
  frames: number;
  frameRequest: number | null;
  timeout: number | null;
  observer: PerformanceObserver | null;
};

let initialized = false;
let activeMove: ActiveMove | null = null;

function deviceClass() {
  return window.matchMedia("(pointer: coarse)").matches ? "coarse" : "fine";
}

function ensureInitialized() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  Sentry.init({ dsn: DSN, tracesSampleRate: 1 });
}

function attributes(move: ActiveMove) {
  return {
    "chess.move.source": move.source,
    "device.pointer": deviceClass(),
  };
}

function finishMove(move: ActiveMove, outcome = "ok") {
  if (activeMove !== move) return;
  if (move.frameRequest !== null) cancelAnimationFrame(move.frameRequest);
  if (move.timeout !== null) window.clearTimeout(move.timeout);
  move.observer?.disconnect();
  const totalMs = performance.now() - move.startedAt;
  const telemetryAttributes = attributes(move);
  move.span.setAttribute("chess.move.outcome", outcome);
  move.span.setAttribute("chess.move.total_ms", totalMs);
  move.span.setAttribute("chess.move.max_frame_ms", move.maxFrameMs);
  move.span.setAttribute("chess.move.slow_frames", move.slowFrames);
  move.span.setAttribute("chess.move.frame_count", move.frames);
  if (move.stateAt !== null)
    move.span.setAttribute("chess.move.state_ms", move.stateAt - move.startedAt);
  if (move.boardAt !== null)
    move.span.setAttribute("chess.move.board_ms", move.boardAt - move.startedAt);
  Sentry.metrics.distribution("chess.move.total", totalMs, {
    unit: "millisecond",
    attributes: telemetryAttributes,
  });
  Sentry.metrics.distribution("chess.move.max_frame", move.maxFrameMs, {
    unit: "millisecond",
    attributes: telemetryAttributes,
  });
  Sentry.metrics.count("chess.move.slow_frame", move.slowFrames, {
    attributes: telemetryAttributes,
  });
  if (move.stateAt !== null)
    Sentry.metrics.distribution("chess.move.state", move.stateAt - move.startedAt, {
      unit: "millisecond",
      attributes: telemetryAttributes,
    });
  if (move.boardAt !== null)
    Sentry.metrics.distribution("chess.move.board", move.boardAt - move.startedAt, {
      unit: "millisecond",
      attributes: telemetryAttributes,
    });
  move.span.end();
  activeMove = null;
}

function watchFrames(move: ActiveMove) {
  try {
    move.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        move.span.addEvent("ui.long_task", {
          "longtask.duration_ms": entry.duration,
        });
      }
    });
    move.observer.observe({ type: "longtask" });
  } catch {
    move.observer = null;
  }
  const frame = (now: number) => {
    if (activeMove !== move) return;
    if (move.lastFrameAt !== null) {
      const gap = now - move.lastFrameAt;
      move.maxFrameMs = Math.max(move.maxFrameMs, gap);
      if (gap > SLOW_FRAME_MS) move.slowFrames += 1;
    }
    move.lastFrameAt = now;
    move.frames += 1;
    if (now - (move.boardAt ?? now) >= ANIMATION_WINDOW_MS) {
      finishMove(move);
      return;
    }
    move.frameRequest = requestAnimationFrame(frame);
  };
  move.frameRequest = requestAnimationFrame(frame);
  move.timeout = window.setTimeout(() => finishMove(move), ANIMATION_WINDOW_MS + 100);
}

function startMove(source: MoveSource) {
  if (activeMove) finishMove(activeMove, "interrupted");
  ensureInitialized();
  const startedAt = performance.now();
  const span = Sentry.startInactiveSpan({
    name: "chess.move.render",
    op: "ui.chess.move",
    forceTransaction: true,
    attributes: {
      "chess.move.source": source,
      "device.pointer": deviceClass(),
    },
  });
  activeMove = {
    source,
    startedAt,
    span,
    stateAt: null,
    boardAt: null,
    fen: null,
    lastFrameAt: null,
    maxFrameMs: 0,
    slowFrames: 0,
    frames: 0,
    frameRequest: null,
    timeout: null,
    observer: null,
  };
}

export function startLocalMoveTelemetry() {
  startMove("local");
}

export function hasMoveTelemetry() {
  return activeMove !== null;
}

export function recordServerMoveTelemetry(fen: string, source: MoveSource) {
  if (!activeMove) startMove(source);
  if (!activeMove) return;
  activeMove.stateAt = performance.now();
  activeMove.fen = fen;
}

export function recordBoardMoveTelemetry(fen: string) {
  const move = activeMove;
  if (!move || move.fen !== fen || move.boardAt !== null) return;
  move.boardAt = performance.now();
  watchFrames(move);
}

export function failMoveTelemetry() {
  if (activeMove) finishMove(activeMove, "error");
}
