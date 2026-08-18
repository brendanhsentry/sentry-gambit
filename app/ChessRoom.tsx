"use client";

import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import Image from "next/image";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Color as GroundColor,
  Dests,
  Key,
  SquareClasses,
} from "@lichess-org/chessground/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChessgroundBoard } from "./ChessgroundBoard";
import { IconSeer } from "./IconSeer";
import {
  playCapture,
  playCheck,
  playGameEnd,
  playMove,
  setSoundsMuted,
  soundsMuted,
} from "./board-sounds";
import { PIECE_GLYPHS } from "./chess-pieces";
import { startGameReplay, stopGameReplay } from "./sentry-replay";
import {
  engineBestMove,
  gradeLabel,
  useMoveAnalysis,
  type MoveGrade,
  type ReviewMove,
} from "./move-analysis";
import { BOTS, useMaiaEngine, type BotKey } from "./maia-bot";

type Role = "w" | "b" | "spectator";

type ClockState = {
  w: number;
  b: number;
  running: Color | null;
  since: number | null;
};

type GameState = {
  room: string;
  gameId: string;
  fen: string;
  history: ReviewMove[];
  players: { w: string | null; b: string | null };
  result: string | null;
  initialTimeMs: number;
  clock: ClockState;
  bot: { key: BotKey; name: string; elo: number; color: Color } | null;
  coach?: boolean;
  undoRequest?: { by: Color } | null;
  drawOffer?: { by: Color } | null;
};

type ServerMessage =
  | { type: "welcome"; role: Role; playerId: string; state: GameState }
  | { type: "state"; state: GameState }
  | { type: "error"; message: string };

type MoveExplanation =
  | { phase: "loading" }
  | {
      phase: "done" | "error";
      motif: string | null;
      explanation: string | null;
      playedLine: string[];
      bestLine: string[];
      requestId?: string;
      message?: string;
    };

const START_FEN = new Chess().fen();
const TIME_CONTROLS = [1, 3, 5, 10, 15] as const;
type TimeControl = (typeof TIME_CONTROLS)[number];
const DEFAULT_TIME_CONTROL: TimeControl = 10;
const TIME_CONTROL_NAMES: Record<TimeControl, string> = {
  1: "Bullet",
  3: "Blitz",
  5: "Blitz",
  10: "Rapid",
  15: "Rapid",
};
const TRAY_ORDER = ["q", "r", "b", "n", "p"] as const;
const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

type BadgeKind = "win" | "draw" | "mate" | "time" | "resign";
const STARTING_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };

// Pieces missing from the board versus what each side should still own,
// with promotions counted so a promoted queen is not mistaken for a capture.
function capturedPieces(fen: string, history: ReviewMove[]) {
  const expected: Record<Color, Record<string, number>> = {
    w: { ...STARTING_COUNTS },
    b: { ...STARTING_COUNTS },
  };
  for (const move of history) {
    if (move.promotion) {
      expected[move.color].p -= 1;
      expected[move.color][move.promotion] += 1;
    }
  }
  const onBoard: Record<Color, Record<string, number>> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };
  for (const ch of fen.split(" ")[0]) {
    const lower = ch.toLowerCase();
    if (lower in onBoard.w) onBoard[ch === lower ? "b" : "w"][lower] += 1;
  }
  const captured: Record<Color, PieceSymbol[]> = { w: [], b: [] };
  for (const color of ["w", "b"] as const) {
    for (const type of TRAY_ORDER) {
      const missing = expected[color][type] - onBoard[color][type];
      for (let i = 0; i < missing; i++) captured[color].push(type);
    }
  }
  return captured;
}
const EXPLAINABLE_GRADES = new Set([
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
]);
const COACH_ALERT_GRADES = new Set(["mistake", "miss", "blunder"]);
const COACH_PRAISE_GRADES = new Set(["brilliant", "great"]);

type CoachItem = {
  id: number;
  ply: number;
  kind: "mistake" | "praise";
  grade: MoveGrade;
  san: string;
  bestSan: string | null;
  text: string;
  motif: string | null;
  thinking: boolean;
};

type CoachHint =
  | { phase: "loading"; tier: "maia" | "best" }
  | {
      phase: "shown";
      tier: "maia" | "best";
      from: Square;
      to: Square;
      san: string;
      fen: string;
    };

function sanFromUci(fen: string, uci: string) {
  try {
    return new Chess(fen).move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: (uci[4] as PieceSymbol | undefined) ?? undefined,
    }).san;
  } catch {
    return null;
  }
}
function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 6 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");
}

function browserPlayerKey() {
  const storageKey = "pawn-patrol-player-key";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = window.crypto.randomUUID();
  window.localStorage.setItem(storageKey, created);
  return created;
}

