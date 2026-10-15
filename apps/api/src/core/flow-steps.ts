import { executeExternalAction, type ExternalActionResult } from './external-action.js';
import type { CalendarWriteInput, StepDef } from './flow.js';
import { NOTIFY_STEP, PREPARE_STEP, WRITE_STEP } from './flow.js';
import { proposalHashFor } from './proposal.js';

/**
 * Step implementations. These may use Node built-ins and external clients, so they must never be
 * imported by flow code: workflow sandboxes (Vercel Workflows) forbid Node modules in flow code.
 * Engines get them through a registry keyed by step name.
 */
export const prepareStep: StepDef<
  { input: CalendarWriteInput; roleVersion: string },
  { hash: string; roleVersion: string }
> = {
  name: PREPARE_STEP,
  run: async ({ input, roleVersion }) => ({ hash: proposalHashFor(input), roleVersion }),
};

export const writeCalendarStep: StepDef<
  { idempotencyKey: string; payload: CalendarWriteInput },
  ExternalActionResult
> = {
  name: WRITE_STEP,
  run: (input, env) => executeExternalAction(env.external, input),
};

export const notifyStep: StepDef<{ runId: string }, boolean> = {
  name: NOTIFY_STEP,
  run: async () => true,
};

export const calendarSteps = [prepareStep, writeCalendarStep, notifyStep] as const;
