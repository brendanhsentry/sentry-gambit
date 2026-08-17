# Sentry Gambit

Live chess with private tables and shared clocks. Next.js frontend plus a Node
WebSocket server (`server.mjs`) that keeps each game's board, clocks, and
connected players in memory.

## Prerequisites

- Node.js `>=22.13.0`

## Local development

```bash
npm install
npm run dev      # dev server with hot reload
npm run build    # production build
npm run start    # production server
```

## Deploying (Google Cloud Run)

The app runs as a single container (see `Dockerfile`). Game state is held in
memory, so the service must run as one instance — a lost instance means live
games reset, which is acceptable for casual play.

Build the image locally and deploy it (`gcloud run deploy --source` is blocked
in this project — the default build service account is denied by org policy):

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

## Sentry Move Logs

The Node server sends one structured `chess.move.accepted` Sentry log for every
accepted move. Logging is disabled automatically when no DSN is configured.

Set these Cloud Run environment variables:

- `SENTRY_DSN` — the DSN for the Sentry project that should receive move logs
- `SENTRY_ENVIRONMENT` — optional; falls back to `NODE_ENV`

Move logs include the room code, ply and move numbers, color, SAN and UCI
notation, resulting FEN, remaining clock time, and whether the move ended the
game. Player names are not sent.
