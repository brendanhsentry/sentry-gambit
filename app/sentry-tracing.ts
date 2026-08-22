"use client";

import * as Sentry from "@sentry/react";

const DSN =
  "https://69f4666f8a913ed118913d18660fe20d@o4511927634296832.ingest.us.sentry.io/4511927685939200";
const MOVE_ANIMATION_TRACE_MS = 240;

type MoveSource = "local" | "remote";

let initialized = false;
let moveSpan: ReturnType<typeof Sentry.startInactiveSpan> | null = null;
let expectedFen: string | null = null;
let traceEndTimer: number | null = null;

function finishMoveTrace() {
  if (traceEndTimer !== null) window.clearTimeout(traceEndTimer);
  traceEndTimer = null;
  moveSpan?.end();
  moveSpan = null;
  expectedFen = null;
}

function initializeSentry() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  Sentry.init({
    dsn: DSN,
    tracesSampleRate: 1,
    profileSessionSampleRate: 1,
    profileLifecycle: "trace",
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.browserProfilingIntegration(),
    ],
  });
}

function startMoveTrace(source: MoveSource) {
  finishMoveTrace();
  initializeSentry();
  moveSpan = Sentry.startInactiveSpan({
    name: "chess.move",
    op: "ui.chess.move",
    forceTransaction: true,
    attributes: { "chess.move.source": source },
  });
  expectedFen = null;
}

export function startLocalMoveTrace() {
  startMoveTrace("local");
}

export function hasMoveTrace() {
  return moveSpan !== null;
}

export function recordServerMoveTrace(fen: string, source: MoveSource) {
  if (!moveSpan) startMoveTrace(source);
  expectedFen = fen;
  moveSpan?.addEvent("chess.move.server_state_received");
}

export function recordBoardMoveTrace(fen: string) {
  if (!moveSpan || expectedFen !== fen || traceEndTimer !== null) return;
  moveSpan.addEvent("chess.move.board_applied");
  traceEndTimer = window.setTimeout(finishMoveTrace, MOVE_ANIMATION_TRACE_MS);
}

export function failMoveTrace() {
  moveSpan?.addEvent("chess.move.rejected");
  finishMoveTrace();
}
