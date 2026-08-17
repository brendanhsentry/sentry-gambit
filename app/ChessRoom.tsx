"use client";

import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  fen: string;
  history: ReviewMove[];
  players: { w: string | null; b: string | null };
  result: string | null;
  clock: ClockState;
};

type ServerMessage =
  | { type: "welcome"; role: Role; playerId: string; state: GameState }
  | { type: "state"; state: GameState }
  | { type: "error"; message: string };

const START_FEN = new Chess().fen();
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const PIECES: Record<Color, Record<PieceSymbol, string>> = {
  w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" },
};

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
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
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [role, setRole] = useState<Role>("spectator");
  const [connection, setConnection] = useState<"idle" | "connecting" | "online" | "offline">("idle");
  const [state, setState] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square; color: Color } | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const analysis = useMoveAnalysis(room, state?.history ?? [], Boolean(state?.result));

  const send = useCallback((payload: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const flagClock = useCallback(() => send({ type: "flag" }), [send]);
  const now = useClock(state?.clock ?? null, flagClock);

  const chess = useMemo(() => {
    try {
      return new Chess(state?.fen || START_FEN);
    } catch {
      return new Chess();
    }
  }, [state?.fen]);

  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(chess.moves({ square: selected, verbose: true }).map((move) => move.to));
  }, [chess, selected]);

  const connect = useCallback((nextRoom: string, nextName: string) => {
    const cleanRoom = nextRoom.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const cleanName = nextName.trim().slice(0, 24) || "Guest player";
    if (!cleanRoom) return;

    socketRef.current?.close();
    setConnection("connecting");
    setRoom(cleanRoom);
    setNotice("");
    setSelected(null);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws?room=${encodeURIComponent(cleanRoom)}&name=${encodeURIComponent(cleanName)}`);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (incomingRoom) setRoomInput(incomingRoom.toUpperCase());
    return () => socketRef.current?.close();
  }, []);

  useEffect(() => {
    if (connection !== "offline" || !room) return;
    const id = window.setTimeout(() => connect(room, name), 1600);
    return () => window.clearTimeout(id);
  }, [connection, room, name, connect]);

  const orientation: Color = role === "b" ? "b" : "w";
  const ranks = orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = orientation === "w" ? [...FILES] : [...FILES].reverse();
  const lastMove = state?.history.at(-1);
  const topColor: Color = orientation === "w" ? "b" : "w";
  const bottomColor: Color = orientation;
  const topTime = state ? projectedTime(state.clock, topColor, now) : 600_000;
  const bottomTime = state ? projectedTime(state.clock, bottomColor, now) : 600_000;

  function handleSquare(square: Square) {
    if (!state || state.result || role === "spectator" || chess.turn() !== role) return;
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

  const movePairs = state?.history.reduce<Array<{ number: number; w?: { san: string; index: number }; b?: { san: string; index: number } }>>((pairs, move, index) => {
    if (index % 2 === 0) pairs.push({ number: Math.floor(index / 2) + 1, w: { san: move.san, index } });
    else pairs[pairs.length - 1].b = { san: move.san, index };
    return pairs;
  }, []) ?? [];

  function moveCell(move?: { san: string; index: number }) {
    if (!move) return <strong className="move-cell"><span>—</span></strong>;
    const reviewed = analysis.moves[move.index];
    const title = reviewed
      ? `${gradeLabel(reviewed.grade)}${reviewed.expectedPointsLoss === null ? "" : ` · ${(reviewed.expectedPointsLoss * 100).toFixed(1)} expected points lost`}`
      : undefined;
    return (
      <strong className="move-cell" title={title}>
        <span>{move.san}</span>
        {reviewed && <small className={`move-grade move-grade--${reviewed.grade}`}>{gradeLabel(reviewed.grade)}</small>}
      </strong>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Sentry Gambit home">
          <span className="brand-mark">♞</span>
          <span>SENTRY <em>GAMBIT</em></span>
        </Link>
        <div className="topbar-note"><span className="live-dot" /> LIVE TABLES · RAPID 10</div>
        <button className="text-button" onClick={() => { socketRef.current?.close(); setConnection("idle"); setRoom(""); setState(null); window.history.replaceState({}, "", "/"); }}>New table</button>
      </header>

      <section className="game-layout">
        <div className="board-column">
          <div className="eyebrow-row">
            <span>{room ? `PRIVATE TABLE · ${room}` : "PRIVATE TABLE"}</span>
            <span className={`connection ${connection}`}>{connection === "online" ? "CONNECTED" : connection === "connecting" ? "CONNECTING" : connection === "offline" ? "RECONNECTING" : "READY"}</span>
          </div>

          <PlayerCard
            name={state?.players[topColor] ?? null}
            color={topColor}
            time={topTime}
            active={state?.clock.running === topColor && !state.result}
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
                    {piece && <span className={`piece piece--${piece.color}`}>{PIECES[piece.color][piece.type]}</span>}
                    {isTarget && <span className={piece ? "capture-ring" : "move-dot"} />}
                  </button>
                );
              }))}
            </div>

            {connection === "idle" && (
              <div className="lobby-card">
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
              </div>
            )}

            {promotion && (
              <div className="promotion-picker" role="dialog" aria-label="Choose promotion piece">
                <span>Promote pawn to</span>
                <div>
                  {(["q", "r", "b", "n"] as PieceSymbol[]).map((piece) => (
                    <button key={piece} onClick={() => send({ type: "move", from: promotion.from, to: promotion.to, promotion: piece })} aria-label={`Promote to ${piece}`}>
                      {PIECES[promotion.color][piece]}
                    </button>
                  ))}
                </div>
                <button className="promotion-cancel" onClick={() => setPromotion(null)}>Cancel</button>
              </div>
            )}
          </div>

          <PlayerCard
            name={state?.players[bottomColor] ?? null}
            color={bottomColor}
            time={bottomTime}
            active={state?.clock.running === bottomColor && !state.result}
            bottom
          />
        </div>

        <aside className="match-panel">
          <div className="match-heading">
            <span className="panel-kicker">MATCH ROOM</span>
            <h2>{state ? relativeStatus(state, role) : "Ready when you are"}</h2>
            <p>{state ? playerLabel(role) : "One table. Two players. Every move live."}</p>
          </div>

          {room ? (
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
                {analysis.status === "loading" || analysis.status === "analyzing"
                  ? `REVIEWING ${analysis.completed}/${state?.history.length ?? 0}`
                  : analysis.status === "complete"
                    ? "LOCAL REVIEW COMPLETE"
                    : analysis.status === "error"
                      ? "REVIEW UNAVAILABLE"
                      : state?.result
                        ? `${state.history.length} PLIES`
                        : "REVIEW AFTER GAME"}
              </span>
            </div>
            <div className="moves-table">
              {movePairs.length ? movePairs.map((pair) => (
                <div className="move-row" key={pair.number}>
                  <span>{pair.number}.</span>{moveCell(pair.w)}{moveCell(pair.b)}
                </div>
              )) : <div className="empty-moves"><span>♙</span><p>The move sheet is empty.<br />White begins.</p></div>}
            </div>
          </div>

          {state && (
            <div className="match-actions">
              <button onClick={() => send({ type: "reset" })}>↻ Rematch</button>
              <button onClick={() => send({ type: "resign" })} disabled={role === "spectator" || Boolean(state.result)}>Resign</button>
            </div>
          )}
          {notice && <div className="notice" role="status">{notice}</div>}
        </aside>
      </section>

      <footer>
        <span>SENTRY GAMBIT · EST. 2026</span>
        <span>PRIVATE ROOMS · REAL-TIME PLAY · NO SIGN-UP</span>
      </footer>
    </main>
  );
}
