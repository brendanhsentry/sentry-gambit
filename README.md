# Pawn Patrol

Live chess with private tables, shared clocks, and a private game archive.
The Next.js frontend talks to a Node WebSocket server (`server.mjs`); live
connections stay in memory while completed games and their moves are stored in
SQLite.

## Prerequisites

- Node.js `>=22.13.0`

## Local development

```bash
npm install
npm run dev      # dev server with hot reload
npm run build    # production build
npm run start    # production server
```

`npm run dev` first downloads the Maia 3 model and ONNX runtime into
`public/maia3` and `public/ort` (once, ~58 MB, via
`scripts/fetch-maia-assets.mjs`). These power five bot opponents —
Garry (1100), Mikhail (1500), Magnus (1900), and Bobby
(2200) — which run the
[Maia](https://www.maiachess.com/) human-like chess model in a browser worker
on the seated player's machine; the server stays authoritative for legality,
clocks, and archiving.

To enable on-demand explanations for Stockfish mistakes and blunders, create an
OpenRouter API key and put it in the ignored `.env.local` file:

```bash
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=deepseek/deepseek-v3.2
OPENROUTER_FALLBACK_MODELS=deepseek/deepseek-chat-v3.1
OPENROUTER_TIMEOUT_MS=30000
APP_URL=http://localhost:3000
```

The key is used only by the Node server. The browser sends validated engine
lines to `/api/move-explanation`; it never receives the credential. Click a
graded inaccuracy, mistake, miss, or blunder after the game to request an
explanation. The verified Stockfish lines remain visible if the model is
unavailable.

The server disables reasoning for these short structured answers and retries
one transient provider failure. Agent runs and individual model attempts are
instrumented with Sentry's `gen_ai.invoke_agent` and `gen_ai.chat` spans,
including latency, model, token usage, responses, retry failures, and a shared
conversation ID. Operational details live in [Sentry Agents](https://docs.sentry.io/product/agents/),
not in the player UI. Fallback models are optional and comma-separated;
`OPENROUTER_ZDR=true` can be used to require a smaller zero-data-retention
provider pool in addition to the default no-training data policy.

## Accounts and the leaderboard

Signing in is optional: guests can play everything. Creating an account
(username + password, stored in the game store with scrypt-hashed passwords)
puts your games on the Elo leaderboard at `/leaderboard`. Everyone starts at
1200 with K=32. A finished game is rated when every seat is a signed-in player
or a Patrol bot — the bots act as fixed anchors at their advertised ratings
(1100/1500/1900) — and at least two moves were played. Games involving an
anonymous guest stay unrated.

## Saved games and replay

For local development, the server creates `data/pawn-patrol.sqlite`
automatically. In production, games are stored in Firestore (selected with
`GAME_STORE=firestore`, the default when `NODE_ENV=production`; the runtime
service account authenticates automatically). Every accepted move is stored with
its notation and resulting position, and results are finalized on checkmate,
draw, resignation, timeout, or rematch. The Past Games panel lists games played
from the current browser; a random player key in `localStorage` keeps the
account-free archive from becoming a public game list.

Because every move is persisted as it is played, a server restart or new deploy
does not lose games in progress: when a player rejoins a room the server no
longer has in memory, it restores the game (board, clocks, and seats) from
Firestore and play continues.

Click a saved game, a move in the move sheet, or the replay arrows to step
through its positions. You can change the local database location with:

Games started after the permanent-link feature was deployed can also be shared
as replays at `/games/<game-id>`. The UUID link is unlisted but can be
opened by anyone who has it; older saved games remain private to their players.

```bash
DATABASE_PATH=/persistent/path/pawn-patrol.sqlite npm run start
```

Back up the database file together with its `-wal` and `-shm` files, or stop the
server before copying just the main file.

To run against Firestore locally instead, authenticate with
`gcloud auth application-default login` and start with `GAME_STORE=firestore`.

## Deploying (Google Cloud Run)

The app runs as a single container (see `Dockerfile`). Active sockets and clocks
are held in memory, so the service must run as one instance. Game history lives
in the project's Firestore database (`(default)`, us-west1); the runtime service
account needs Firestore access (`roles/datastore.user` or broader), and the
games list query requires the composite index on
`playerKeys (array) + status + finishedAt desc`.

Every push to `main` builds the image and deploys it automatically via GitHub
Actions (`.github/workflows/deploy.yml`); a newer push cancels an in-flight
deploy. Note that Cloud Run rejects fixed-length responses over 32 MB, so the
Maia model is streamed by `server.mjs` with chunked encoding rather than served
as a Next static file.

To deploy manually instead, build the image locally and deploy it
(`gcloud run deploy --source` is blocked in this project — the default build
service account is denied by org policy):

```bash
gcloud auth configure-docker us-west1-docker.pkg.dev
docker buildx build --platform linux/amd64 \
  -t us-west1-docker.pkg.dev/devinfra-remote-dev/cloud-run-source-deploy/sentry-gambit:latest --push .
gcloud run deploy sentry-gambit \
  --image us-west1-docker.pkg.dev/devinfra-remote-dev/cloud-run-source-deploy/sentry-gambit:latest \
  --project devinfra-remote-dev \
  --region us-west1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --timeout 3600 \
  --memory 512Mi
```

`--timeout 3600` keeps WebSocket connections open for up to an hour;
clients reconnect automatically on the same room code.

For production, inject `OPENROUTER_API_KEY` into the Cloud Run service as a
runtime secret, and optionally set `OPENROUTER_MODEL` and `APP_URL` as ordinary
environment variables. Saving a value in GitHub Actions secrets alone does not
make it available to Cloud Run; the deployment workflow must explicitly pass
or bind that secret to the service. The current documented deployment is
manual, so Google Secret Manager plus Cloud Run's `--set-secrets` option is the
recommended path.

If a GitHub Actions deployment is added later, create an Actions secret named
`OPENROUTER_API_KEY` under **Repository settings → Secrets and variables →
Actions**, then have the workflow update the Cloud Run secret binding. Never
put the key in a `NEXT_PUBLIC_` variable, Docker build argument, source file, or
committed environment file.

## Sentry Move Logs

The Node server sends one structured `chess.move.accepted` Sentry log for every
accepted move. The browser analyzes moves with Stockfish in the background and
sends each classification back to the server, which emits a corresponding
`chess.move.graded` log. Grades remain hidden in the UI until the game ends.
Grade reports from multiple browsers are deduplicated by game ID and ply.
Logging is disabled automatically when no DSN is configured.

Set these Cloud Run environment variables:

- `SENTRY_DSN` — the DSN for the Sentry project that should receive move logs
- `SENTRY_ENVIRONMENT` — optional; falls back to `NODE_ENV`

Move logs include the room code, game ID, ply and move numbers, color, SAN and
UCI notation, resulting FEN, remaining clock time, and whether the move ended
the game. Grade logs add the Stockfish grade and expected-points loss. Player
names are not sent. All logs for a game share one `chess.game` trace. When the
game ends, the server captures a `Pawn Patrol game finished` Sentry message on
that trace, creating an issue with the result, move count, and final position
for Seer analysis.
