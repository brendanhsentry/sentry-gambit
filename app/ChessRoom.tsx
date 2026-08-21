"use client";

import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
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
  playCastle,
  playCheck,
  playGameEnd,
  playMove,
  setSoundsMuted,
  soundsMuted,
} from "./board-sounds";
import { PIECE_GLYPHS } from "./chess-pieces";
import { startGameReplay, stopGameReplay } from "./sentry-replay";
import {
  botMove,
  engineBestMove,
  gradeLabel,
  useMoveAnalysis,
  type MoveGrade,
  type ReviewMove,
} from "./move-analysis";
import { isOpeningPosition, openingName } from "./opening-book.mjs";
import { BOTS, type BotKey } from "./bots";
import { authToken, useAuth } from "./auth";
import { TopBar } from "./TopBar";
import { GameSummary } from "./games/GameSummary";
import { moveCountLabel } from "./games/game-replay";

// The captured trays reuse chessground's <piece> element and its piece SVGs.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      piece: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

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
  rematchRequest?: { by: Color } | null;
  liveGrades?: boolean;
  liveGradesRequest?: { by: Color } | null;
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
  kind: "mistake" | "praise" | "opening" | "note";
  grade: MoveGrade | null;
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

function playMoveSound(san: string) {
  if (san.startsWith("O-O")) playCastle();
  else if (san.includes("+") || san.includes("#")) playCheck();
  else if (san.includes("x")) playCapture();
  else playMove();
}

