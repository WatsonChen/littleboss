import { describe, expect, it } from 'vitest';
import type { SubmitResult } from './approval.js';
import type { FakeExternalService } from './fake-external.js';
import { APPROVAL_STEP, WRITE_STEP, type CalendarWriteInput } from './flow.js';
import { proposalHashFor } from './proposal.js';
import type { RunView } from './reference-engine.js';

/**
 * The contract every engine adapter must satisfy (cases F1 to F11 in the M0 plan).
 * To evaluate a real engine, implement `EngineHarness` for it and pass a factory to
 * `runEngineContract`; the same tests then decide whether that engine is acceptable.
 */
export interface EngineHarness {
  external: FakeExternalService;
  startRun(runId: string, input: CalendarWriteInput): Promise<void>;
  submitApproval(
    runId: string,
    decision: 'approved' | 'rejected',
    hashOverride?: string,
  ): Promise<SubmitResult>;
  /** Simulate the process dying and coming back; unfinished runs must resume. */
  restart(): Promise<void>;
  cancel(runId: string): Promise<void>;
  getRun(runId: string): Promise<RunView>;
  /** Change the live role/model settings after runs have already started. */
  setLiveConfig(next: { roleVersion: string; model: string }): void | Promise<void>;
  inject: {
    crashBefore(step: string): void | Promise<void>;
    crashAfter(step: string): void | Promise<void>;
    failAttempts(step: string, times: number): void | Promise<void>;
    /** Cancel the run the moment this step starts (i.e. while it is in flight). */
    cancelWhenStepStarts(step: string): void | Promise<void>;
  };
}

const input: CalendarWriteInput = { title: '買蛋糕', startsAt: '2026-10-16T15:30:00+08:00' };
const hash = proposalHashFor(input);