function formatClock(ms: number) {
  const safe = Math.max(0, ms);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const tenths = Math.floor((safe % 1_000) / 100);
  return safe < 10_000
    ? `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function projectedTime(clock: ClockState, color: Color, now: number) {
  if (clock.running !== color || clock.since === null) return clock[color];
  return Math.max(0, clock[color] - (now - clock.since));
}

function playerLabel(role: Role) {
  if (role === "w") return "Playing white";
  if (role === "b") return "Playing black";
  return "Watching table";
}

function relativeStatus(state: GameState, role: Role) {
  if (state.result) return state.result;
  const chess = new Chess(state.fen);
  const turn = chess.turn();
  if (role === turn)
    return chess.isCheck() ? "Your king is in check" : "Your move";
  if (role === "spectator")
    return `${turn === "w" ? "White" : "Black"} to move`;
  return "Opponent’s move";
}

function useClock(clock: ClockState | null, onFlag: () => void) {
  const [now, setNow] = useState(() => Date.now());
  const flagged = useRef(false);

  useEffect(() => {
    flagged.current = false;
  }, [clock?.running, clock?.since]);

  useEffect(() => {
    if (!clock?.running) return;
    const id = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (!flagged.current && projectedTime(clock, clock.running!, next) <= 0) {
        flagged.current = true;
        onFlag();
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [clock, onFlag]);

  return now;
}

function PlayerCard({
  name,
  color,
  time,
  active,
  bottom,
  captured,
  advantage,
}: {
  name: string | null;
  color: Color;
  time: number;
  active: boolean;
  bottom?: boolean;
  captured?: PieceSymbol[];
  advantage?: number;
}) {
  const fallback = color === "w" ? "Waiting for white" : "Waiting for black";
  return (
    <div className={`player-card ${bottom ? "player-card--bottom" : ""}`}>
      <div className={`player-avatar player-avatar--${color}`}>
        {color === "w" ? "W" : "B"}
      </div>
      <div className="player-identity">
        <strong>{name || fallback}</strong>
        <span>
          {name ? (active ? "Thinking…" : "At the table") : "Open seat"}
        </span>
      </div>
      {captured && captured.length > 0 && (
        <div
          className={`captured-tray piece--${color === "w" ? "b" : "w"}`}
          aria-label={`Pieces captured by ${color === "w" ? "white" : "black"}`}
        >
          {captured.map((type, index) => (
            <span key={`${type}${index}`}>{PIECE_GLYPHS[type]}</span>
          ))}
          {(advantage ?? 0) > 0 && (
            <small className="captured-lead">+{advantage}</small>
          )}
        </div>
      )}
      <div
        className={`clock ${active ? "clock--active" : ""}`}
        aria-label={`${color === "w" ? "White" : "Black"} clock`}
      >
        {formatClock(time)}
      </div>
    </div>
  );
}

export function ChessRoom() {
  const socketRef = useRef<WebSocket | null>(null);
  const [roomInput, setRoomInput] = useState("");
  const [invitedRoom, setInvitedRoom] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [timeControl, setTimeControl] =
    useState<TimeControl>(DEFAULT_TIME_CONTROL);
  const [room, setRoom] = useState("");
  const [role, setRole] = useState<Role>("spectator");
  const [connection, setConnection] = useState<
    "idle" | "connecting" | "online" | "offline"
  >("idle");
  const [state, setState] = useState<GameState | null>(null);
  const [promotion, setPromotion] = useState<{
    from: Square;
    to: Square;
    color: Color;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [resultDismissedFor, setResultDismissedFor] = useState<string | null>(
    null,
  );
  const [confirmResign, setConfirmResign] = useState(false);
  const [copied, setCopied] = useState(false);
  const [replayCopied, setReplayCopied] = useState(false);
  const [replayPly, setReplayPly] = useState<number | null>(null);
  const [analysisPly, setAnalysisPly] = useState<number | null>(null);
  const [moveExplanations, setMoveExplanations] = useState<
    Record<number, MoveExplanation>
  >({});
  const reportedGradesRef = useRef(new Set<string>());
  const explanationRequestsRef = useRef(new Set<number>());
  const {
    status: maiaStatus,
    progress: maiaProgress,
    load: loadMaia,
    pickMove,
  } = useMaiaEngine();
  const [pendingBot, setPendingBot] = useState<BotKey | null>(null);
  const botMoveKeyRef = useRef("");
  const latestStateRef = useRef<GameState | null>(null);
  const [coachEnabled, setCoachEnabled] = useState(true);
  const [coachFeed, setCoachFeed] = useState<CoachItem[]>([]);
  const [hint, setHint] = useState<CoachHint | null>(null);
  const coachSeenRef = useRef(new Set<string>());
  const coachBaselineRef = useRef<{ gameId: string; ply: number } | null>(null);
  const coachIdRef = useRef(1);

  const send = useCallback((payload: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  // Record a Sentry session replay only while a game is being played:
  // both seats filled, no result yet, and this client is one of the players.
  const gameActive = Boolean(
    state &&
    !state.result &&
    state.players.w &&
    state.players.b &&
    role !== "spectator",
  );
  useEffect(() => {
    if (gameActive && state) startGameReplay(state.room, state.gameId, role);
    else void stopGameReplay();
  }, [gameActive, state, role]);
  useEffect(() => () => void stopGameReplay(), []);

  const currentGameId = state?.gameId;

  type SeerReview =
    | { phase: "idle" }
    | { phase: "requesting" }
    | {
        phase: "running";
        issueId: string;
        shortId: string;
        activity: string[];
        draft: string | null;
      }
    | { phase: "done"; text: string; shortId: string }
    | { phase: "error"; message: string };
  const [seer, setSeer] = useState<SeerReview>({ phase: "idle" });

  useEffect(() => {
    // A new game means the previous review no longer applies.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeer({ phase: "idle" });
    setReplayPly(null);
    setAnalysisPly(null);
    setMoveExplanations({});
    setReplayCopied(false);
    explanationRequestsRef.current.clear();
  }, [currentGameId]);

  const requestSeerReview = useCallback(async () => {
    if (!currentGameId) return;
    setSeer({ phase: "requesting" });
    // The finished game can take a minute to be indexed by Sentry; retry.
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const res = await fetch(
          `/api/review?gameId=${encodeURIComponent(currentGameId)}`,
          { method: "POST" },
        );
        if (res.ok) {
          const data = await res.json();
          setSeer({
            phase: "running",
            issueId: String(data.issueId),
            shortId: String(data.shortId ?? ""),
            activity: [],
            draft: null,
          });
          return;
        }
        if (res.status !== 404) {
          const data = await res.json().catch(() => ({}) as { error?: string });
          setSeer({
            phase: "error",
            message: data.error ?? "The review could not be started.",
          });
          return;
        }
      } catch {
        // Network hiccup; retry below.
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    setSeer({
      phase: "error",
      message: "The game has not reached Sentry yet. Try again in a minute.",
    });
  }, [currentGameId]);

  // The full verdict opens in a slide-out panel; the widget stays as a preview.
  const [seerExpanded, setSeerExpanded] = useState(false);
  useEffect(() => {
    // A finished review is worth the reader's full attention.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (seer.phase === "done") setSeerExpanded(true);
  }, [seer.phase]);
  useEffect(() => {
    if (!seerExpanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSeerExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seerExpanded]);

  // The widget preview is clipped, not scrollable; the fade + "read more"
  // affordance only appears when the verdict actually overflows the clip.
  const seerPreviewRef = useRef<HTMLDivElement | null>(null);
  const [seerOverflows, setSeerOverflows] = useState(false);
  useEffect(() => {
    if (seer.phase !== "done") return;
    const el = seerPreviewRef.current;
    if (el) setSeerOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [seer]);

  const [seerCopied, setSeerCopied] = useState(false);
  const copySeerReview = useCallback(() => {
    if (seer.phase !== "done") return;
    void navigator.clipboard.writeText(seer.text).then(() => {
      setSeerCopied(true);
      setTimeout(() => setSeerCopied(false), 1500);
    });
  }, [seer]);

  useEffect(() => {
    if (seer.phase !== "running") return;
    const id = window.setInterval(async () => {
      try {
        const res = await fetch(
          `/api/review/status?issueId=${encodeURIComponent(seer.issueId)}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === "completed" && data.text) {
          setSeer({ phase: "done", text: data.text, shortId: seer.shortId });
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
        // Keep polling.
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [seer]);

  const analysis = useMoveAnalysis(
    currentGameId ?? room,
    state?.history ?? [],
    Boolean(state?.history.length),
  );

  useEffect(() => {
    if (!currentGameId || connection !== "online") return;

    analysis.moves.forEach((reviewed, index) => {
      if (!reviewed) return;
      const ply = index + 1;
      const reportKey = `${currentGameId}:${ply}`;
      if (reportedGradesRef.current.has(reportKey)) return;

      const sent = send({
        type: "move_grade",
        gameId: currentGameId,
        ply,
        grade: reviewed.grade,
        expectedPointsLoss: reviewed.expectedPointsLoss,
      });
      if (sent) reportedGradesRef.current.add(reportKey);
    });
  }, [analysis.moves, connection, currentGameId, send]);

  const flagClock = useCallback(() => send({ type: "flag" }), [send]);
  const now = useClock(state?.clock ?? null, flagClock);

  useEffect(() => {
    latestStateRef.current = state;
  }, [state]);

  // Rejoining a bot room (e.g. after a refresh) needs the engine warmed up.
  useEffect(() => {
    if (state?.bot && !state.result && role !== "spectator" && maiaStatus === "idle") {
      loadMaia().catch(() => {});
    }
  }, [state, role, maiaStatus, loadMaia]);

  // The seated human's browser runs the bot: whenever it is the bot's turn,
  // ask Maia for a move and relay it to the server.
  useEffect(() => {
    const bot = state?.bot;
    if (!state || !bot || state.result || role === "spectator" || connection !== "online")
      return;
    if (new Chess(state.fen).turn() !== bot.color) {
      // Reset so an undo returning to a previously seen ply retriggers the bot.
      botMoveKeyRef.current = "";
      return;
    }
    const moveKey = `${state.gameId}:${state.history.length}`;
    if (botMoveKeyRef.current === moveKey) return;
    botMoveKeyRef.current = moveKey;
    const thinkingTime = 600 + Math.random() * 1400;
    void Promise.all([
      pickMove(state.fen, bot.elo),
      new Promise((resolve) => setTimeout(resolve, thinkingTime)),
    ])
      .then(([move]) => {
        const current = latestStateRef.current;
        if (
          current &&
          !current.result &&
          `${current.gameId}:${current.history.length}` === moveKey
        ) {
          send({ type: "move", ...move });
        }
      })
      .catch(() => {
        botMoveKeyRef.current = "";
        setNotice(`${bot.name} crashed while thinking. It will retry on the next update.`);
      });
  }, [state, role, connection, pickMove, send]);

  // Coach Ming watches the live grades and speaks up on notable moves.
  useEffect(() => {
    if (!state?.coach || !state.bot || role === "spectator") return;
    if (coachBaselineRef.current?.gameId !== state.gameId) {
      // Joining mid-game (e.g. after a refresh) must not replay the backlog.
      coachBaselineRef.current = { gameId: state.gameId, ply: state.history.length };
      coachSeenRef.current.clear();
      setCoachFeed([]);
      return;
    }
    if (state.result) return;
    const baseline = coachBaselineRef.current.ply;
    analysis.moves.forEach((reviewed, index) => {
      const ply = index + 1;
      const move = state.history[index];
      if (!reviewed || !move || ply <= baseline || move.color !== role) return;
      const isAlert = COACH_ALERT_GRADES.has(reviewed.grade);
      if (!isAlert && !COACH_PRAISE_GRADES.has(reviewed.grade)) return;
      const seenKey = `${state.gameId}:${ply}:${move.san}`;
      if (coachSeenRef.current.has(seenKey)) return;
      coachSeenRef.current.add(seenKey);
      const bestSan = reviewed.evidence
        ? sanFromUci(reviewed.evidence.fenBefore, reviewed.evidence.bestLine[0])
        : null;
      const id = coachIdRef.current++;
      const item: CoachItem = isAlert
        ? {
            id,
            ply,
            kind: "mistake",
            grade: reviewed.grade,
            san: move.san,
            bestSan,
            text: bestSan
              ? `Stockfish prefers ${bestSan} here.`
              : "There was a stronger idea in this position.",
            motif: null,
            thinking: true,
          }
        : {
            id,
            ply,
            kind: "praise",
            grade: reviewed.grade,
            san: move.san,
            bestSan: null,
            text:
              reviewed.grade === "brilliant"
                ? "A sacrifice that works — Stockfish approves. Beautifully done."
                : "You found the one move that keeps the advantage.",
            motif: null,
            thinking: false,
          };
      setCoachFeed((current) => [item, ...current].slice(0, 6));
      if (!isAlert || !reviewed.evidence) return;
      void fetch("/api/move-explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade: reviewed.grade, ...reviewed.evidence }),
      })
        .then(async (response) => {
          const data = (await response.json()) as {
            motif?: string;
            explanation?: string;
          };
          if (!response.ok || !data.explanation) throw new Error("unavailable");
          setCoachFeed((current) =>
            current.map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    text: data.explanation!,
                    motif: data.motif ?? null,
                    thinking: false,
                  }
                : entry,
            ),
          );
        })
        .catch(() => {
          setCoachFeed((current) =>
            current.map((entry) =>
              entry.id === id ? { ...entry, thinking: false } : entry,
            ),
          );
        });
    });
  }, [analysis.moves, state, role]);

  async function requestHint(tier: "maia" | "best") {
    const started = latestStateRef.current;
    if (!started?.bot || started.result) return;
    const fen = started.fen;
    setHint({ phase: "loading", tier });
    try {
      let uci: string;
      if (tier === "best") {
        uci = (await engineBestMove(fen)).move;
      } else {
        const picked = await pickMove(fen, started.bot.elo);
        uci = `${picked.from}${picked.to}${picked.promotion ?? ""}`;
      }
      const san = sanFromUci(fen, uci);
      if (!san || latestStateRef.current?.fen !== fen) {
        setHint(null);
        return;
      }
      setHint({
        phase: "shown",
        tier,
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        san,
        fen,
      });
    } catch {
      setHint(null);
      setNotice("The coach could not find a hint. Try again.");
    }
  }

  async function startBotGame(bot: BotKey) {
    setPendingBot(bot);
    try {
      await loadMaia();
      const nextRoom = makeRoomCode();
      setRoomInput(nextRoom);
      connect(nextRoom, name, bot, timeControl * 60_000, coachEnabled);
    } catch {
      setNotice("The bot engine could not be loaded. Try again.");
    } finally {
      setPendingBot(null);
    }
  }

  const viewHistory = useMemo(() => state?.history ?? [], [state?.history]);

  async function requestMoveExplanation(index: number) {
    const ply = index + 1;
    setAnalysisPly(ply);
    goToPly(ply);

    const reviewed = analysis.moves[index];
    if (
      !state?.result ||
      !reviewed?.evidence ||
      (role !== "spectator" && state.history[index]?.color !== role) ||
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
        motif?: string;
        explanation?: string;
        playedLine?: string[];
        bestLine?: string[];
        requestId?: string;
        error?: string;
      };
      const playedLine = Array.isArray(data.playedLine) ? data.playedLine : [];
      const bestLine = Array.isArray(data.bestLine) ? data.bestLine : [];
      if (!response.ok || !data.explanation) {
        setMoveExplanations((current) => ({
          ...current,
          [ply]: {
            phase: "error",
            motif: null,
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
          motif: data.motif ?? "unclear",
          explanation: data.explanation ?? null,
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
          motif: null,
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

  const lastPly = viewHistory.length;
  const viewedPly = replayPly ?? lastPly;
  const viewFen = useMemo(() => {
    if (viewedPly === lastPly) return state?.fen ?? START_FEN;
    const position = new Chess();
    for (const move of viewHistory.slice(0, viewedPly)) {
      position.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion ?? "q",
      });
    }
    return position.fen();
  }, [lastPly, state?.fen, viewHistory, viewedPly]);

  const chess = useMemo(() => {
    try {
      return new Chess(viewFen);
    } catch {
      return new Chess();
    }
  }, [viewFen]);

  const [muted, setMuted] = useState(false);
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

  const prevBoardRef = useRef<{ key: string; ply: number; fen: string } | null>(
    null,
  );
  const boardKey = currentGameId ?? "";

  useEffect(() => {
    const prev = prevBoardRef.current;
    prevBoardRef.current = { key: boardKey, ply: viewedPly, fen: viewFen };
    if (!prev || prev.key !== boardKey || prev.fen === viewFen) return;
    const forward = viewedPly - prev.ply === 1;
    if (!forward && prev.ply - viewedPly !== 1) return;
    const move = viewHistory[(forward ? viewedPly : prev.ply) - 1];
    if (!move) return;
    if (forward && (move.san.includes("+") || move.san.includes("#")))
      playCheck();
    else if (forward && move.san.includes("x")) playCapture();
    else playMove();
  }, [boardKey, viewedPly, viewFen, viewHistory]);

  // Chime when the game we were watching or playing reaches a result.
  const resultSoundRef = useRef<{ gameId: string; hadResult: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!state) return;
    const prev = resultSoundRef.current;
    resultSoundRef.current = {
      gameId: state.gameId,
      hadResult: Boolean(state.result),
    };
    if (state.result && prev?.gameId === state.gameId && !prev.hadResult)
      playGameEnd();
  }, [state]);

  const connect = useCallback((
    nextRoom: string,
    nextName: string,
    bot?: BotKey,
    initialTimeMs?: number,
    coach?: boolean,
  ) => {
    const cleanRoom = nextRoom
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    const cleanName = nextName.trim().slice(0, 24) || "Guest player";
    if (!cleanRoom) return;

    socketRef.current?.close();
    setReplayPly(null);
    setConnection("connecting");
    setRoom(cleanRoom);
    setNotice("");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const playerKey = browserPlayerKey();
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(cleanRoom)}&name=${encodeURIComponent(cleanName)}&playerKey=${encodeURIComponent(playerKey)}${bot ? `&bot=${bot}` : ""}${initialTimeMs ? `&time=${initialTimeMs}` : ""}${bot && coach ? "&coach=1" : ""}`,
    );
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnection("online");
      window.history.replaceState({}, "", `?room=${cleanRoom}`);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === "welcome") {
        setRole(message.role);
        setState(message.state);
      } else if (message.type === "state") {
        setState(message.state);
        setPromotion(null);
      } else if (message.type === "error") {
        setNotice(message.message);
      }
    });
    socket.addEventListener("close", () => {
      // A socket we replaced or abandoned must not clobber the connection state.
      if (socketRef.current === socket) setConnection("offline");
    });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incomingRoom = params.get("room");
    // This synchronizes the invite code from the browser URL on first mount.
    if (incomingRoom) {
      const cleaned = incomingRoom
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 8);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRoomInput(cleaned);
      setInvitedRoom(cleaned || null);
    }
    return () => socketRef.current?.close();
  }, []);

  const currentBotKey = state?.bot?.key;
  const currentCoach = state?.coach;
  useEffect(() => {
    if (connection !== "offline" || !room) return;
    const id = window.setTimeout(
      () => connect(room, name, currentBotKey, state?.initialTimeMs, currentCoach),
      1600,
    );
    return () => window.clearTimeout(id);
  }, [connection, room, name, currentBotKey, currentCoach, state?.initialTimeMs, connect]);

  const orientation: Color = role === "b" ? "b" : "w";
  const lastMove = viewHistory[viewedPly - 1];
  const lastMoveSquares = useMemo(
    () =>
      lastMove
        ? ([lastMove.from as Key, lastMove.to as Key] as Key[])
        : undefined,
    [lastMove],
  );
  const topColor: Color = orientation === "w" ? "b" : "w";
  const bottomColor: Color = orientation;
  const displayedPlayers = state?.players ?? { w: null, b: null };
  const idleTime = timeControl * 60_000;
  const topTime = state ? projectedTime(state.clock, topColor, now) : idleTime;
  const bottomTime = state
    ? projectedTime(state.clock, bottomColor, now)
    : idleTime;

  const captured = useMemo(
    () => capturedPieces(viewFen, viewHistory.slice(0, viewedPly)),
    [viewFen, viewHistory, viewedPly],
  );
  // Positive means white leads on material; the tray shows it on one side only.
  const materialLead = useMemo(() => {
    const points = (list: PieceSymbol[]) =>
      list.reduce((sum, type) => sum + PIECE_VALUES[type], 0);
    return points(captured.b) - points(captured.w);
  }, [captured]);

  // King badges only decorate the final position of a decided game.
  const finishBadges = useMemo((): Record<Color, BadgeKind> | null => {
    const result = state?.result;
    if (!result || viewedPly !== lastPly) return null;
    if (result.startsWith("Draw")) return { w: "draw", b: "draw" };
    const winner = result.startsWith("White")
      ? "w"
      : result.startsWith("Black")
        ? "b"
        : null;
    if (!winner) return null;
    const reason: BadgeKind = result.includes("checkmate")
      ? "mate"
      : result.includes("time")
        ? "time"
        : "resign";
    return winner === "w"
      ? { w: "win", b: reason }
      : { w: reason, b: "win" };
  }, [state?.result, viewedPly, lastPly]);

  const canControlBoard =
    replayPly === null &&
    !!state &&
    !state.result &&
    role !== "spectator";
  const canInteract = canControlBoard && chess.turn() === role;
  const coachActive = Boolean(
    state?.coach && state.bot && !state.result && role !== "spectator",
  );

  // A hint is tied to the position it was computed for; it vanishes on the next move.
  const hintVisible =
    hint?.phase === "shown" && hint.fen === state?.fen;
  const hintShapes = useMemo(
    () =>
      hint?.phase === "shown" && hint.fen === state?.fen && replayPly === null
        ? [
            {
              orig: hint.from as Key,
              dest: hint.to as Key,
              brush: hint.tier === "best" ? "green" : "blue",
            },
          ]
        : [],
    [hint, replayPly, state?.fen],
  );

  const finishBadgeSquares = useMemo(() => {
    const classes: SquareClasses = new Map();
    if (!finishBadges) return classes;
    for (const color of ["w", "b"] as const) {
      const king = chess.findPiece({ type: "k", color })[0];
      if (king) {
        classes.set(
          king as Key,
          `king-badge king-badge--${finishBadges[color]}`,
        );
      }
    }
    return classes;
  }, [chess, finishBadges]);

  const legalDests = useMemo(() => {
    const dests: Dests = new Map();
    if (!canInteract) return dests;
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key;
      const current = dests.get(from);
      if (current) current.push(move.to as Key);
      else dests.set(from, [move.to as Key]);
    }
    return dests;
  }, [canInteract, chess]);

  function tryMove(from: Square, to: Square) {
    if (role === "spectator") return false;
    const options = chess
      .moves({ square: from, verbose: true })
      .filter((move) => move.to === to);
    if (!options.length) return false;
    if (options.some((move) => move.promotion)) {
      setPromotion({ from, to, color: role });
      return true;
    }
    send({ type: "move", from, to });
    return true;
  }

  function goToPly(ply: number) {
    const next = Math.max(0, Math.min(lastPly, ply));
    setReplayPly(next === lastPly ? null : next);
    setPromotion(null);
  }

  useEffect(() => {
    if (lastPly === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      goToPly(viewedPly + (event.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function startTable() {
    const nextRoom = makeRoomCode();
    setRoomInput(nextRoom);
    connect(nextRoom, name, undefined, timeControl * 60_000);
  }

  async function copyInvite() {
    const url = `${window.location.origin}/?room=${room}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setNotice(`Share room code ${room}`);
    }
  }

  async function copyReplay() {
    if (!state?.result) return;
    const url = `${window.location.origin}/games/${state.gameId}`;
    try {
      await navigator.clipboard.writeText(url);
      setReplayCopied(true);
      window.setTimeout(() => setReplayCopied(false), 1600);
    } catch {
      setNotice(`Replay link: ${url}`);
    }
  }

  const movePairs = viewHistory.reduce<
    Array<{
      number: number;
      w?: { san: string; index: number };
      b?: { san: string; index: number };
    }>
  >((pairs, move, index) => {
    if (index % 2 === 0)
      pairs.push({
        number: Math.floor(index / 2) + 1,
        w: { san: move.san, index },
      });
    else pairs[pairs.length - 1].b = { san: move.san, index };
    return pairs;
  }, []);
  const selectedReview = analysisPly ? analysis.moves[analysisPly - 1] : null;
  const selectedExplanation = analysisPly
    ? moveExplanations[analysisPly]
    : null;
  const explainableMoves = analysis.moves.flatMap((reviewed, index) =>
    reviewed?.evidence &&
    EXPLAINABLE_GRADES.has(reviewed.grade) &&
    (role === "spectator" || viewHistory[index]?.color === role)
      ? [{ index, reviewed, move: viewHistory[index] }]
      : [],
  );
  function moveCell(move?: { san: string; index: number }) {
    if (!move)
      return (
        <span className="move-cell">
          <span>—</span>
        </span>
      );
    const reviewed = state?.result ? analysis.moves[move.index] : null;
    const title = reviewed
      ? `${gradeLabel(reviewed.grade)}${reviewed.expectedPointsLoss === null ? "" : ` · ${(reviewed.expectedPointsLoss * 100).toFixed(1)} expected points lost`}`
      : undefined;
    return (
      <button
        className={`move-cell ${viewedPly === move.index + 1 ? "is-current" : ""}`}
        title={title}
        onClick={() => void requestMoveExplanation(move.index)}
        aria-label={`Show position after ${move.san}`}
      >
        <span>{move.san}</span>
        {reviewed && (
          <small className={`move-grade move-grade--${reviewed.grade}`}>
            {gradeLabel(reviewed.grade)}
          </small>
        )}
      </button>
    );
  }

  return (
    <main className="app-shell">
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
        <div className="topbar-actions">
          <Link className="text-button" href="/games">
            Past games
          </Link>
          <button
            className="text-button"
            onClick={() => {
              socketRef.current?.close();
              socketRef.current = null;
              setConnection("idle");
              setRoom("");
              setState(null);
              setReplayPly(null);
              setInvitedRoom(null);
              setRoomInput("");
              window.history.replaceState({}, "", "/");
            }}
          >
            New table
          </button>
        </div>
      </header>

      <section className="game-layout">
        <div className="board-column">
          <div className="eyebrow-row">
            <span>{room ? `PRIVATE TABLE · ${room}` : "PRIVATE TABLE"}</span>
            <span className="eyebrow-tools">
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
              <span className={`connection ${connection}`}>
                {connection === "online"
                  ? "CONNECTED"
                  : connection === "connecting"
                    ? "CONNECTING"
                    : connection === "offline"
                      ? "RECONNECTING"
                      : "READY"}
              </span>
            </span>
          </div>

          {state?.bot &&
            !state.result &&
            role !== "spectator" &&
            maiaStatus !== "ready" && (
              <div className="bot-status" role="status">
                {maiaStatus === "error"
                  ? `${state.bot.name} failed to boot. Refresh to retry.`
                  : `Booting ${state.bot.name}… ${maiaProgress}%`}
              </div>
            )}

          <PlayerCard
            name={displayedPlayers[topColor]}
            color={topColor}
            time={topTime}
            active={state?.clock.running === topColor && !state.result}
            captured={captured[bottomColor]}
            advantage={topColor === "w" ? materialLead : -materialLead}
          />

          <div className="board-wrap">
            <ChessgroundBoard
              fen={viewFen}
              orientation={orientation === "w" ? "white" : "black"}
              turnColor={chess.turn() === "w" ? "white" : "black"}
              check={
                chess.isCheck()
                  ? chess.turn() === "w"
                    ? "white"
                    : "black"
                  : false
              }
              lastMove={lastMoveSquares}
              movableColor={
                canControlBoard
                  ? ((role === "w" ? "white" : "black") as GroundColor)
                  : undefined
              }
              dests={legalDests}
              premoveEnabled={canControlBoard}
              customSquareClasses={finishBadgeSquares}
              autoShapes={hintShapes}
              onMove={(from, to) => tryMove(from as Square, to as Square)}
              resetKey={promotion ? `${promotion.from}${promotion.to}` : ""}
              ariaLabel={`Chess board, ${orientation === "w" ? "white" : "black"} orientation`}
            />

            {connection === "idle" && (
              <div className="lobby-card">
                {invitedRoom ? (
                  <>
                    <span className="lobby-kicker">YOU&apos;RE INVITED</span>
                    <h1>Take your seat.</h1>
                    <p>
                      You&apos;ve been invited to table {invitedRoom}. Enter a
                      name and join the game.
                    </p>
                    <label>
                      <span>Your name</span>
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="e.g. Magnus"
                        maxLength={24}
                      />
                    </label>
                    <button
                      className="primary-button"
                      onClick={() => connect(invitedRoom, name)}
                    >
                      Join table {invitedRoom} <span>→</span>
                    </button>
                  </>
                ) : (
                  <>
                    <span className="lobby-kicker">PLAY HEAD TO HEAD</span>
                    <h1>
                      Your board.
                      <br />
                      Your move.
                    </h1>
                    <p>
                      Create a private table or enter a code from a friend. No
                      account needed.
                    </p>
                    <label>
                      <span>Your name</span>
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="e.g. Magnus"
                        maxLength={24}
                      />
                    </label>
                    <fieldset className="time-control">
                      <legend>Time control</legend>
                      <div>
                        {TIME_CONTROLS.map((minutes) => (
                          <button
                            key={minutes}
                            type="button"
                            className={
                              timeControl === minutes ? "selected" : ""
                            }
                            onClick={() => setTimeControl(minutes)}
                            aria-pressed={timeControl === minutes}
                          >
                            <strong>{minutes === 15 ? "15 | 10" : `${minutes} min`}</strong>
                            <small>{TIME_CONTROL_NAMES[minutes]}</small>
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <button className="primary-button" onClick={startTable}>
                      Create a table <span>→</span>
                    </button>
                    <div className="join-row">
                      <input
                        value={roomInput}
                        onChange={(event) =>
                          setRoomInput(
                            event.target.value
                              .toUpperCase()
                              .replace(/[^A-Z0-9]/g, ""),
                          )
                        }
                        placeholder="ROOM CODE"
                        maxLength={8}
                        aria-label="Room code"
                      />
                      <button
                        onClick={() => connect(roomInput, name)}
                        disabled={!roomInput}
                      >
                        Join
                      </button>
                    </div>
                    <div className="bot-row">
                      <span>OR CHALLENGE THE PATROL</span>
                      <button
                        type="button"
                        className={`coach-toggle ${coachEnabled ? "coach-toggle--on" : ""}`}
                        onClick={() => setCoachEnabled((value) => !value)}
                        aria-pressed={coachEnabled}
                      >
                        <span className="coach-toggle-box" aria-hidden>
                          {coachEnabled ? "✓" : ""}
                        </span>
                        <span className="coach-toggle-copy">
                          <strong>Coach Ming watches your game</strong>
                          <small>
                            Live tips after mistakes, hints, and takebacks
                          </small>
                        </span>
                      </button>
                      <div className="bot-cards">
                        {(Object.keys(BOTS) as BotKey[]).map((key) => (
                          <button
                            key={key}
                            className={`bot-card bot-card--${key}`}
                            onClick={() => void startBotGame(key)}
                            disabled={pendingBot !== null}
                          >
                            <strong>{BOTS[key].name}</strong>
                            <small>ELO {BOTS[key].elo}</small>
                            {pendingBot === key && (
                              <em>
                                {maiaStatus === "loading"
                                  ? `LOADING ${maiaProgress}%`
                                  : "STARTING…"}
                              </em>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {state?.result &&
              replayPly === null &&
              resultDismissedFor !== state.gameId && (
                <div className="game-over" role="alertdialog" aria-label="Game over">
                  <div className="game-over-card">
                    <span>GAME OVER</span>
                    <strong>{state.result}</strong>
                    <div className="game-over-actions">
                      {role !== "spectator" && (
                        <button
                          className="game-over-rematch"
                          onClick={() => send({ type: "reset" })}
                        >
                          ↻ Rematch
                        </button>
                      )}
                      <button onClick={copyReplay}>
                        {replayCopied ? "Copied!" : "Share replay"}
                      </button>
                      <button
                        onClick={() => setResultDismissedFor(state.gameId)}
                      >
                        View board
                      </button>
                    </div>
                  </div>
                </div>
              )}
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
                        send({
                          type: "move",
                          from: promotion.from,
                          to: promotion.to,
                          promotion: piece,
                        })
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

          <PlayerCard
            name={displayedPlayers[bottomColor]}
            color={bottomColor}
            time={bottomTime}
            active={state?.clock.running === bottomColor && !state.result}
            bottom
            captured={captured[topColor]}
            advantage={bottomColor === "w" ? materialLead : -materialLead}
          />
        </div>

        <aside className="match-panel">
          <div className="match-heading">
            <span className="panel-kicker">MATCH ROOM</span>
            <h2>
              {replayPly !== null
                ? `Position ${viewedPly} of ${lastPly}`
                : state
                  ? relativeStatus(state, role)
                  : "Ready when you are"}
            </h2>
            <p>
              {replayPly !== null
                ? "Reviewing the live game. The clock is still running."
                : state
                  ? playerLabel(role)
                  : "One table. Two players. Every move live."}
            </p>
          </div>

          {room ? (
            <div className="invite-card">
              <span>
                {state
                  ? `${state.initialTimeMs / 60_000} MIN · INVITE CODE`
                  : "INVITE CODE"}
              </span>
              <div>
                <strong>{room}</strong>
                <button onClick={copyInvite}>
                  {copied ? "Copied!" : "Copy link"}
                </button>
              </div>
              <p>
                {state?.bot
                  ? `You are playing ${state.bot.name}. Anyone who joins with this code spectates.`
                  : state?.players.w && state?.players.b
                    ? "Both players are seated."
                    : "Share this with your opponent."}
              </p>
              {state?.result && (
                <button
                  className="replay-share-button"
                  onClick={copyReplay}
                >
                  {replayCopied ? "Replay link copied!" : "Share replay"}
                </button>
              )}
            </div>
          ) : (
            <div className="rule-card">
              <span>HOW IT WORKS</span>
              <ol>
                <li>
                  <b>01</b> Create a private table
                </li>
                <li>
                  <b>02</b> Share the six-character code
                </li>
                <li>
                  <b>03</b> Play in real time
                </li>
              </ol>
            </div>
          )}

          {coachActive && state && (
            <section className="live-coach" aria-label="Coach Ming live coaching">
              <div className="live-coach-head">
                <span className="live-coach-dot" aria-hidden />
                <span className="live-coach-title">COACH MING · LIVE</span>
                <button
                  className="live-coach-hint"
                  onClick={() => void requestHint("maia")}
                  disabled={!canInteract || hint?.phase === "loading"}
                  title={
                    canInteract
                      ? "Show a move a player at this level would consider"
                      : "Hints are available on your turn"
                  }
                >
                  {hint?.phase === "loading" ? "Thinking…" : "◈ Hint"}
                </button>
              </div>
              {hintVisible && hint.phase === "shown" && (
                <div className="live-coach-hintbox">
                  <strong>{hint.san}</strong>
                  <span>
                    {hint.tier === "best"
                      ? "Stockfish's top move."
                      : "a natural idea at this level."}
                  </span>
                  {hint.tier === "maia" && (
                    <button onClick={() => void requestHint("best")}>
                      Show best move
                    </button>
                  )}
                </div>
              )}
              <div className="live-coach-feed">
                {coachFeed.length === 0 ? (
                  <p className="live-coach-idle">
                    I&apos;m watching your game — I&apos;ll speak up when a move
                    deserves it. Stuck? Ask for a hint.
                  </p>
                ) : (
                  coachFeed.map((item) => {
                    const takebackable =
                      item.kind === "mistake" &&
                      !state.result &&
                      state.history.length >= item.ply &&
                      state.history.length - item.ply <= 1 &&
                      state.history[item.ply - 1]?.san === item.san;
                    return (
                      <div
                        key={item.id}
                        className={`coach-bubble coach-bubble--${item.kind}`}
                      >
                        <div className="coach-bubble-top">
                          <strong>
                            {Math.floor((item.ply - 1) / 2) + 1}
                            {(item.ply - 1) % 2 ? "…" : "."} {item.san}
                          </strong>
                          <span className={`move-grade move-grade--${item.grade}`}>
                            {gradeLabel(item.grade)}
                          </span>
                          {item.motif && (
                            <span className="coach-motif">{item.motif}</span>
                          )}
                        </div>
                        <p className={item.thinking ? "coach-thinking" : ""}>
                          {item.text}
                          {item.thinking && " Let me take a closer look…"}
                        </p>
                        {takebackable && (
                          <button
                            className="coach-takeback"
                            onClick={() => send({ type: "undo" })}
                          >
                            ↩ Take it back and retry
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          )}

          <div className="moves-panel">
            <div className="moves-header">
              <span>MOVE SHEET</span>
              <span>
                {!state?.result
                  ? "REVIEW AFTER GAME"
                  : analysis.status === "loading" ||
                      analysis.status === "analyzing"
                    ? `REVIEWING ${analysis.completed}/${state.history.length}`
                    : analysis.status === "complete"
                      ? "LOCAL REVIEW COMPLETE"
                      : analysis.status === "error"
                        ? "REVIEW UNAVAILABLE"
                        : `${state.history.length} PLIES`}
              </span>
            </div>
            {lastPly > 0 && (
              <div className="replay-controls" aria-label="Replay controls">
                <button
                  onClick={() => goToPly(0)}
                  disabled={viewedPly === 0}
                  aria-label="Starting position"
                >
                  |‹
                </button>
                <button
                  onClick={() => goToPly(viewedPly - 1)}
                  disabled={viewedPly === 0}
                  aria-label="Previous move"
                >
                  ‹
                </button>
                <span>
                  {viewedPly === 0
                    ? "Start"
                    : `${Math.ceil(viewedPly / 2)}${viewedPly % 2 ? ". White" : "… Black"}`}
                </span>
                <button
                  onClick={() => goToPly(viewedPly + 1)}
                  disabled={viewedPly === lastPly}
                  aria-label="Next move"
                >
                  ›
                </button>
                <button
                  onClick={() => goToPly(lastPly)}
                  disabled={viewedPly === lastPly}
                  aria-label="Latest position"
                >
                  ›|
                </button>
              </div>
            )}
            <div className="moves-table">
              {movePairs.length ? (
                movePairs.map((pair) => (
                  <div className="move-row" key={pair.number}>
                    <span>{pair.number}.</span>
                    {moveCell(pair.w)}
                    {moveCell(pair.b)}
                  </div>
                ))
              ) : (
                <div className="empty-moves">
                  <span>{PIECE_GLYPHS.p}</span>
                  <p>
                    The move sheet is empty.
                    <br />
                    White begins.
                  </p>
                </div>
              )}
            </div>
          </div>

          <section className="ai-coach" aria-labelledby="ai-coach-title">
            <div className="ai-coach-head">
              <span id="ai-coach-title">COACH MING</span>
            </div>
            {!state?.result ? (
              <p>
                Finish this game, then the coach will explain any inaccuracies,
                mistakes, misses, or blunders found by Stockfish.
              </p>
            ) : analysis.status === "loading" ||
              analysis.status === "analyzing" ||
              analysis.status === "idle" ? (
              <p>
                Stockfish is reviewing the game. Explainable moves will appear
                here when it finishes.
              </p>
            ) : analysis.status === "error" ? (
              <p>
                Stockfish could not finish the local review, so the AI coach
                does not have reliable evidence yet.
              </p>
            ) : explainableMoves.length ? (
              <>
                <p>
                  Choose one of your flagged moves to ask the AI coach exactly
                  what went wrong.
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
                Stockfish did not flag any of your moves for an AI explanation
                in this game.
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
                    {viewHistory[analysisPly - 1]?.san}
                  </strong>
                  {selectedReview.expectedPointsLoss !== null && (
                    <small>
                      {(selectedReview.expectedPointsLoss * 100).toFixed(1)}{" "}
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
                        <code>{selectedExplanation.playedLine.join(" ")}</code>
                      </div>
                    )}
                    {selectedExplanation.bestLine.length > 0 && (
                      <div className="engine-line engine-line--best">
                        <span>BETTER LINE</span>
                        <code>{selectedExplanation.bestLine.join(" ")}</code>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

          {state &&
            !state.result &&
            state.undoRequest &&
            state.undoRequest.by !== role &&
            role !== "spectator" && (
              <div className="takeback-bar" role="alert">
                <span>
                  {state.players[state.undoRequest.by] || "Your opponent"} asks
                  to take back a move
                </span>
                <div>
                  <button
                    onClick={() => send({ type: "undo_response", accept: true })}
                  >
                    Accept
                  </button>
                  <button
                    onClick={() =>
                      send({ type: "undo_response", accept: false })
                    }
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}
          {state &&
            !state.result &&
            state.drawOffer &&
            state.drawOffer.by !== role &&
            role !== "spectator" && (
              <div className="takeback-bar" role="alert">
                <span>
                  {state.players[state.drawOffer.by] || "Your opponent"} offers
                  a draw
                </span>
                <div>
                  <button
                    onClick={() => send({ type: "draw_response", accept: true })}
                  >
                    Accept
                  </button>
                  <button
                    onClick={() =>
                      send({ type: "draw_response", accept: false })
                    }
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}
          {state && (
            <div className="match-actions">
              <button onClick={() => send({ type: "reset" })}>↻ Rematch</button>
              <button
                onClick={() => send({ type: "undo" })}
                disabled={
                  role === "spectator" ||
                  Boolean(state.result) ||
                  replayPly !== null ||
                  Boolean(state.undoRequest) ||
                  state.history.length <
                    ((state.history.length % 2 === 0 ? "w" : "b") === role
                      ? 2
                      : 1)
                }
              >
                {state.undoRequest?.by === role ? "Asked…" : "↶ Undo"}
              </button>
              <button
                onClick={() => send({ type: "draw_offer" })}
                disabled={
                  role === "spectator" ||
                  Boolean(state.result) ||
                  Boolean(state.drawOffer)
                }
              >
                {state.drawOffer?.by === role ? "Offered…" : "½ Draw"}
              </button>
              <div className="resign-wrap">
                {confirmResign && !state.result && (
                  <div
                    className="resign-confirm"
                    role="alertdialog"
                    aria-label="Confirm resignation"
                  >
                    <span>Resign the game?</span>
                    <div>
                      <button onClick={() => setConfirmResign(false)}>
                        Cancel
                      </button>
                      <button
                        className="resign-confirm-yes"
                        onClick={() => {
                          send({ type: "resign" });
                          setConfirmResign(false);
                        }}
                      >
                        Resign
                      </button>
                    </div>
                  </div>
                )}
                <button
                  onClick={() => setConfirmResign((current) => !current)}
                  disabled={role === "spectator" || Boolean(state.result)}
                >
                  Resign
                </button>
              </div>
            </div>
          )}
          {state?.result && (
            <div className="seer-widget">
              <div className="seer-head">
                <span className="seer-eye">
                  <IconSeer size={16} />
                </span>
                <span>Seer Autofix</span>
                {seer.phase === "done" && seer.shortId ? (
                  <span className="seer-chip">{seer.shortId}</span>
                ) : null}
                <span className="seer-head-spacer" />
                <button
                  className="seer-icon-btn"
                  aria-label="Start a new analysis"
                  title="Start a new analysis"
                  onClick={requestSeerReview}
                  disabled={
                    seer.phase === "requesting" || seer.phase === "running"
                  }
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" />
                  </svg>
                </button>
                <button
                  className="seer-icon-btn"
                  aria-label="Expand review"
                  title="Expand review"
                  onClick={() => setSeerExpanded(true)}
                  disabled={seer.phase !== "done"}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M9.5 2h4.5v4.5M14 2 9 7M6.5 14H2V9.5M2 14l5-5" />
                  </svg>
                </button>
                <button
                  className="seer-icon-btn"
                  aria-label="Copy analysis"
                  title="Copy analysis"
                  onClick={copySeerReview}
                  disabled={seer.phase !== "done"}
                >
                  {seerCopied ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    >
                      <path d="M2.5 8.5l3.5 3.5 7-8" />
                    </svg>
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <rect x="5" y="5" width="9" height="9" rx="1.5" />
                      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
                    </svg>
                  )}
                </button>
              </div>
              <div className="seer-body">
                {seer.phase === "idle" && (
                  <>
                    <p className="seer-intro">
                      Seer can replay this game, find where it went wrong, and
                      explain the blunder — a post-mortem for your queen.
                    </p>
                    <button className="seer-cta" onClick={requestSeerReview}>
                      <IconSeer size={15} /> Start Seer Analysis
                    </button>
                  </>
                )}
                {(seer.phase === "requesting" || seer.phase === "running") && (
                  <div className="seer-loading">
                    <div className="seer-scan-row">
                      <span className="seer-eye">
                        <IconSeer size={18} animation="loading" />
                      </span>{" "}
                      {seer.phase === "running" && seer.draft
                        ? "Seer is writing the review…"
                        : "Seer is reviewing the game…"}
                    </div>
                    <div className="seer-scan-log">
                      {(seer.phase === "running" && seer.activity.length
                        ? seer.activity
                        : ["Connecting to Seer"]
                      ).map((line, index, lines) => (
                        <div
                          key={`${index}-${line}`}
                          className={
                            index === lines.length - 1
                              ? "seer-step--current"
                              : undefined
                          }
                        >
                          {line}
                        </div>
                      ))}
                    </div>
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
                  </div>
                )}
                {seer.phase === "done" && (
                  <div className="seer-preview">
                    <div className="seer-clip">
                      <div
                        className="seer-md seer-md--preview"
                        ref={seerPreviewRef}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {seer.text}
                        </ReactMarkdown>
                      </div>
                      {seerOverflows && (
                        <div className="seer-fade" aria-hidden />
                      )}
                    </div>
                    {seerOverflows && (
                      <button
                        className="seer-more"
                        onClick={() => setSeerExpanded(true)}
                      >
                        Read the full review ↗
                      </button>
                    )}
                  </div>
                )}
                {seer.phase === "error" && (
                  <p className="seer-error">
                    {seer.message}{" "}
                    <button className="seer-retry" onClick={requestSeerReview}>
                      Retry
                    </button>
                  </p>
                )}
              </div>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
        </aside>
      </section>

      {seerExpanded && seer.phase === "done" && (
        <>
          <button
            type="button"
            className="seer-drawer-scrim"
            aria-label="Close game review"
            onClick={() => setSeerExpanded(false)}
          />
          <aside
            className="seer-drawer"
            role="dialog"
            aria-label="Seer game review"
          >
            <div className="seer-head">
              <span className="seer-eye">
                <IconSeer size={16} />
              </span>
              <span>Seer Autofix</span>
              {seer.shortId ? (
                <span className="seer-chip">{seer.shortId}</span>
              ) : null}
              <span className="seer-head-spacer" />
              <button
                className="seer-icon-btn"
                aria-label="Copy analysis"
                title="Copy analysis"
                onClick={copySeerReview}
              >
                {seerCopied ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  >
                    <path d="M2.5 8.5l3.5 3.5 7-8" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <rect x="5" y="5" width="9" height="9" rx="1.5" />
                    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
                  </svg>
                )}
              </button>
              <button
                className="seer-icon-btn"
                aria-label="Minimize review"
                title="Minimize review"
                onClick={() => setSeerExpanded(false)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <path d="M2 2l12 12M14 2 2 14" />
                </svg>
              </button>
            </div>
            <div className="seer-drawer-body">
              <div className="seer-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {seer.text}
                </ReactMarkdown>
              </div>
            </div>
          </aside>
        </>
      )}

      <footer>
        <span>PAWN PATROL · EST. 2026</span>
      </footer>
    </main>
  );
}
