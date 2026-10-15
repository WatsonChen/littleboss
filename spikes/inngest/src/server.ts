import Fastify from 'fastify';
import { serve } from 'inngest/fastify';
import { EVENTS, inngest } from './client';
import { calendarFn, reconcileFn } from './functions';
import { inngestRestClient, reconcileRuns } from './reconcile';
import { faults, view } from './runtime';

const app = Fastify();

app.get('/health', async () => ({ ok: true, pid: process.pid }));

app.route({
  method: ['GET', 'POST', 'PUT'],
  url: '/api/inngest',
  handler: serve({ client: inngest, functions: [calendarFn, reconcileFn] }),
});

app.post('/api/start', async (req) => {
  const { runId, input, config } = req.body as { runId: string; input: never; config: never };
  await view.create(runId, config);
  // The event id makes the send idempotent: starting the same run twice yields one run.
  const { ids } = await inngest.send({
    id: `start:${runId}`,
    name: EVENTS.start,
    data: { runId, input, config },
  });
  // Inngest's own id for the event is what its REST API needs later, to ask how the run went.
  if (ids[0]) await view.attachEngineEvent(runId, ids[0]);
  return { runId };
});

/** Wake a run that may be waiting. The decision itself is already in the database. */
app.post('/api/wake', async (req) => {
  const { runId } = req.body as { runId: string };
  await inngest.send({ name: EVENTS.wake, data: { runId } });
  return { woke: true };
});

app.post('/api/cancel', async (req) => {
  const { runId } = req.body as { runId: string };
  await view.markCancelled(runId);
  await inngest.send({ name: EVENTS.cancel, data: { runId } });
  return { cancelled: true };
});

/** Runs one reconcile pass now. `olderThanMs` lets a test skip the 5 minute grace period. */
app.post('/api/reconcile', async (req) => {
  const { olderThanMs } = (req.body ?? {}) as { olderThanMs?: number };
  return reconcileRuns(inngestRestClient(), { olderThanMs: olderThanMs ?? 5 * 60_000 });
});

app.post('/api/inject', async (req) => {
  const { kind, step, times } = req.body as { kind: string; step: string; times?: number };
  if (kind === 'crashBefore') faults.crashBefore.add(step);
  else if (kind === 'crashAfter') faults.crashAfter.add(step);
  else if (kind === 'failAttempts') faults.failAttempts.set(step, times ?? 1);
  else if (kind === 'failFinish') faults.failFinish = times ?? 1;
  else if (kind === 'cancelWhenStepStarts') faults.cancelWhenStepStarts.add(step);
  else throw new Error(`unknown fault ${kind}`);
  return { ok: true };
});

await app.listen({ port: Number(process.env.PORT ?? 3427), host: '127.0.0.1' });