export function runEngineContract(name: string, makeHarness: () => EngineHarness): void {
  describe(`engine contract: ${name}`, () => {
    it('happy path: waits for approval, writes once, notifies', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      expect((await h.getRun('r1')).state).toBe('waiting_approval');
      expect(h.external.writeCalls).toBe(0);

      await h.submitApproval('r1', 'approved');
      const run = await h.getRun('r1');
      expect(run.state).toBe('succeeded');
      expect(run.completedSteps).toContain('notify');
      expect(h.external.effects).toBe(1);
    });

    it('starting the same run twice does not duplicate it', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved');
      await h.startRun('r1', input);
      expect(h.external.effects).toBe(1);
      expect((await h.getRun('r1')).stepExecutions['prepare']).toBe(1);
    });

    // F1: restart mid-run
    it('F1: resumes after a restart without redoing completed steps', async () => {
      const h = makeHarness();
      await h.inject.crashBefore(WRITE_STEP);
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved');
      expect((await h.getRun('r1')).state).toBe('running');
      expect(h.external.writeCalls).toBe(0);

      await h.restart();
      const run = await h.getRun('r1');
      expect(run.state).toBe('succeeded');
      expect(run.stepExecutions['prepare']).toBe(1);
      expect(run.stepExecutions[WRITE_STEP]).toBe(1);
      expect(h.external.effects).toBe(1);
    });

    // F1 + F8: the effect happened but the result was never recorded
    it('F1/F8: a crash after the external write still yields a single effect', async () => {
      const h = makeHarness();
      await h.inject.crashAfter(WRITE_STEP);
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved');
      expect(h.external.effects).toBe(1);

      await h.restart();
      const run = await h.getRun('r1');
      expect(run.state).toBe('succeeded');
      expect(run.stepExecutions[WRITE_STEP]).toBe(2);
      expect(h.external.effects).toBe(1);
    });

    // F2: restart while waiting for approval
    it('F2: an approval stays valid across restarts while waiting', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      await h.restart();
      await h.restart();
      expect((await h.getRun('r1')).state).toBe('waiting_approval');

      await h.submitApproval('r1', 'approved');
      await h.restart();
      expect((await h.getRun('r1')).state).toBe('succeeded');
      expect(h.external.effects).toBe(1);
    });

    // F3: approval arrives before the run reaches its wait point
    it('F3: an approval that arrives early is not lost', async () => {
      const h = makeHarness();
      await h.inject.crashAfter('prepare');
      await h.startRun('r1', input);
      expect((await h.getRun('r1')).state).toBe('running');

      expect(await h.submitApproval('r1', 'approved')).toBe('accepted');
      await h.restart();
      expect((await h.getRun('r1')).state).toBe('succeeded');
      expect(h.external.effects).toBe(1);
    });

    // F4: duplicate submit
    it('F4: a duplicate approval counts once', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      expect(await h.submitApproval('r1', 'approved')).toBe('accepted');
      expect(await h.submitApproval('r1', 'approved')).toBe('already_processed');
      expect(h.external.effects).toBe(1);
    });

    // F5: approval for different content
    it('F5: an approval for other content is refused and nothing is written', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved', proposalHashFor({ ...input, title: '買火鍋料' }));
      const run = await h.getRun('r1');
      expect(run.state).toBe('needs_reapproval');
      expect(h.external.writeCalls).toBe(0);
    });

    it('a rejection ends the run without writing', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'rejected');
      expect((await h.getRun('r1')).state).toBe('rejected');
      expect(h.external.writeCalls).toBe(0);
    });

    // F6: cancel
    it('F6: cancelling while waiting never writes, and a restart does not revive it', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      await h.cancel('r1');
      expect((await h.getRun('r1')).state).toBe('cancelled');
      await h.submitApproval('r1', 'approved');
      await h.restart();
      expect((await h.getRun('r1')).state).toBe('cancelled');
      expect(h.external.writeCalls).toBe(0);
    });

    it('F6: cancelling during the write keeps the real effect visible and skips later steps', async () => {
      const h = makeHarness();
      await h.inject.cancelWhenStepStarts(WRITE_STEP);
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved');

      const run = await h.getRun('r1');
      expect(run.state).toBe('cancelled');
      expect(run.completedSteps).toContain(WRITE_STEP);
      expect(run.completedSteps).not.toContain('notify');
      expect(h.external.effects).toBe(1);
    });

    // F7: external success but the response is lost
    it('F7: verifies a lost response instead of resending', async () => {
      const h = makeHarness();
      h.external.mode = 'ok_response_lost';
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved');
      const run = await h.getRun('r1');
      expect(run.state).toBe('succeeded');
      expect(run.outcome).toMatchObject({ status: 'succeeded', verified: true });
      expect(h.external.writeCalls).toBe(1);
    });

    it('F7: stops at unknown when nothing can be verified, and never resends after a restart', async () => {
      const h = makeHarness();
      h.external.mode = 'lost_before_processing';
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved');
      expect((await h.getRun('r1')).state).toBe('unknown');

      await h.restart();
      expect((await h.getRun('r1')).state).toBe('unknown');
      expect(h.external.writeCalls).toBe(1);
      expect(h.external.effects).toBe(0);
    });

    // F9: frozen settings
    it('F9: a run keeps the settings it started with', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      await h.setLiveConfig({ roleVersion: 'v2', model: 'other-model' });
      await h.restart();
      await h.submitApproval('r1', 'approved');

      const run = await h.getRun('r1');
      expect(run.config.roleVersion).toBe('v1');
      expect(run.outcome).toMatchObject({ status: 'succeeded', roleVersion: 'v1' });
    });

    // F10: bounded retries
    it('F10: retries a failing step within the limit and still writes once', async () => {
      const h = makeHarness();
      await h.inject.failAttempts(WRITE_STEP, 2); // maxRetries is 2, so the third attempt runs
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved');
      const run = await h.getRun('r1');
      expect(run.state).toBe('succeeded');
      expect(run.stepExecutions[WRITE_STEP]).toBe(3);
      expect(h.external.effects).toBe(1);
    });

    it('F10: stops after the retry limit and reports failure', async () => {
      const h = makeHarness();
      await h.inject.failAttempts(WRITE_STEP, 10);
      await h.startRun('r1', input);
      await h.submitApproval('r1', 'approved');
      const run = await h.getRun('r1');
      expect(run.state).toBe('failed');
      expect(run.stepExecutions[WRITE_STEP]).toBe(3);
      expect(h.external.effects).toBe(0);
      await h.restart();
      expect((await h.getRun('r1')).state).toBe('failed');
    });

    // F11: long wait (simulated by many restarts)
    it('F11: a long wait costs nothing: no step re-runs across many restarts', async () => {
      const h = makeHarness();
      await h.startRun('r1', input);
      for (let i = 0; i < 100; i += 1) await h.restart();

      const waiting = await h.getRun('r1');
      expect(waiting.state).toBe('waiting_approval');
      expect(waiting.stepExecutions['prepare']).toBe(1);

      await h.submitApproval('r1', 'approved');
      expect((await h.getRun('r1')).state).toBe('succeeded');
      expect(h.external.effects).toBe(1);
    });

    it('keeps two runs independent', async () => {
      const h = makeHarness();
      await h.startRun('a', input);
      await h.startRun('b', { ...input, title: '買火鍋料' });
      await h.submitApproval('a', 'approved');
      expect((await h.getRun('a')).state).toBe('succeeded');
      expect((await h.getRun('b')).state).toBe('waiting_approval');
      expect(h.external.effects).toBe(1);
    });
  });
}

// Re-exported so adapter authors can build approvals with the same constants.
export { APPROVAL_STEP, hash as exampleProposalHash };
