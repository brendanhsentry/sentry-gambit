"use client";

import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconSeer } from "./IconSeer";
import { PIECE_GLYPHS } from "./chess-pieces";
import { startGameReplay, stopGameReplay } from "./sentry-replay";
import { gradeLabel, useMoveAnalysis, type ReviewMove } from "./move-analysis";

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
      message?: string;
    };

const START_FEN = new Chess().fen();
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const EXPLAINABLE_GRADES = new Set(["inaccuracy", "mistake", "miss", "blunder"]);
function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
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
  if (role === turn) return chess.isCheck() ? "Your king is in check" : "Your move";
  if (role === "spectator") return `${turn === "w" ? "White" : "Black"} to move`;
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

function PlayerCard({ name, color, time, active, bottom }: {
  name: string | null;
  color: Color;
  time: number;
  active: boolean;
  bottom?: boolean;
}) {
  const fallback = color === "w" ? "Waiting for white" : "Waiting for black";
  return (
    <div className={`player-card ${bottom ? "player-card--bottom" : ""}`}>
      <div className={`player-avatar player-avatar--${color}`}>{color === "w" ? "W" : "B"}</div>
      <div className="player-identity">
        <strong>{name || fallback}</strong>
        <span>{name ? (active ? "Thinking…" : "At the table") : "Open seat"}</span>
      </div>
      <div className={`clock ${active ? "clock--active" : ""}`} aria-label={`${color === "w" ? "White" : "Black"} clock`}>
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
  const [connection, setConnection] = useState<"idle" | "connecting" | "online" | "offline">("idle");
  const [state, setState] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square; color: Color } | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [pastGames, setPastGames] = useState<PastGameSummary[]>([]);
  const [pastGamesLoading, setPastGamesLoading] = useState(true);
  const [pastGame, setPastGame] = useState<PastGame | null>(null);
  const [replayPly, setReplayPly] = useState<number | null>(null);
  const [analysisPly, setAnalysisPly] = useState<number | null>(null);
  const [moveExplanations, setMoveExplanations] = useState<Record<number, MoveExplanation>>({});
  const reportedGradesRef = useRef(new Set<string>());
  const explanationRequestsRef = useRef(new Set<number>());

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
      const response = await fetch(`/api/games?limit=12&playerKey=${encodeURIComponent(key)}`);
      if (!response.ok) throw new Error("Game archive unavailable");
      const data = await response.json() as { games: PastGameSummary[] };
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
      const response = await fetch(`/api/games/${encodeURIComponent(gameId)}?playerKey=${encodeURIComponent(key)}`);
      if (!response.ok) throw new Error("Game not found");
      const game = await response.json() as PastGame;
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
    state && !state.result && state.players.w && state.players.b && role !== "spectator",
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
        const res = await fetch(`/api/review?gameId=${encodeURIComponent(currentGameId)}`, { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          setSeer({ phase: "running", issueId: String(data.issueId), shortId: String(data.shortId ?? "") });
          return;
        }
        if (res.status !== 404) {
          const data = await res.json().catch(() => ({} as { error?: string }));
          setSeer({ phase: "error", message: data.error ?? "The review could not be started." });
          return;
        }
      } catch {
        // Network hiccup; retry below.
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    setSeer({ phase: "error", message: "The game has not reached Sentry yet. Try again in a minute." });
  }, [currentGameId]);

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
        const res = await fetch(`/api/review/status?issueId=${encodeURIComponent(seer.issueId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === "completed" && data.text) {
          setSeer({ phase: "done", text: data.text, shortId: seer.shortId });
        } else if (data.status === "errored" || data.status === "failed" || data.status === "cancelled") {
          setSeer({ phase: "error", message: "Seer hit an error while reviewing. Try again." });
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
      !EXPLAINABLE_GRADES.has(reviewed.grade)
    ) return;

    const existing = moveExplanations[ply];
    if (existing?.phase === "loading" || existing?.phase === "done") return;
    if (explanationRequestsRef.current.has(ply)) return;
    explanationRequestsRef.current.add(ply);
    setMoveExplanations((current) => ({ ...current, [ply]: { phase: "loading" } }));

    try {
      const response = await fetch("/api/move-explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade: reviewed.grade, ...reviewed.evidence }),
      });
      const data = await response.json() as {
        motif?: string;
        explanation?: string;
        playedLine?: string[];
        bestLine?: string[];
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
    if (viewedPly === lastPly) return pastGame?.finalFen ?? state?.fen ?? START_FEN;
    const position = new Chess();
    for (const move of viewHistory.slice(0, viewedPly)) {
      position.move({ from: move.from, to: move.to, promotion: move.promotion ?? "q" });
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

  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(chess.moves({ square: selected, verbose: true }).map((move) => move.to));
  }, [chess, selected]);

  const connect = useCallback((nextRoom: string, nextName: string) => {
    const cleanRoom = nextRoom.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
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
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws?room=${encodeURIComponent(cleanRoom)}&name=${encodeURIComponent(cleanName)}&playerKey=${encodeURIComponent(playerKey)}`);
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
    socket.addEventListener("close", () => setConnection("offline"));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incomingRoom = params.get("room");
    // This synchronizes the invite code from the browser URL on first mount.
    if (incomingRoom) {
      const cleaned = incomingRoom.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRoomInput(cleaned);
      setInvitedRoom(cleaned || null);
    }
    return () => socketRef.current?.close();
  }, []);

  useEffect(() => {
    if (connection !== "offline" || !room) return;
    const id = window.setTimeout(() => connect(room, name), 1600);
    return () => window.clearTimeout(id);
  }, [connection, room, name, connect]);

  const orientation: Color = pastGame ? "w" : role === "b" ? "b" : "w";
  const ranks = orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = orientation === "w" ? [...FILES] : [...FILES].reverse();
  const lastMove = viewHistory[viewedPly - 1];
  const topColor: Color = orientation === "w" ? "b" : "w";
  const bottomColor: Color = orientation;
  const displayedPlayers = pastGame?.players ?? state?.players ?? { w: null, b: null };
  const topTime = pastGame
    ? pastGame.clock[topColor]
    : state ? projectedTime(state.clock, topColor, now) : 600_000;
  const bottomTime = pastGame
    ? pastGame.clock[bottomColor]
    : state ? projectedTime(state.clock, bottomColor, now) : 600_000;

  function handleSquare(square: Square) {
    if (pastGame || replayPly !== null || !state || state.result || role === "spectator" || chess.turn() !== role) return;
    const piece = chess.get(square);
    if (!selected) {
      if (piece?.color === role) setSelected(square);
      return;
    }
    if (piece?.color === role) {
      setSelected(square);
      return;
    }
    const options = chess.moves({ square: selected, verbose: true }).filter((move) => move.to === square);
    if (!options.length) {
      setSelected(null);
      return;
    }
    if (options.some((move) => move.promotion)) {
      setPromotion({ from: selected, to: square, color: role });
      return;
    }
    send({ type: "move", from: selected, to: square });
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

  const movePairs = viewHistory.reduce<Array<{ number: number; w?: { san: string; index: number }; b?: { san: string; index: number } }>>((pairs, move, index) => {
    if (index % 2 === 0) pairs.push({ number: Math.floor(index / 2) + 1, w: { san: move.san, index } });
    else pairs[pairs.length - 1].b = { san: move.san, index };
    return pairs;
  }, []);
  const selectedReview = analysisPly ? analysis.moves[analysisPly - 1] : null;
  const selectedExplanation = analysisPly ? moveExplanations[analysisPly] : null;

  function moveCell(move?: { san: string; index: number }) {
    if (!move) return <span className="move-cell"><span>—</span></span>;
    const reviewed = !pastGame && state?.result ? analysis.moves[move.index] : null;
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
        {reviewed && <small className={`move-grade move-grade--${reviewed.grade}`}>{gradeLabel(reviewed.grade)}</small>}
      </button>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Pawn Patrol home">
          <span className="brand-mark">
            <Image src="/pawn-patrol-icon.svg" alt="" width={30} height={30} priority />
          </span>
          <span>PAWN <em>PATROL</em></span>
        </Link>
        <div className="topbar-note"><span className="live-dot" /> LIVE TABLES · RAPID 10</div>
        <div className="topbar-actions">
          <Link className="text-button" href="/games">Past games</Link>
          <button className="text-button" onClick={() => { socketRef.current?.close(); setConnection("idle"); setRoom(""); setState(null); setPastGame(null); setReplayPly(null); setInvitedRoom(null); setRoomInput(""); window.history.replaceState({}, "", "/"); }}>New table</button>
        </div>
      </header>

      <section className="game-layout">
        <div className="board-column">
          <div className="eyebrow-row">
            <span>{pastGame ? `SAVED GAME · ${pastGame.room}` : room ? `PRIVATE TABLE · ${room}` : "PRIVATE TABLE"}</span>
            <span className={`connection ${connection}`}>{pastGame ? "REPLAY" : connection === "online" ? "CONNECTED" : connection === "connecting" ? "CONNECTING" : connection === "offline" ? "RECONNECTING" : "READY"}</span>
          </div>

          <PlayerCard
            name={displayedPlayers[topColor]}
            color={topColor}
            time={topTime}
            active={!pastGame && state?.clock.running === topColor && !state.result}
          />

          <div className="board-wrap">
            <div className="chessboard" role="grid" aria-label={`Chess board, ${orientation === "w" ? "white" : "black"} orientation`}>
              {ranks.flatMap((rank, rankIndex) => files.map((file, fileIndex) => {
                const square = `${file}${rank}` as Square;
                const piece = chess.get(square);
                const dark = (rank + FILES.indexOf(file)) % 2 === 1;
                const isSelected = selected === square;
                const isTarget = legalTargets.has(square);
                const wasMoved = lastMove?.from === square || lastMove?.to === square;
                const isCheckedKing = piece?.type === "k" && piece.color === chess.turn() && chess.isCheck();
                return (
                  <button
                    key={square}
                    className={`square ${dark ? "square--dark" : "square--light"} ${isSelected ? "is-selected" : ""} ${wasMoved ? "was-moved" : ""} ${isCheckedKing ? "is-check" : ""}`}
                    onClick={() => handleSquare(square)}
                    role="gridcell"
                    aria-label={`${square}${piece ? `, ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ""}`}
                  >
                    {fileIndex === 0 && <span className="rank-label">{rank}</span>}
                    {rankIndex === 7 && <span className="file-label">{file}</span>}
                    {piece && <span className={`piece piece--${piece.color}`}>{PIECE_GLYPHS[piece.type]}</span>}
                    {isTarget && <span className={piece ? "capture-ring" : "move-dot"} />}
                  </button>
                );
              }))}
            </div>

            {connection === "idle" && !pastGame && (
              <div className="lobby-card">
                {invitedRoom ? (
                  <>
                    <span className="lobby-kicker">YOU&apos;RE INVITED</span>
                    <h1>Take your seat.</h1>
                    <p>You&apos;ve been invited to table {invitedRoom}. Enter a name and join the game.</p>
                    <label>
                      <span>Your name</span>
                      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Mikhail" maxLength={24} />
                    </label>
                    <button className="primary-button" onClick={() => connect(invitedRoom, name)}>Join table {invitedRoom} <span>→</span></button>
                  </>
                ) : (
                  <>
                    <span className="lobby-kicker">PLAY HEAD TO HEAD</span>
                    <h1>Your board.<br />Your move.</h1>
                    <p>Create a private table or enter a code from a friend. No account needed.</p>
                    <label>
                      <span>Your name</span>
                      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Mikhail" maxLength={24} />
                    </label>
                    <button className="primary-button" onClick={startTable}>Create a table <span>→</span></button>
                    <div className="join-row">
                      <input value={roomInput} onChange={(event) => setRoomInput(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="ROOM CODE" maxLength={8} aria-label="Room code" />
                      <button onClick={() => connect(roomInput, name)} disabled={!roomInput}>Join</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {promotion && (
              <div className="promotion-picker" role="dialog" aria-label="Choose promotion piece">
                <span>Promote pawn to</span>
                <div>
                  {(["q", "r", "b", "n"] as PieceSymbol[]).map((piece) => (
                    <button key={piece} onClick={() => send({ type: "move", from: promotion.from, to: promotion.to, promotion: piece })} aria-label={`Promote to ${piece}`}>
                      {PIECE_GLYPHS[piece]}
                    </button>
                  ))}
                </div>
                <button className="promotion-cancel" onClick={() => setPromotion(null)}>Cancel</button>
              </div>
            )}
          </div>

          <PlayerCard
            name={displayedPlayers[bottomColor]}
            color={bottomColor}
            time={bottomTime}
            active={!pastGame && state?.clock.running === bottomColor && !state.result}
            bottom
          />
        </div>

        <aside className="match-panel">
          <div className="match-heading">
            <span className="panel-kicker">{pastGame ? "GAME ARCHIVE" : "MATCH ROOM"}</span>
            <h2>{pastGame ? pastGame.result : replayPly !== null ? `Position ${viewedPly} of ${lastPly}` : state ? relativeStatus(state, role) : "Ready when you are"}</h2>
            <p>{pastGame ? `${pastGame.players.w || "White"} vs ${pastGame.players.b || "Black"}` : replayPly !== null ? "Reviewing the live game. The clock is still running." : state ? playerLabel(role) : "One table. Two players. Every move live."}</p>
          </div>

          {pastGame ? (
            <div className="invite-card archive-summary">
              <span>PLAYED {new Date(pastGame.finishedAt).toLocaleDateString()}</span>
              <div><strong>{pastGame.room}</strong><button onClick={() => { setPastGame(null); setReplayPly(null); }}>Return {state ? "live" : "home"}</button></div>
              <p>{pastGame.history.length} half-moves saved.</p>
            </div>
          ) : room ? (
            <div className="invite-card">
              <span>INVITE CODE</span>
              <div><strong>{room}</strong><button onClick={copyInvite}>{copied ? "Copied!" : "Copy link"}</button></div>
              <p>{state?.players.w && state?.players.b ? "Both players are seated." : "Share this with your opponent."}</p>
            </div>
          ) : (
            <div className="rule-card">
              <span>HOW IT WORKS</span>
              <ol>
                <li><b>01</b> Create a private table</li>
                <li><b>02</b> Share the six-character code</li>
                <li><b>03</b> Play in real time</li>
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
                  : analysis.status === "loading" || analysis.status === "analyzing"
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
                <button onClick={() => goToPly(0)} disabled={viewedPly === 0} aria-label="Starting position">|‹</button>
                <button onClick={() => goToPly(viewedPly - 1)} disabled={viewedPly === 0} aria-label="Previous move">‹</button>
                <span>{viewedPly === 0 ? "Start" : `${Math.ceil(viewedPly / 2)}${viewedPly % 2 ? ". White" : "… Black"}`}</span>
                <button onClick={() => goToPly(viewedPly + 1)} disabled={viewedPly === lastPly} aria-label="Next move">›</button>
                <button onClick={() => goToPly(lastPly)} disabled={viewedPly === lastPly} aria-label="Latest position">›|</button>
              </div>
            )}
            <div className="moves-table">
              {movePairs.length ? movePairs.map((pair) => (
                <div className="move-row" key={pair.number}>
                  <span>{pair.number}.</span>{moveCell(pair.w)}{moveCell(pair.b)}
                </div>
              )) : <div className="empty-moves"><span>{PIECE_GLYPHS.p}</span><p>The move sheet is empty.<br />White begins.</p></div>}
            </div>
          </div>

          {analysisPly && selectedReview?.evidence && EXPLAINABLE_GRADES.has(selectedReview.grade) && (
            <div className="move-explanation" aria-live="polite">
              <div className="move-explanation-head">
                <span className={`move-grade move-grade--${selectedReview.grade}`}>{gradeLabel(selectedReview.grade)}</span>
                <strong>{Math.ceil(analysisPly / 2)}{analysisPly % 2 ? "." : "…"} {viewHistory[analysisPly - 1]?.san}</strong>
                {selectedReview.expectedPointsLoss !== null && (
                  <small>{(selectedReview.expectedPointsLoss * 100).toFixed(1)} expected points lost</small>
                )}
              </div>
              {selectedExplanation?.phase === "loading" || !selectedExplanation ? (
                <p className="move-explanation-loading">Asking the coach to explain Stockfish&apos;s line…</p>
              ) : (
                <>
                  {selectedExplanation.phase === "done" && (
                    <p className="move-explanation-copy">{selectedExplanation.explanation}</p>
                  )}
                  {selectedExplanation.phase === "error" && (
                    <p className="move-explanation-error">
                      {selectedExplanation.message}
                      <button onClick={() => void requestMoveExplanation(analysisPly - 1)}>Retry</button>
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
              <button onClick={() => send({ type: "resign" })} disabled={role === "spectator" || Boolean(state.result)}>Resign</button>
            </div>
          )}
          {state?.result && !pastGame && (
            <div className="seer-widget">
              <div className="seer-head">
                <span className="seer-eye"><IconSeer size={16} /></span>
                <span>Seer Autofix</span>
                <span className="seer-head-spacer" />
                <button
                  className="seer-icon-btn"
                  aria-label="Start a new analysis"
                  title="Start a new analysis"
                  onClick={requestSeerReview}
                  disabled={seer.phase === "requesting" || seer.phase === "running"}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" /></svg>
                </button>
                <button
                  className="seer-icon-btn"
                  aria-label="Copy analysis"
                  title="Copy analysis"
                  onClick={copySeerReview}
                  disabled={seer.phase !== "done"}
                >
                  {seerCopied ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M2.5 8.5l3.5 3.5 7-8" /></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>
                  )}
                </button>
              </div>
              <div className="seer-body">
                {seer.phase === "idle" && (
                  <>
                    <p className="seer-intro">Seer can replay this game, find where it went wrong, and explain the blunder — a post-mortem for your queen.</p>
                    <button className="seer-cta" onClick={requestSeerReview}><IconSeer size={15} /> Start Seer Analysis</button>
                  </>
                )}
                {(seer.phase === "requesting" || seer.phase === "running") && (
                  <div className="seer-loading">
                    <div className="seer-scan-row"><span className="seer-eye"><IconSeer size={18} animation="loading" /></span> Seer is reviewing the game…</div>
                    <div className="seer-scan-log">
                      <div>Reading the game event…</div>
                      <div>Replaying the moves…</div>
                      <div>Locating the eval swings…</div>
                      <div>Formulating the verdict — this can take a few minutes…</div>
                    </div>
                  </div>
                )}
                {seer.phase === "done" && (
                  <div className="seer-card">
                    <div className="seer-card-head">
                      <span className="seer-eye"><IconSeer size={14} /></span> Root Cause
                      {seer.shortId ? <span className="seer-chip">{seer.shortId}</span> : null}
                    </div>
                    <div className="seer-card-body">{seer.text}</div>
                  </div>
                )}
                {seer.phase === "error" && (
                  <p className="seer-error">{seer.message} <button className="seer-retry" onClick={requestSeerReview}>Retry</button></p>
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
              ) : pastGames.length ? pastGames.map((game) => (
                <button className={pastGame?.id === game.id ? "is-active" : ""} key={game.id} onClick={() => void openPastGame(game.id)}>
                  <span><b>{game.players.w || "White"}</b> vs <b>{game.players.b || "Black"}</b></span>
                  <small>{game.result} · {game.plyCount} plies · {new Date(game.finishedAt).toLocaleDateString()}</small>
                </button>
              )) : (
                <p>Finished games you play will appear here.</p>
              )}
            </div>
          </div>
          {notice && <div className="notice" role="status">{notice}</div>}
        </aside>
      </section>

      <footer>
        <span>PAWN PATROL · EST. 2026</span>
        <span>PRIVATE ROOMS · REAL-TIME PLAY · NO SIGN-UP</span>
      </footer>
    </main>
  );
}
