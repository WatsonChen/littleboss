import Fastify from 'fastify';
import { serve } from 'inngest/fastify';
import { EVENTS, inngest } from './client';
import { calendarFn } from './functions';
import { faults, view } from './runtime';

const app = Fastify();

app.get('/health', async () => ({ ok: true, pid: process.pid }));

app.route({
  method: ['GET', 'POST', 'PUT'],
  url: '/api/inngest',
  handler: serve({ client: inngest, functions: [calendarFn] }),
});

app.post('/api/start', async (req) => {
  const { runId, input, config } = req.body as { runId: string; input: never; config: never };
  await view.create(runId, config);
  // The event id makes the send idempotent: starting the same run twice yields one run.
  await inngest.send({ id: `start:${runId}`, name: EVENTS.start, data: { runId, input, config } });
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

app.post('/api/inject', async (req) => {
  const { kind, step, times } = req.body as { kind: string; step: string; times?: number };
  if (kind === 'crashBefore') faults.crashBefore.add(step);
  else if (kind === 'crashAfter') faults.crashAfter.add(step);
  else if (kind === 'failAttempts') faults.failAttempts.set(step, times ?? 1);
  else if (kind === 'cancelWhenStepStarts') faults.cancelWhenStepStarts.add(step);
  else throw new Error(`unknown fault ${kind}`);
  return { ok: true };
});

await app.listen({ port: Number(process.env.PORT ?? 3427), host: '127.0.0.1' });
