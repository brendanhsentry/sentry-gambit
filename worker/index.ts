/** Cloudflare Worker entry point with an in-process WebSocket chess table service. */
import { Chess, type Color, type PieceSymbol } from "chess.js";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  TABLES: DurableObjectNamespace;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface AcceptedWebSocket extends WebSocket {
  accept(): void;
}

declare const WebSocketPair: {
  new(): { 0: WebSocket; 1: AcceptedWebSocket };
};

type Role = Color | "spectator";

type TableClient = {
  id: string;
  name: string;
  role: Role;
  socket: AcceptedWebSocket;
};

type Table = {
  id: string;
  chess: Chess;
  clients: Set<TableClient>;
  seats: { w: TableClient | null; b: TableClient | null };
  result: string | null;
  clock: { w: number; b: number; running: Color | null; since: number | null };
  touchedAt: number;
};

const STARTING_TIME = 10 * 60 * 1000;

type PersistedTable = {
  moves: string[];
  result: string | null;
  clock: Table["clock"];
};

function createTable(id: string): Table {
  return {
    id,
    chess: new Chess(),
    clients: new Set(),
    seats: { w: null, b: null },
    result: null,
    clock: { w: STARTING_TIME, b: STARTING_TIME, running: null, since: null },
    touchedAt: Date.now(),
  };
}

function serializeTable(table: Table) {
  return {
    room: table.id,
    fen: table.chess.fen(),
    history: table.chess.history({ verbose: true }).map((move) => ({
      from: move.from,
      to: move.to,
      san: move.san,
      color: move.color,
      promotion: move.promotion,
    })),
    players: {
      w: table.seats.w?.name ?? null,
      b: table.seats.b?.name ?? null,
    },
    result: table.result,
    clock: table.clock,
  };
}

function send(client: TableClient, payload: unknown) {
  try {
    client.socket.send(JSON.stringify(payload));
  } catch {
    // A close event will remove stale clients.
  }
}

function broadcast(table: Table) {
  const payload = JSON.stringify({ type: "state", state: serializeTable(table) });
  for (const client of table.clients) {
    try {
      client.socket.send(payload);
    } catch {
      // A close event will remove stale clients.
    }
  }
}

function pauseClock(table: Table, now = Date.now()) {
  const running = table.clock.running;
  if (running && table.clock.since !== null) {
    table.clock[running] = Math.max(0, table.clock[running] - (now - table.clock.since));
  }
  table.clock.running = null;
  table.clock.since = null;
}

function resumeClock(table: Table, now = Date.now()) {
  if (!table.result && table.seats.w && table.seats.b) {
    table.clock.running = table.chess.turn();
    table.clock.since = now;
  }
}

function flagIfExpired(table: Table, now = Date.now()) {
  const running = table.clock.running;
  if (!running || table.clock.since === null || table.result) return false;
  const remaining = table.clock[running] - (now - table.clock.since);
  if (remaining > 0) return false;
  table.clock[running] = 0;
  table.clock.running = null;
  table.clock.since = null;
  table.result = `${running === "w" ? "Black" : "White"} wins on time`;
  return true;
}

function setBoardResult(table: Table) {
  if (table.chess.isCheckmate()) {
    table.result = `${table.chess.turn() === "w" ? "Black" : "White"} wins by checkmate`;
  } else if (table.chess.isStalemate()) {
    table.result = "Draw by stalemate";
  } else if (table.chess.isThreefoldRepetition()) {
    table.result = "Draw by repetition";
  } else if (table.chess.isInsufficientMaterial()) {
    table.result = "Draw by insufficient material";
  } else if (table.chess.isDrawByFiftyMoves()) {
    table.result = "Draw by the fifty-move rule";
  } else if (table.chess.isDraw()) {
    table.result = "Draw";
  }
  if (table.result) pauseClock(table);
}

