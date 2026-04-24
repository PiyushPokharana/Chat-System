# Phase 9 Deployment Guide

This guide gets PulseChat to a cloud-hosted, testable state.

## Option A: Render Blueprint (fastest)

1. Push repository to GitHub.
2. In Render: `New` -> `Blueprint`.
3. Select this repository.
4. Render reads [render.yaml](/c:/Users/piyus/New Volumne (P)/Work/Project_Desc/Chat-System/render.yaml) and creates:
- `pulsechat-web` (Node web app)
- `pulsechat-postgres` (managed PostgreSQL)
- `pulsechat-redis` (managed Redis)
5. Set `SOCKET_CORS` to your deployed web URL (for example `https://pulsechat-web.onrender.com`).
6. Deploy and wait for `/health` to return 200.

## Option B: Railway + Upstash + Neon

1. Deploy app service on Railway.
2. Provision Postgres on Railway or Neon.
3. Provision Redis on Railway or Upstash.
4. Add the same environment variables as below.

## Required Environment Variables

Use production-safe values (never commit secrets):

- `NODE_ENV=production`
- `PORT=10000` (or provider default)
- `SOCKET_CORS=https://<your-domain>`
- `INSTANCE_ID=<unique-instance-id>` (optional but recommended)
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_PASSWORD`

## Post-deploy Validation

Run from local machine:

```bash
npm run phase9:verify -- --baseUrl https://<your-deployed-url>
```

Optional: strict check for redis sync:

```bash
npm run phase9:verify -- --baseUrl https://<your-deployed-url> --requireRedisSync
```

## Security Notes

- Keep `.env` out of git (already ignored).
- Use provider secret manager only.
- Rotate credentials if leaked.
- Restrict DB and Redis network access to app environment where possible.

## Operational Checklist

- Health endpoint returns `200`: `/health`
- Runtime mode shows production in `/api/status`
- `messageStore.storageMode` should be `postgres`
- `socketSync.enabled` should be `true` when Redis is healthy
- Smoke verification script passes
