# Spike: Vercel Workflows against the engine contract

Not part of the pnpm workspace and not deployed. It exists to run the engine-neutral contract
(`apps/api/src/core/engine-contract.ts`, cases F1 to F11) against the real Vercel Workflow SDK
(`workflow` 5.2.2 with `@workflow/world-postgres` 5.0.4, built with Nitro).

How it is wired:

- `workflows/calendar.ts`: the workflow. It adapts `FlowContext` to the SDK (steps, hook-based wake-up).
- `workflows/steps.ts`: one generic `'use step'` function that runs any registered `StepDef`, plus fault injection.
- `src/index.ts`: Fastify routes (start, wake, cancel, inject), served by Nitro.
- `test/harness.ts`: implements `EngineHarness`. Starts and kills the built server, hosts the fake external
  service over HTTP (so it survives restarts), reads run state from Postgres.

Run it (needs a local Postgres; see `.env.example` at the repo root):

```sh
cd spikes/vercel-workflow
npm install
WORKFLOW_POSTGRES_URL=postgres://littleboss:littleboss_dev@127.0.0.1:5432/littleboss_test \
  npx --package=@workflow/world-postgres bootstrap   # creates the engine's tables once
npx nitro build
npx vitest run          # about 4 minutes; F11 restarts the server 100 times
```

`SPIKE_WORLD=local` uses the SDK's in-memory-queue local world instead; it does not recover a step
that was running when the process died (see docs/m0-engine-evaluation.md).
