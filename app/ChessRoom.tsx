"use client";

import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import Image from "next/image";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import { gradeLabel, useMoveAnalysis, type ReviewMove } from "./move-analysis";
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
  clock: ClockState;
  bot: { key: BotKey; name: string; elo: number; color: Color } | null;
};

type PastGameSummary = {
  id: string;
  room: string;
  players: { w: string | null; b: string | null };
  result: string;
  finishedAt: number;
  finalFen: string;
  clock: { w: number; b: number };
  plyCount: number;
};

type PastGame = PastGameSummary & { history: ReviewMove[] };

type BoardGhost = {
  from: Square;
  to: Square;
  glyph: string;
  color: Color;
  fade?: boolean;
};

type BoardAnim = { id: number; ghosts: BoardGhost[]; hide: Set<Square> };

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

// Shown one at a time while a real Seer review runs (they take minutes).
const SEER_QUOTES = [
  "Reading the game event…",
  "Replaying the moves…",
  "Locating the eval swings…",
  "Interviewing the knight who saw everything…",
  "Checking if the queen was en prise… she was.",
  "Blaming time pressure…",
  "Consulting opening theory (1. e4 is still fine)…",
  "Measuring centipawn loss with a tiny ruler…",
  "Asking Stockfish to be gentle…",
  "Cross-referencing every game Magnus ever played…",
  "Looking for the brilliant move you missed… still looking…",
  "Filing a bug report against your bishop…",
  "Rewinding to the last moment things were fine…",
  "Counting the pawns twice, just to be sure…",
  "The rook says it was 'just following orders'…",
  "Detecting hope chess…",
  "Grepping the middlegame for blunders…",
  "Escalating to the back rank…",
  "Reviewing your king's safety posture…",
  "Running the resignation post-mortem…",
  "Comparing you to a 3500-rated engine (be brave)…",
  "Deciding if that sacrifice was sound or just vibes…",
  "Tracing the eval bar's cliff dive…",
  "Assigning blame to individual pieces…",
  "Reconstructing the crime scene on f7…",
  "Polling the spectators — they saw it too…",
  "Verifying the touch-move rule was honored…",
  "Estimating how long that knight was hanging…",
  "Applying the 'everyone blunders' consolation protocol…",
  "Almost done… in engine time, which is different…",
];

