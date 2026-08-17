# Castle & Clock

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

```bash
gcloud run deploy castle-and-clock \
  --source . \
  --project devinfra-remote-dev \
  --region us-west1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --timeout 3600 \
  --memory 512Mi
```

`--timeout 3600` keeps WebSocket connections open for up to an hour;
clients reconnect automatically on the same room code.
