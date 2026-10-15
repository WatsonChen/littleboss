import { describe, expect, it } from 'vitest';
import { executeExternalAction } from './external-action.js';
import { FakeExternalService } from './fake-external.js';

const input = { idempotencyKey: 'run1:step3', payload: { title: '買蛋糕' } };

describe('executeExternalAction', () => {
  it('succeeds on the happy path', async () => {
    const svc = new FakeExternalService();
    const res = await executeExternalAction(svc, input);
    expect(res).toMatchObject({ status: 'succeeded', verified: false });
    expect(svc.effects).toBe(1);
  });

  it('reports a definite rejection as failed, with no effect', async () => {
    const svc = new FakeExternalService();
    svc.mode = 'reject';
    const res = await executeExternalAction(svc, input);
    expect(res.status).toBe('failed');
    expect(svc.effects).toBe(0);
  });

  // F7: external succeeded but the response was lost -> verify first, do not resend.
  it('verifies instead of resending when the response is lost after success', async () => {
    const svc = new FakeExternalService();
    svc.mode = 'ok_response_lost';
    const res = await executeExternalAction(svc, input);
    expect(res).toMatchObject({ status: 'succeeded', verified: true });
    expect(svc.writeCalls).toBe(1);
    expect(svc.effects).toBe(1);
  });

  // F7: nothing found on verification -> stop at unknown, never resend automatically.
  it('stops at unknown when verification finds nothing', async () => {
    const svc = new FakeExternalService();
    svc.mode = 'lost_before_processing';
    const res = await executeExternalAction(svc, input);
    expect(res.status).toBe('unknown');
    expect(svc.writeCalls).toBe(1);
    expect(svc.effects).toBe(0);
  });

  it('stops at unknown when the verification lookup itself fails', async () => {
    const svc = new FakeExternalService();
    svc.mode = 'ok_response_lost';
    svc.lookup = async () => {
      throw new Error('lookup down');
    };
    const res = await executeExternalAction(svc, input);
    expect(res.status).toBe('unknown');
  });

  // F8: an engine retry after a crash re-runs the step with the same key -> one effect only.
  it('produces a single effect when the same step is executed twice', async () => {
    const svc = new FakeExternalService();
    const a = await executeExternalAction(svc, input);
    const b = await executeExternalAction(svc, input);
    expect(svc.effects).toBe(1);
    expect(a).toMatchObject({ status: 'succeeded' });
    expect(b).toMatchObject({ status: 'succeeded' });
    if (a.status === 'succeeded' && b.status === 'succeeded') {
      expect(b.externalId).toBe(a.externalId);
    }
  });

  it('rethrows unexpected errors instead of hiding them', async () => {
    const svc = new FakeExternalService();
    svc.write = async () => {
      throw new TypeError('bug');
    };
    await expect(executeExternalAction(svc, input)).rejects.toThrow('bug');
  });
});