function handleTableMessage(table: Table, client: TableClient, raw: string, onChanged: () => void) {
  let message: { type?: string; from?: string; to?: string; promotion?: PieceSymbol };
  try {
    message = JSON.parse(raw);
  } catch {
    send(client, { type: "error", message: "That message could not be read." });
    return;
  }

  table.touchedAt = Date.now();
  if (message.type === "move") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    if (client.role !== table.chess.turn()) {
      send(client, { type: "error", message: "Wait for your turn." });
      return;
    }
    if (flagIfExpired(table)) {
      broadcast(table);
      return;
    }
    if (!message.from || !message.to) return;

    const now = Date.now();
    pauseClock(table, now);
    try {
      table.chess.move({ from: message.from, to: message.to, promotion: message.promotion || "q" });
    } catch {
      resumeClock(table, now);
      send(client, { type: "error", message: "That move is not legal." });
      return;
    }
    setBoardResult(table);
    if (!table.result) resumeClock(table, now);
    onChanged();
    broadcast(table);
    return;
  }

  if (message.type === "resign") {
    if (table.result || (client.role !== "w" && client.role !== "b")) return;
    table.result = `${client.role === "w" ? "Black" : "White"} wins by resignation`;
    pauseClock(table);
    onChanged();
    broadcast(table);
    return;
  }

  if (message.type === "reset") {
    if (client.role === "spectator") return;
    table.chess.reset();
    table.result = null;
    table.clock = { w: STARTING_TIME, b: STARTING_TIME, running: null, since: null };
    resumeClock(table);
    onChanged();
    broadcast(table);
    return;
  }

  if (message.type === "flag" && flagIfExpired(table)) {
    onChanged();
    broadcast(table);
  }
}

export class ChessTable {
  private readonly durableState: DurableObjectState;
  private table: Table | null = null;
  private loading: Promise<void> | null = null;

  constructor(state: DurableObjectState) {
    this.durableState = state;
  }

  private async load(roomId: string) {
    if (this.table) return;
    if (!this.loading) {
      this.loading = (async () => {
        const table = createTable(roomId);
        const saved = await this.durableState.storage.get<PersistedTable>("game");
        if (saved) {
          for (const move of saved.moves) table.chess.move(move);
          table.result = saved.result;
          table.clock = saved.clock;
          // A room with no connected players is always paused while dormant.
          table.clock.running = null;
          table.clock.since = null;
        }
        this.table = table;
      })();
    }
    await this.loading;
  }

  private persist() {
    if (!this.table) return;
    const value: PersistedTable = {
      moves: this.table.chess.history(),
      result: this.table.result,
      clock: this.table.clock,
    };
    this.durableState.waitUntil(this.durableState.storage.put("game", value));
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const roomId = (url.searchParams.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!roomId) return new Response("A room code is required", { status: 400 });
    await this.load(roomId);
    const table = this.table!;

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const name = (url.searchParams.get("name") || "Guest player").trim().slice(0, 24) || "Guest player";
    const pair = new WebSocketPair();
    const browserSocket = pair[0];
    const serverSocket = pair[1];
    serverSocket.accept();

    const role: Role = !table.seats.w ? "w" : !table.seats.b ? "b" : "spectator";
    const client: TableClient = { id: crypto.randomUUID(), name, role, socket: serverSocket };
    table.clients.add(client);
    if (role === "w" || role === "b") table.seats[role] = client;
    table.touchedAt = Date.now();
    if (!table.clock.running) resumeClock(table);

    serverSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") handleTableMessage(table, client, event.data, () => this.persist());
    });
    serverSocket.addEventListener("close", () => {
      pauseClock(table);
      table.clients.delete(client);
      if (client.role === "w" || client.role === "b") {
        if (table.seats[client.role]?.id === client.id) table.seats[client.role] = null;
      }
      this.persist();
      broadcast(table);
    });
    serverSocket.addEventListener("error", () => serverSocket.close());

    send(client, { type: "welcome", role, playerId: client.id, state: serializeTable(table) });
    broadcast(table);

    return new Response(null, { status: 101, webSocket: browserSocket } as ResponseInit);
  }
}

async function openTableSocket(request: Request, env: Env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const url = new URL(request.url);
  const roomId = (url.searchParams.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (!roomId) return new Response("A room code is required", { status: 400 });
  const id = env.TABLES.idFromName(roomId);
  return env.TABLES.get(id).fetch(request);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") return openTableSocket(request, env);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
