"use client";

import * as Sentry from "@sentry/react";

const DSN =
  "https://69f4666f8a913ed118913d18660fe20d@o4511927634296832.ingest.us.sentry.io/4511927685939200";

let initialized = false;
let recording = false;

function ensureInit() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  Sentry.init({
    dsn: DSN,
    // Replays are started manually when a game begins; never auto-sample.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    integrations: [
      // Unmasked so the replay actually shows the board and player names.
      Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false }),
    ],
  });
}

export function startGameReplay(room: string, gameId: string, role: string) {
  ensureInit();
  const replay = Sentry.getReplay();
  if (!replay) return;
  Sentry.setTags({
    "chess.room.id": room,
    "chess.game.id": gameId,
    "chess.player.role": role,
  });
  if (recording) return;
  recording = true;
  try {
    replay.start();
  } catch {
    // Already running (e.g. hot reload); the session keeps recording.
  }
}

export async function stopGameReplay() {
  if (!recording) return;
  recording = false;
  try {
    await Sentry.getReplay()?.stop();
  } catch {
    // Not running; nothing to flush.
  }
}
