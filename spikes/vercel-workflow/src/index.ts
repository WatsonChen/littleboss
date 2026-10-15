import Fastify from 'fastify';
import { getRun, resumeHook, start } from 'workflow/api';
import { calendarWorkflow } from '../workflows/calendar';
import { APPROVAL_STEP } from '../../../apps/api/src/core/flow';
import { db, faults, view } from './runtime';

const app = Fastify();

app.get('/health', async () => ({ ok: true, pid: process.pid }));

app.post('/api/start', async (req) => {
  const { runId, input, config } = req.body as { runId: string; input: never; config: never };
  const { workflowRunId } = await view.create(runId, config);
  if (workflowRunId) return { runId, workflowRunId, alreadyStarted: true };
  const run = await start(calendarWorkflow, [runId, input, config]);
  await view.attachWorkflowRun(runId, run.runId);
  return { runId, workflowRunId: run.runId };
});

/** Wake a run that may be waiting. The decision itself is already in the database. */
app.post('/api/wake', async (req) => {
  const { runId } = req.body as { runId: string };
  try {
    await resumeHook(`approval:${runId}:${APPROVAL_STEP}`, { wake: true });
    return { woke: true };
  } catch (err) {
    return { woke: false, reason: err instanceof Error ? err.name : String(err) };
  }
});

app.post('/api/cancel', async (req) => {
  const { runId } = req.body as { runId: string };
  const { rows } = await db().query('select workflow_run_id from spike_run_view where run_id=$1', [
    runId,
  ]);
  const workflowRunId = rows[0]?.workflow_run_id as string | undefined;
  await view.markCancelled(runId);
  if (workflowRunId) await getRun(workflowRunId).cancel();
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

await app.ready();
export default (req: unknown, res: unknown) => {
  app.server.emit('request', req, res);
};
