# Spike: Inngest adapter

Runs the engine contract (`apps/api/src/core/engine-contract.ts`, cases F1 to F11) against Inngest.
Throwaway code; the findings are in `docs/m0-engine-evaluation.md`.

## What it is

- `src/functions.ts`: the Inngest function. It runs the engine-neutral `calendarWriteFlow` through
  `step.run` (named steps) and waits for approval with a bounded `step.waitForEvent` loop that
  re-checks our own database after every wake-up or timeout.
- `src/server.ts`: a Fastify app that serves the function (`/api/inngest`) and exposes start, wake,
  cancel and fault-injection routes for the tests.
- `test/harness.ts`: starts the Inngest dev server (`inngest-cli dev`, a separate process that
  stands in for the hosted service) and the app, and kills only the app to simulate a crash.

## Run

Needs a local Postgres (`TEST_DATABASE_URL`, default `postgres://littleboss:littleboss_dev@127.0.0.1:5432/littleboss_test`).

```
npm install
npx vitest run          # about 3 minutes; F11 alone restarts the app 100 times
```

`SPIKE_LOG=1` prints the app and dev-server logs. `SPIKE_WAIT_TIMEOUT` sets the length of one
approval wait (default `1h`).