function moveSoundKey(move: Pick<ReviewMove, "from" | "to" | "promotion">) {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
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

function useClock(clock: ClockState | null, color: Color, onFlag: () => void) {
  const [now, setNow] = useState(() => Date.now());
  const flagged = useRef(false);

  useEffect(() => {
    flagged.current = false;
  }, [clock?.running, clock?.since, color]);

  useEffect(() => {
    if (!clock || clock.running !== color) return;
    const activeClock = clock;
    const id = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (!flagged.current && projectedTime(activeClock, color, next) <= 0) {
        flagged.current = true;
        onFlag();
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [clock, color, onFlag]);

  return now;
}

function ClockDisplay({
  clock,
  color,
  initialTime,
  active,
  onFlag,
}: {
  clock: ClockState | null;
  color: Color;
  initialTime: number;
  active: boolean;
  onFlag: () => void;
}) {
  const now = useClock(clock, color, onFlag);
  const time = clock ? projectedTime(clock, color, now) : initialTime;

  return (
    <div
      className={`clock ${active ? "clock--active" : ""}`}
      aria-label={`${color === "w" ? "White" : "Black"} clock`}
    >
      {formatClock(time)}
    </div>
  );
}

function PlayerCard({
  name,
  color,
  clock,
  initialTime,
  active,
  bottom,
  captured,
  advantage,
  onFlag,
}: {
  name: string | null;
  color: Color;
  clock: ClockState | null;
  initialTime: number;
  active: boolean;
  bottom?: boolean;
  captured?: PieceSymbol[];
  advantage?: number;
  onFlag: () => void;
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
          className="captured-tray cg-wrap"
          aria-label={`Pieces captured by ${color === "w" ? "white" : "black"}`}
        >
          {captured.map((type, index) => (
            <piece
              key={`${type}${index}`}
              className={`${PIECE_NAMES[type]} ${color === "w" ? "black" : "white"}`}
            />
          ))}
          {(advantage ?? 0) > 0 && (
            <small className="captured-lead">+{advantage}</small>
          )}
        </div>
      )}
      <ClockDisplay
        clock={clock}
        color={color}
        initialTime={initialTime}
        active={active}
        onFlag={onFlag}
      />
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
  const [lobbyTab, setLobbyTab] = useState<"friend" | "patrol">("friend");
  const [room, setRoom] = useState("");
  const [role, setRole] = useState<Role>("spectator");
  const coachHistoryLengthRef = useRef(0);
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
  const explanationRequestsRef = useRef(new Set<number>());
  const latestStateRef = useRef<GameState | null>(null);
  const auth = useAuth();
  const { user } = auth;
  const [coachEnabled, setCoachEnabled] = useState(true);
  const [coachFeed, setCoachFeed] = useState<CoachItem[]>([]);
  const [hint, setHint] = useState<CoachHint | null>(null);
  const coachSeenRef = useRef(new Set<string>());
  const coachBaselineRef = useRef<{ gameId: string; ply: number } | null>(null);
  const coachIdRef = useRef(1);
  const openingRef = useRef<{
    gameId: string;
    name: string | null;
    done: boolean;
  } | null>(null);
  const suggestionRef = useRef<{ fen: string; san: string } | null>(null);
  const [miniSeerOpen, setMiniSeerOpen] = useState(false);
  const brandClicksRef = useRef({ count: 0, last: 0 });

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

  const flagClock = useCallback(() => send({ type: "flag" }), [send]);

  useEffect(() => {
    latestStateRef.current = state;
  }, [state]);

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
    const plyCount = state.history.length;
    if (plyCount < coachHistoryLengthRef.current) {
      setCoachFeed((feed) => feed.filter((item) => item.ply <= plyCount));
      for (const key of [...coachSeenRef.current]) {
        if (Number(key.split(":")[1]) > plyCount) coachSeenRef.current.delete(key);
      }
      coachBaselineRef.current.ply = Math.min(coachBaselineRef.current.ply, plyCount);
    }
    coachHistoryLengthRef.current = plyCount;
    const baseline = coachBaselineRef.current.ply;
    const pushNote = (
      ply: number,
      san: string,
      text: string,
      grade: MoveGrade | null = null,
    ) => {
      const item: CoachItem = {
        id: coachIdRef.current++,
        ply,
        kind: "note",
        grade,
        san,
        bestSan: null,
        text,
        motif: null,
        thinking: false,
      };
      setCoachFeed([item]);
    };
    analysis.moves.forEach((reviewed, index) => {
      const ply = index + 1;
      const move = state.history[index];
      if (!reviewed || !move || ply <= baseline) return;
      const seenKey = `${state.gameId}:${ply}:${move.san}`;
      if (coachSeenRef.current.has(seenKey)) return;
      if (move.color !== role) {
        coachSeenRef.current.add(seenKey);
        return;
      }
      const isAlert = COACH_ALERT_GRADES.has(reviewed.grade);
      if (!isAlert && !COACH_PRAISE_GRADES.has(reviewed.grade)) {
        coachSeenRef.current.add(seenKey);
        pushNote(ply, move.san, "", reviewed.grade);
        return;
      }
      coachSeenRef.current.add(seenKey);
      // Never grade the coach's own suggestion against the player.
      const suggested = suggestionRef.current;
      if (
        suggested &&
        reviewed.evidence?.fenBefore === suggested.fen &&
        move.san === suggested.san
      )
        return;
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
      setCoachFeed([item]);
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

  // Name the opening as it develops, then note the move the game left book.
  useEffect(() => {
    if (!state?.coach || !state.bot || role === "spectator" || state.result) return;
    if (openingRef.current?.gameId !== state.gameId)
      openingRef.current = { gameId: state.gameId, name: null, done: false };
    const tracker = openingRef.current;
    if (tracker.done || !state.history.length) return;
    const replay = new Chess();
    let name: string | null = null;
    let leftBookPly: number | null = null;
    for (const [index, move] of state.history.entries()) {
      try {
        replay.move({ from: move.from, to: move.to, promotion: move.promotion });
      } catch {
        return;
      }
      if (!isOpeningPosition(replay.fen())) {
        leftBookPly = index + 1;
        break;
      }
      name = openingName(replay.fen()) ?? name;
    }
    tracker.done = leftBookPly !== null;
    if (name === tracker.name && !tracker.done) return;
    tracker.name = name;
    const san = name ?? "Opening";
    const text =
      leftBookPly === null
        ? "Book so far."
        : `Out of book on move ${Math.ceil(leftBookPly / 2)}.`;
    const item: CoachItem = {
      id: coachIdRef.current++,
      ply: state.history.length,
      kind: "opening",
      grade: null,
      san,
      bestSan: null,
      text,
      motif: null,
      thinking: false,
    };
    setCoachFeed([item]);
  }, [state, role]);

  async function requestHint(tier: "maia" | "best") {
    const started = latestStateRef.current;
    if (!started || started.result) return;
    const fen = started.fen;
    setHint({ phase: "loading", tier });
    try {
      let uci: string;
      if (tier === "best" || !started.bot) {
        uci = (await engineBestMove(fen)).move;
      } else {
        uci = (await botMove(fen, started.bot.elo)).move;
      }
      const san = sanFromUci(fen, uci);
      if (!san || latestStateRef.current?.fen !== fen) {
        setHint(null);
        return;
      }
      suggestionRef.current = { fen, san };
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

  function startBotGame(bot: BotKey) {
    const nextRoom = makeRoomCode();
    setRoomInput(nextRoom);
    connect(nextRoom, name, bot, timeControl * 60_000, coachEnabled);
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
  const localMoveSoundRef = useRef<{
    gameId: string;
    ply: number;
    key: string;
  } | null>(null);
  const boardKey = currentGameId ?? "";

  useEffect(() => {
    const prev = prevBoardRef.current;
    prevBoardRef.current = { key: boardKey, ply: viewedPly, fen: viewFen };
    if (!prev || prev.key !== boardKey || prev.fen === viewFen) return;
    const forward = viewedPly - prev.ply === 1;
    if (!forward && prev.ply - viewedPly !== 1) return;
    const move = viewHistory[(forward ? viewedPly : prev.ply) - 1];
    if (!move) return;
    const localMove = localMoveSoundRef.current;
    if (
      forward &&
      localMove?.gameId === boardKey &&
      localMove.ply === viewedPly &&
      localMove.key === moveSoundKey(move)
    ) {
      localMoveSoundRef.current = null;
      return;
    }
    playMoveSound(move.san);
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
    const token = authToken();
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(cleanRoom)}&name=${encodeURIComponent(cleanName)}&playerKey=${encodeURIComponent(playerKey)}${token ? `&token=${encodeURIComponent(token)}` : ""}${bot ? `&bot=${bot}` : ""}${initialTimeMs ? `&time=${initialTimeMs}` : ""}${bot && coach ? "&coach=1" : ""}`,
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
        if (message.role !== "spectator") {
          try {
            window.localStorage.setItem(`pawn-patrol-seat:${cleanRoom}`, cleanName);
          } catch {
            // Storage can be unavailable; rejoin memory is best-effort.
          }
        }
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
      // A player who already had a seat here goes straight back to the board.
      const seatedAs = cleaned
        ? window.localStorage.getItem(`pawn-patrol-seat:${cleaned}`)
        : null;
      if (seatedAs !== null) {
        setName(seatedAs);
        connect(cleaned, seatedAs);
      }
    }
    return () => socketRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const matchUnderway = Boolean(
    state && !state.result && state.players.w && state.players.b,
  );
  const inLobby = connection === "idle";
  const canControlBoard =
    replayPly === null &&
    !!state &&
    !state.result &&
    role !== "spectator";
  const canInteract = canControlBoard && chess.turn() === role;
  const coachActive = Boolean(
    state?.coach && state.bot && !state.result && role !== "spectator",
  );

  // Easter egg: mashing the logo mid-PvP-game summons a mini seer with hints.
  const pvpLive = Boolean(
    state && !state.bot && !state.result && role !== "spectator",
  );
  function handleBrandClick(event: React.MouseEvent) {
    if (!pvpLive) return;
    event.preventDefault();
    const clicks = brandClicksRef.current;
    const now = Date.now();
    clicks.count = now - clicks.last < 1200 ? clicks.count + 1 : 1;
    clicks.last = now;
    if (clicks.count >= 5) {
      clicks.count = 0;
      setMiniSeerOpen(true);
    }
  }

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
    return submitMove(options[0]);
  }

  function submitMove(move: ReviewMove) {
    localMoveSoundRef.current = {
      gameId: boardKey,
      ply: viewedPly + 1,
      key: moveSoundKey(move),
    };
    if (
      !send({
        type: "move",
        from: move.from,
        to: move.to,
        ...(move.promotion ? { promotion: move.promotion } : {}),
      })
    ) {
      localMoveSoundRef.current = null;
      return false;
    }
    playMoveSound(move.san);
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
  const showGrades = Boolean(state?.result || state?.liveGrades);
  const gradeVisible = (index: number) =>
    showGrades &&
    (Boolean(state?.result) ||
      !state?.bot ||
      (index % 2 === 0 ? "w" : "b") === role);
  const selectedReview =
    analysisPly && gradeVisible(analysisPly - 1)
      ? analysis.moves[analysisPly - 1]
      : null;
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
    const reviewed = gradeVisible(move.index) ? analysis.moves[move.index] : null;
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
      <TopBar
        auth={auth}
        action={
          room || invitedRoom ? (
            <button
              className="topbar-cta"
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
          ) : null
        }
        onBrandClick={handleBrandClick}
      />

      {miniSeerOpen && pvpLive && (
        <aside className="mini-seer" role="dialog" aria-label="Mini seer">
          <div className="mini-seer-head">
            <span className="seer-eye">
              <IconSeer size={14} />
            </span>
            <span className="mini-seer-title">MINI SEER</span>
            <button
              className="mini-seer-close"
              onClick={() => setMiniSeerOpen(false)}
              aria-label="Dismiss the mini seer"
            >
              ×
            </button>
          </div>
          <button
            className="mini-seer-cta"
            onClick={() => void requestHint("best")}
            disabled={!canInteract || hint?.phase === "loading"}
            title={canInteract ? undefined : "Hints are available on your turn"}
          >
            {hint?.phase === "loading" ? "Peering…" : "◈ Hint"}
          </button>
          {hintVisible && hint.phase === "shown" && (
            <div className="mini-seer-hint">
              <strong>{hint.san}</strong>
            </div>
          )}
        </aside>
      )}

      <section className={`game-layout ${inLobby ? "game-layout--lobby" : ""}`}>
        <div className="board-column">
          {!inLobby && (
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
          )}

          {!inLobby && (
            <PlayerCard
              name={displayedPlayers[topColor]}
              color={topColor}
              clock={state?.clock ?? null}
              initialTime={idleTime}
              active={state?.clock.running === topColor && !state.result}
              captured={captured[bottomColor]}
              advantage={topColor === "w" ? materialLead : -materialLead}
              onFlag={flagClock}
            />
          )}

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
              layoutKey={inLobby ? "lobby" : "table"}
              ariaLabel={`Chess board, ${orientation === "w" ? "white" : "black"} orientation`}
            />

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
                          disabled={Boolean(state.rematchRequest)}
                        >
                          {state.rematchRequest?.by === role
                            ? "Rematch asked…"
                            : "↻ Rematch"}
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
                      onClick={() => {
                        const move = chess
                          .moves({ square: promotion.from, verbose: true })
                          .find(
                            (candidate) =>
                              candidate.to === promotion.to &&
                              candidate.promotion === piece,
                          );
                        if (move) submitMove(move);
                      }}
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

          {!inLobby && (
            <PlayerCard
              name={displayedPlayers[bottomColor]}
              color={bottomColor}
              clock={state?.clock ?? null}
              initialTime={idleTime}
              active={state?.clock.running === bottomColor && !state.result}
              bottom
              captured={captured[topColor]}
              advantage={bottomColor === "w" ? materialLead : -materialLead}
              onFlag={flagClock}
            />
          )}
        </div>

        {inLobby && (
          <aside className="lobby-card">
            {invitedRoom ? (
              <>
                <span className="lobby-kicker">YOU&apos;RE INVITED</span>
                <h1>Take your seat</h1>
                <p>
                  You&apos;ve been invited to table {invitedRoom}. Enter a
                  name and join the game.
                </p>
                {user ? (
                  <p className="lobby-signed-in">
                    <span>PLAYING AS</span>
                    <strong>{user.username}</strong>
                    <span>·</span>
                    <span className="lobby-rating">RATING {user.rating}</span>
                  </p>
                ) : (
                  <label>
                    <span>Your name</span>
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. Magnus"
                      maxLength={24}
                    />
                  </label>
                )}
                <button
                  className="primary-button"
                  onClick={() => connect(invitedRoom, name)}
                >
                  Join table {invitedRoom} <span>→</span>
                </button>
              </>
            ) : (
              <>
                <h1>New table</h1>
                {user ? (
                  <p className="lobby-signed-in">
                    <span>PLAYING AS</span>
                    <strong>{user.username}</strong>
                    <span>·</span>
                    <span className="lobby-rating">RATING {user.rating}</span>
                  </p>
                ) : (
                  <label>
                    <span>Your name</span>
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. Magnus"
                      maxLength={24}
                    />
                  </label>
                )}
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
                <div className="lobby-tabs" role="tablist">
                  <button
                    role="tab"
                    aria-selected={lobbyTab === "friend"}
                    className={lobbyTab === "friend" ? "selected" : ""}
                    onClick={() => setLobbyTab("friend")}
                  >
                    Play a friend
                  </button>
                  <button
                    role="tab"
                    aria-selected={lobbyTab === "patrol"}
                    className={lobbyTab === "patrol" ? "selected" : ""}
                    onClick={() => setLobbyTab("patrol")}
                  >
                    bot
                  </button>
                </div>
                {lobbyTab === "friend" ? (
                <>
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
                </>
                ) : (
                <div className="bot-row">
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
                      <strong>Coach watches your game</strong>
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
                        onClick={() => startBotGame(key)}
                      >
                        <strong>{BOTS[key].name}</strong>
                        <small>ELO {BOTS[key].elo}</small>
                      </button>
                    ))}
                  </div>
                </div>
                )}
              </>
            )}
          </aside>
        )}

        {!inLobby && (
        <aside
          className={`match-panel ${matchUnderway ? "match-panel--live" : ""}`}
        >
          {!matchUnderway && (
            <div className="match-heading">
              <span className="panel-kicker">MATCH ROOM</span>
              <h2>
                {replayPly !== null
                  ? `Position ${viewedPly} of ${lastPly}`
                  : state
                    ? state.result
                      ? relativeStatus(state, role)
                      : "Waiting for opponent"
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
          )}

          {state?.result && (
            <GameSummary
              history={state.history}
              moves={analysis.moves}
              players={state.players}
              complete={analysis.status === "complete"}
            />
          )}

          {!matchUnderway && room && (
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
          )}

          {coachActive && state && (
            <section className="live-coach" aria-label="Live coaching">
              <div className="live-coach-head">
                <span className="live-coach-dot" aria-hidden />
                <span className="live-coach-title">COACH · LIVE</span>
                <button
                  className="live-coach-off"
                  onClick={() => send({ type: "coach", enabled: false })}
                  title="Turn off the coach"
                >
                  OFF
                </button>
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
              {coachFeed.length > 0 && (
                <div className="live-coach-feed">
                  {coachFeed.map((item) => (
                    <div
                      key={item.id}
                      className={`coach-bubble coach-bubble--${item.kind}`}
                    >
                      <div className="coach-bubble-top">
                        <strong>
                          {item.kind === "opening"
                            ? item.san
                            : `${Math.floor((item.ply - 1) / 2) + 1}${
                                (item.ply - 1) % 2 ? "…" : "."
                              } ${item.san}`}
                        </strong>
                        {item.grade && (
                          <span className={`move-grade move-grade--${item.grade}`}>
                            {gradeLabel(item.grade)}
                          </span>
                        )}
                        {item.motif && (
                          <span className="coach-motif">
                            {item.motif.replace(/_/g, " ")}
                          </span>
                        )}
                      </div>
                      {(item.text || item.thinking) && (
                        <p className={item.thinking ? "coach-thinking" : ""}>
                          {item.text}
                          {item.thinking && " Let me take a closer look…"}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {state?.bot &&
            !state.coach &&
            !state.result &&
            role !== "spectator" && (
              <button
                className="live-coach-restore"
                onClick={() => send({ type: "coach", enabled: true })}
              >
                ◈ Turn on coach
              </button>
            )}

          {state && (matchUnderway || state.result) && (
          <div className="moves-panel">
            <div className="moves-header">
              <span>MOVE SHEET</span>
              <span>
                {!showGrades
                  ? moveCountLabel(state.history.length).toUpperCase()
                  : analysis.status === "loading" || analysis.status === "analyzing"
                  ? `GRADING ${analysis.completed}/${state.history.length}`
                  : analysis.status === "complete"
                    ? "GRADED"
                    : analysis.status === "error"
                      ? "GRADES UNAVAILABLE"
                      : moveCountLabel(state.history.length).toUpperCase()}
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
          )}

          {state?.result && (
          <section className="ai-coach" aria-labelledby="ai-coach-title">
            <div className="ai-coach-head">
              <span id="ai-coach-title">COACH</span>
            </div>
            {analysis.status === "loading" ||
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
          )}

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
            state.rematchRequest &&
            state.rematchRequest.by !== role &&
            role !== "spectator" && (
              <div className="takeback-bar" role="alert">
                <span>
                  {state.players[state.rematchRequest.by] || "Your opponent"}{" "}
                  wants a rematch (colors swap)
                </span>
                <div>
                  <button
                    onClick={() =>
                      send({ type: "rematch_response", accept: true })
                    }
                  >
                    Accept
                  </button>
                  <button
                    onClick={() =>
                      send({ type: "rematch_response", accept: false })
                    }
                  >
                    Decline
                  </button>
                </div>
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
          {state &&
            !state.result &&
            state.liveGradesRequest &&
            state.liveGradesRequest.by !== role &&
            role !== "spectator" && (
              <div className="takeback-bar" role="alert">
                <span>
                  {state.players[state.liveGradesRequest.by] || "Your opponent"}{" "}
                  asks to {state.liveGrades ? "hide" : "show"} move grades
                  during the game
                </span>
                <div>
                  <button
                    onClick={() =>
                      send({ type: "live_grades_response", accept: true })
                    }
                  >
                    Accept
                  </button>
                  <button
                    onClick={() =>
                      send({ type: "live_grades_response", accept: false })
                    }
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}
          {state && (matchUnderway || state.result) && (
            <div className="match-actions">
              <button
                onClick={() => send({ type: "reset" })}
                disabled={
                  role === "spectator" ||
                  !state.result ||
                  Boolean(state.rematchRequest)
                }
              >
                {state.rematchRequest?.by === role ? "Asked…" : "↻ Rematch"}
              </button>
              {!state.result && (
              <>
              <button
                className={state.liveGrades ? "is-on" : undefined}
                aria-pressed={Boolean(state.liveGrades)}
                onClick={() => send({ type: "live_grades_request" })}
                disabled={
                  role === "spectator" ||
                  Boolean(state.result) ||
                  Boolean(state.liveGradesRequest)
                }
              >
                {state.liveGradesRequest?.by === role
                  ? "Asked…"
                  : "Grades"}
              </button>
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
              </>
              )}
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
        )}
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
