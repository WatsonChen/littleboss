import { describe, expect, it } from 'vitest';
import { ApprovalService, InMemoryApprovalRepository } from './approval.js';

const base = { runId: 'run1', stepId: 'approve-calendar' };

function setup() {
  return new ApprovalService(new InMemoryApprovalRepository());
}

describe('ApprovalService', () => {
  it('is pending until a decision exists', async () => {
    const svc = setup();
    expect(await svc.resolve({ ...base, currentProposalHash: 'h1' })).toEqual({
      status: 'pending',
    });
  });

  // F3: the approval arrives before the run reaches its wait point.
  it('does not lose an approval that arrives before the run asks for it', async () => {
    const svc = setup();
    expect(await svc.submit({ ...base, proposalHash: 'h1', decision: 'approved' })).toBe(
      'accepted',
    );
    expect(await svc.resolve({ ...base, currentProposalHash: 'h1' })).toEqual({
      status: 'approved',
    });
  });

  // F4: duplicate / double-tap submit counts once; the first decision wins.
  it('counts a repeated submit once and keeps the first decision', async () => {
    const svc = setup();
    expect(await svc.submit({ ...base, proposalHash: 'h1', decision: 'approved' })).toBe(
      'accepted',
    );
    expect(await svc.submit({ ...base, proposalHash: 'h1', decision: 'approved' })).toBe(
      'already_processed',
    );
    expect(await svc.submit({ ...base, proposalHash: 'h1', decision: 'rejected' })).toBe(
      'already_processed',
    );
    expect(await svc.resolve({ ...base, currentProposalHash: 'h1' })).toEqual({
      status: 'approved',
    });
  });

  // F5: content/destination/action changed after the person approved.
  it('refuses an approval made for different content', async () => {
    const svc = setup();
    await svc.submit({ ...base, proposalHash: 'old', decision: 'approved' });
    expect(await svc.resolve({ ...base, currentProposalHash: 'new' })).toEqual({ status: 'stale' });
  });

  it('keeps decisions of different steps separate', async () => {
    const svc = setup();
    await svc.submit({ ...base, proposalHash: 'h1', decision: 'approved' });
    expect(
      await svc.resolve({ runId: 'run1', stepId: 'approve-list', currentProposalHash: 'h1' }),
    ).toEqual({ status: 'pending' });
  });

  it('returns rejected decisions', async () => {
    const svc = setup();
    await svc.submit({ ...base, proposalHash: 'h1', decision: 'rejected' });
    expect(await svc.resolve({ ...base, currentProposalHash: 'h1' })).toEqual({
      status: 'rejected',
    });
  });
});
