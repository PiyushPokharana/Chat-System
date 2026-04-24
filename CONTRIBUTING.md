# Contributing

Thanks for contributing to PulseChat.

## Local setup

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
4. Start the app:
   ```bash
   npm run dev
   ```

## Development checklist

- Keep changes focused and small.
- Update docs when behavior changes.
- Preserve backward compatibility for socket payloads when possible.
- Add or update smoke tests for behavior changes.

## Validation before PR

Run core smoke tests:

```bash
npm run phase1:smoke
npm run phase2:smoke
npm run phase3:smoke
```

If Redis is available locally, also run:

```bash
npm run phase4:smoke
```

For presence, typing, and delivery features:

```bash
npm run phase5:smoke
npm run phase6:smoke
npm run phase7:smoke
```