const START_FEN = new Chess().fen();
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const EXPLAINABLE_GRADES = new Set([
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
]);
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
}: {
  name: string | null;
  color: Color;
  time: number;
  active: boolean;
  bottom?: boolean;
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
  const [room, setRoom] = useState("");
  const [role, setRole] = useState<Role>("spectator");
  const [connection, setConnection] = useState<
    "idle" | "connecting" | "online" | "offline"
  >("idle");
  const [state, setState] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{
    from: Square;
    to: Square;
    color: Color;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [pastGames, setPastGames] = useState<PastGameSummary[]>([]);
  const [pastGamesLoading, setPastGamesLoading] = useState(true);
  const [pastGame, setPastGame] = useState<PastGame | null>(null);
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

  const send = useCallback((payload: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const loadPastGames = useCallback(async () => {
    setPastGamesLoading(true);
    try {
      const key = browserPlayerKey();
      const response = await fetch(
        `/api/games?limit=12&playerKey=${encodeURIComponent(key)}`,
      );
      if (!response.ok) throw new Error("Game archive unavailable");
      const data = (await response.json()) as { games: PastGameSummary[] };
      setPastGames(data.games);
    } catch {
      setPastGames([]);
    } finally {
      setPastGamesLoading(false);
    }
  }, []);

  const openPastGame = useCallback(async (gameId: string) => {
    try {
      const key = browserPlayerKey();
      const response = await fetch(
        `/api/games/${encodeURIComponent(gameId)}?playerKey=${encodeURIComponent(key)}`,
      );
      if (!response.ok) throw new Error("Game not found");
      const game = (await response.json()) as PastGame;
      setPastGame(game);
      setReplayPly(game.history.length);
      setSelected(null);
      setPromotion(null);
    } catch {
      setNotice("That saved game could not be opened.");
    }
  }, []);

  useEffect(() => {
    // Fetching the browser-owned archive is a mount-time synchronization.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPastGames();
  }, [loadPastGames]);

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

  useEffect(() => {
    // A result changes the server-side archive, so refresh its local snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state?.result) void loadPastGames();
  }, [state?.result, loadPastGames]);

  type SeerReview =
    | { phase: "idle" }
    | { phase: "requesting" }
    | { phase: "running"; issueId: string; shortId: string }
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

  // Rolling ticker of quips while a review runs: a shuffled deck cycles so
  // nothing repeats until the whole pool has been shown.
  const [seerTicker, setSeerTicker] = useState<{ id: number; text: string }[]>(
    [],
  );
  useEffect(() => {
    if (seer.phase !== "requesting" && seer.phase !== "running") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSeerTicker([]);
      return;
    }
    const deck = [...SEER_QUOTES];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    let count = 0;
    const push = () => {
      const entry = { id: count, text: deck[count % deck.length] };
      count += 1;
      setSeerTicker((prev) => [...prev, entry].slice(-4));
    };
    push();
    const interval = window.setInterval(push, 4000);
    return () => window.clearInterval(interval);
  }, [seer.phase]);

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
        }
      } catch {
        // Keep polling.
      }
    }, 10000);
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
    if (new Chess(state.fen).turn() !== bot.color) return;
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

  async function startBotGame(bot: BotKey) {
    setPendingBot(bot);
    try {
      await loadMaia();
      const nextRoom = makeRoomCode();
      setRoomInput(nextRoom);
      connect(nextRoom, name, bot);
    } catch {
      setNotice("The bot engine could not be loaded. Try again.");
    } finally {
      setPendingBot(null);
    }
  }

  const viewHistory = useMemo(
    () => pastGame?.history ?? state?.history ?? [],
    [pastGame?.history, state?.history],
  );

  async function requestMoveExplanation(index: number) {
    const ply = index + 1;
    setAnalysisPly(ply);
    goToPly(ply);

    const reviewed = analysis.moves[index];
    if (
      pastGame ||
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
    if (viewedPly === lastPly)
      return pastGame?.finalFen ?? state?.fen ?? START_FEN;
    const position = new Chess();
    for (const move of viewHistory.slice(0, viewedPly)) {
      position.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion ?? "q",
      });
    }
    return position.fen();
  }, [lastPly, pastGame?.finalFen, state?.fen, viewHistory, viewedPly]);

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

  const [anim, setAnim] = useState<BoardAnim | null>(null);
  const [drag, setDrag] = useState<{
    from: Square;
    glyph: string;
    color: Color;
  } | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dragElRef = useRef<HTMLSpanElement | null>(null);
  const animIdRef = useRef(0);
  const prevBoardRef = useRef<{ key: string; ply: number; fen: string } | null>(
    null,
  );
  const boardKey = pastGame?.id ?? currentGameId ?? "";

  // Slide pieces between squares whenever the position advances by one ply.
  useLayoutEffect(() => {
    const prev = prevBoardRef.current;
    prevBoardRef.current = { key: boardKey, ply: viewedPly, fen: viewFen };
    if (!prev || prev.key !== boardKey || prev.fen === viewFen) return;
    const forward = viewedPly - prev.ply === 1;
    if (!forward && prev.ply - viewedPly !== 1) {
      setAnim(null);
      return;
    }
    const move = viewHistory[(forward ? viewedPly : prev.ply) - 1];
    if (!move) return;
    const prevChess = new Chess(prev.fen);
    const from = forward ? move.from : move.to;
    const to = forward ? move.to : move.from;
    const mover = prevChess.get(from);
    if (!mover) return;
    const ghosts: BoardGhost[] = [];
    const hide = new Set<Square>([to]);
    if (forward) {
      const capturedAt = prevChess.get(move.to)
        ? move.to
        : move.san.includes("x")
          ? (`${move.to[0]}${move.from[1]}` as Square)
          : null;
      const victim = capturedAt ? prevChess.get(capturedAt) : null;
      if (victim && victim.color !== move.color)
        ghosts.push({
          from: capturedAt!,
          to: capturedAt!,
          glyph: PIECE_GLYPHS[victim.type],
          color: victim.color,
          fade: true,
        });
    }
    ghosts.push({ from, to, glyph: PIECE_GLYPHS[mover.type], color: mover.color });
    if (move.san.startsWith("O-O")) {
      const rank = move.color === "w" ? "1" : "8";
      const queenside = move.san.startsWith("O-O-O");
      const rookHome = `${queenside ? "a" : "h"}${rank}` as Square;
      const rookCastled = `${queenside ? "d" : "f"}${rank}` as Square;
      const rookFrom = forward ? rookHome : rookCastled;
      const rookTo = forward ? rookCastled : rookHome;
      ghosts.push({
        from: rookFrom,
        to: rookTo,
        glyph: PIECE_GLYPHS.r,
        color: move.color,
      });
      hide.add(rookTo);
    }
    animIdRef.current += 1;
    setAnim({ id: animIdRef.current, ghosts, hide });
    if (forward && ghosts.some((ghost) => ghost.fade)) playCapture();
    else playMove();
    if (forward && move.san.includes("+")) playCheck();
    const timer = window.setTimeout(() => setAnim(null), 180);
    return () => window.clearTimeout(timer);
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

  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(
      chess.moves({ square: selected, verbose: true }).map((move) => move.to),
    );
  }, [chess, selected]);

  const connect = useCallback((nextRoom: string, nextName: string, bot?: BotKey) => {
    const cleanRoom = nextRoom
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    const cleanName = nextName.trim().slice(0, 24) || "Guest player";
    if (!cleanRoom) return;

    socketRef.current?.close();
    setPastGame(null);
    setReplayPly(null);
    setConnection("connecting");
    setRoom(cleanRoom);
    setNotice("");
    setSelected(null);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const playerKey = browserPlayerKey();
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(cleanRoom)}&name=${encodeURIComponent(cleanName)}&playerKey=${encodeURIComponent(playerKey)}${bot ? `&bot=${bot}` : ""}`,
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
        setSelected(null);
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
  useEffect(() => {
    if (connection !== "offline" || !room) return;
    const id = window.setTimeout(() => connect(room, name, currentBotKey), 1600);
    return () => window.clearTimeout(id);
  }, [connection, room, name, currentBotKey, connect]);

  const orientation: Color = pastGame ? "w" : role === "b" ? "b" : "w";
  const ranks =
    orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = orientation === "w" ? [...FILES] : [...FILES].reverse();
  const lastMove = viewHistory[viewedPly - 1];
  const topColor: Color = orientation === "w" ? "b" : "w";
  const bottomColor: Color = orientation;
  const displayedPlayers = pastGame?.players ??
    state?.players ?? { w: null, b: null };
  const topTime = pastGame
    ? pastGame.clock[topColor]
    : state
      ? projectedTime(state.clock, topColor, now)
      : 600_000;
  const bottomTime = pastGame
    ? pastGame.clock[bottomColor]
    : state
      ? projectedTime(state.clock, bottomColor, now)
      : 600_000;

  const canInteract =
    !pastGame &&
    replayPly === null &&
    !!state &&
    !state.result &&
    role !== "spectator" &&
    chess.turn() === role;

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

  function handleSquare(square: Square) {
    if (!canInteract) return;
    const piece = chess.get(square);
    if (!selected || piece?.color === role) {
      if (piece?.color === role) setSelected(square);
      return;
    }
    if (!tryMove(selected, square)) setSelected(null);
  }

  function handlePointerDown(event: ReactPointerEvent, square: Square) {
    if (!canInteract || event.button !== 0) return;
    const piece = chess.get(square);
    if (piece?.color !== role) return;
    const board = boardRef.current;
    if (!board) return;
    event.preventDefault();
    setSelected(square);
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    const place = (ev: PointerEvent) => {
      const rect = board.getBoundingClientRect();
      const x = ev.clientX - rect.left - board.clientLeft;
      const y = ev.clientY - rect.top - board.clientTop;
      const el = dragElRef.current;
      if (el) {
        const half = board.clientWidth / 16;
        el.style.transform = `translate(${x - half}px, ${y - half}px)`;
        el.style.visibility = "visible";
      }
      return { x, y };
    };
    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        started = true;
        setDrag({
          from: square,
          glyph: PIECE_GLYPHS[piece.type],
          color: piece.color,
        });
      }
      place(ev);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", finish);
      setDrag(null);
    };
    const onUp = (ev: PointerEvent) => {
      const wasStarted = started;
      const { x, y } = place(ev);
      finish();
      if (!wasStarted) return;
      const size = board.clientWidth / 8;
      const fx = Math.floor(x / size);
      const fy = Math.floor(y / size);
      if (fx < 0 || fx > 7 || fy < 0 || fy > 7) return;
      const file = FILES[orientation === "w" ? fx : 7 - fx];
      const rank = orientation === "w" ? 8 - fy : fy + 1;
      const target = `${file}${rank}` as Square;
      if (target !== square) tryMove(square, target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", finish);
  }

  function goToPly(ply: number) {
    const next = Math.max(0, Math.min(lastPly, ply));
    setReplayPly(!pastGame && next === lastPly ? null : next);
    setSelected(null);
    setPromotion(null);
  }

  function startTable() {
    const nextRoom = makeRoomCode();
    setRoomInput(nextRoom);
    connect(nextRoom, name);
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
    const reviewed =
      !pastGame && state?.result ? analysis.moves[move.index] : null;
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
        <div className="topbar-note">
          <span className="live-dot" /> LIVE TABLES · RAPID 10
        </div>
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
              setPastGame(null);
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
            <span>
              {pastGame
                ? `SAVED GAME · ${pastGame.room}`
                : room
                  ? `PRIVATE TABLE · ${room}`
                  : "PRIVATE TABLE"}
            </span>
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
                {pastGame
                  ? "REPLAY"
                  : connection === "online"
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
            active={
              !pastGame && state?.clock.running === topColor && !state.result
            }
          />

          <div className="board-wrap">
            <div
              ref={boardRef}
              className={`chessboard ${drag ? "chessboard--dragging" : ""}`}
              role="grid"
              aria-label={`Chess board, ${orientation === "w" ? "white" : "black"} orientation`}
            >
              {ranks.flatMap((rank, rankIndex) =>
                files.map((file, fileIndex) => {
                  const square = `${file}${rank}` as Square;
                  const piece = chess.get(square);
                  const dark = (rank + FILES.indexOf(file)) % 2 === 1;
                  const isSelected = selected === square;
                  const isTarget = legalTargets.has(square);
                  const wasMoved =
                    lastMove?.from === square || lastMove?.to === square;
                  const isCheckedKing =
                    piece?.type === "k" &&
                    piece.color === chess.turn() &&
                    chess.isCheck();
                  const grabbable = canInteract && piece?.color === role;
                  return (
                    <button
                      key={square}
                      className={`square ${dark ? "square--dark" : "square--light"} ${isSelected ? "is-selected" : ""} ${wasMoved ? "was-moved" : ""} ${isCheckedKing ? "is-check" : ""} ${grabbable ? "square--grabbable" : ""}`}
                      onClick={() => handleSquare(square)}
                      onPointerDown={(event) => handlePointerDown(event, square)}
                      role="gridcell"
                      aria-label={`${square}${piece ? `, ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ""}`}
                    >
                      {fileIndex === 0 && (
                        <span className="rank-label">{rank}</span>
                      )}
                      {rankIndex === 7 && (
                        <span className="file-label">{file}</span>
                      )}
                      {piece && (
                        <span
                          className={`piece piece--${piece.color}`}
                          style={
                            anim?.hide.has(square) || drag?.from === square
                              ? { visibility: "hidden" }
                              : undefined
                          }
                        >
                          {PIECE_GLYPHS[piece.type]}
                        </span>
                      )}
                      {isTarget && (
                        <span className={piece ? "capture-ring" : "move-dot"} />
                      )}
                    </button>
                  );
                }),
              )}
              {anim && (
                <div className="board-anim-layer" aria-hidden>
                  {anim.ghosts.map((ghost, index) => {
                    const fromX = files.indexOf(
                      ghost.from[0] as (typeof FILES)[number],
                    );
                    const fromY = ranks.indexOf(Number(ghost.from[1]));
                    const toX = files.indexOf(
                      ghost.to[0] as (typeof FILES)[number],
                    );
                    const toY = ranks.indexOf(Number(ghost.to[1]));
                    return (
                      <span
                        key={`${anim.id}-${index}`}
                        className={`board-ghost ${ghost.fade ? "board-ghost--fade" : "board-ghost--slide"}`}
                        style={
                          {
                            left: `${toX * 12.5}%`,
                            top: `${toY * 12.5}%`,
                            "--dx": `${(fromX - toX) * 100}%`,
                            "--dy": `${(fromY - toY) * 100}%`,
                          } as CSSProperties
                        }
                      >
                        <span className={`piece piece--${ghost.color}`}>
                          {ghost.glyph}
                        </span>
                      </span>
                    );
                  })}
                </div>
              )}
              {drag && (
                <div className="drag-layer" aria-hidden>
                  <span className="drag-piece" ref={dragElRef}>
                    <span className={`piece piece--${drag.color}`}>
                      {drag.glyph}
                    </span>
                  </span>
                </div>
              )}
            </div>

            {connection === "idle" && !pastGame && (
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
            active={
              !pastGame && state?.clock.running === bottomColor && !state.result
            }
            bottom
          />
        </div>

        <aside className="match-panel">
          <div className="match-heading">
            <span className="panel-kicker">
              {pastGame ? "GAME ARCHIVE" : "MATCH ROOM"}
            </span>
            <h2>
              {pastGame
                ? pastGame.result
                : replayPly !== null
                  ? `Position ${viewedPly} of ${lastPly}`
                  : state
                    ? relativeStatus(state, role)
                    : "Ready when you are"}
            </h2>
            <p>
              {pastGame
                ? `${pastGame.players.w || "White"} vs ${pastGame.players.b || "Black"}`
                : replayPly !== null
                  ? "Reviewing the live game. The clock is still running."
                  : state
                    ? playerLabel(role)
                    : "One table. Two players. Every move live."}
            </p>
          </div>

          {pastGame ? (
            <div className="invite-card archive-summary">
              <span>
                PLAYED {new Date(pastGame.finishedAt).toLocaleDateString()}
              </span>
              <div>
                <strong>{pastGame.room}</strong>
                <button
                  onClick={() => {
                    setPastGame(null);
                    setReplayPly(null);
                  }}
                >
                  Return {state ? "live" : "home"}
                </button>
              </div>
              <p>{pastGame.history.length} half-moves saved.</p>
            </div>
          ) : room ? (
            <div className="invite-card">
              <span>INVITE CODE</span>
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

          <div className="moves-panel">
            <div className="moves-header">
              <span>MOVE SHEET</span>
              <span>
                {pastGame
                  ? `${pastGame.history.length} PLIES`
                  : !state?.result
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
            {pastGame ? (
              <p>
                AI explanations are available immediately after a live game.
                Past-game support is coming next.
              </p>
            ) : !state?.result ? (
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

          {state && !pastGame && (
            <div className="match-actions">
              <button onClick={() => send({ type: "reset" })}>↻ Rematch</button>
              <button
                onClick={() => send({ type: "undo" })}
                disabled={
                  role === "spectator" ||
                  Boolean(state.result) ||
                  replayPly !== null ||
                  state.history.length <
                    ((state.history.length % 2 === 0 ? "w" : "b") === role
                      ? 2
                      : 1)
                }
              >
                ↶ Undo
              </button>
              <button
                onClick={() => send({ type: "resign" })}
                disabled={role === "spectator" || Boolean(state.result)}
              >
                Resign
              </button>
            </div>
          )}
          {state?.result && !pastGame && (
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
                      Seer is reviewing the game…
                    </div>
                    <div className="seer-scan-log">
                      {seerTicker.map((line) => (
                        <div key={line.id}>{line.text}</div>
                      ))}
                    </div>
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
          <div className="archive-panel">
            <div className="moves-header">
              <span>PAST GAMES</span>
              <button onClick={() => void loadPastGames()}>Refresh</button>
            </div>
            <div className="archive-list">
              {pastGamesLoading ? (
                <p>Loading your games…</p>
              ) : pastGames.length ? (
                pastGames.map((game) => (
                  <button
                    className={pastGame?.id === game.id ? "is-active" : ""}
                    key={game.id}
                    onClick={() => void openPastGame(game.id)}
                  >
                    <span>
                      <b>{game.players.w || "White"}</b> vs{" "}
                      <b>{game.players.b || "Black"}</b>
                    </span>
                    <small>
                      {game.result} · {game.plyCount} plies ·{" "}
                      {new Date(game.finishedAt).toLocaleDateString()}
                    </small>
                  </button>
                ))
              ) : (
                <p>Finished games you play will appear here.</p>
              )}
            </div>
          </div>
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
