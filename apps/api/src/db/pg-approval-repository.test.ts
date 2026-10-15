import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../core/approval.js';
import { migrate } from './migrate.js';
import { createPool, type Pool } from './pool.js';
import { PgApprovalRepository } from './pg-approval-repository.js';

// Runs only when a test database is provided, e.g.
//   TEST_DATABASE_URL=postgres://littleboss:littleboss_dev@127.0.0.1:5432/littleboss_test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PgApprovalRepository (real Postgres)', () => {
  let pool: Pool;
  let service: ApprovalService;

  beforeAll(async () => {
    pool = createPool(url!, 20);
    await migrate(pool);
    service = new ApprovalService(new PgApprovalRepository(pool));
  });
  beforeEach(async () => {
    await pool.query('truncate approvals');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('stores a decision once and reads it back', async () => {
    const r = await service.submit({
      runId: 'r1',
      stepId: 's',
      proposalHash: 'h',
      decision: 'approved',
    });
    expect(r).toBe('accepted');
    expect(await service.resolve({ runId: 'r1', stepId: 's', currentProposalHash: 'h' })).toEqual({
      status: 'approved',
    });
  });

  it('20 simultaneous submits for the same key: exactly one is accepted', async () => {
    // Open all connections first; otherwise the first request can finish before the others
    // connect and the race this test is meant to expose never happens.
    await Promise.all(Array.from({ length: 20 }, () => pool.query('select pg_sleep(0.05)')));
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.submit({ runId: 'r1', stepId: 's', proposalHash: 'h', decision: 'approved' }),
      ),
    );
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_processed')).toHaveLength(19);
    const { rows } = await pool.query('select count(*)::int as n from approvals');
    expect(rows[0].n).toBe(1);
  });

  it('a conflicting second decision never overwrites the first', async () => {
    await service.submit({ runId: 'r1', stepId: 's', proposalHash: 'h', decision: 'approved' });
    const second = await service.submit({
      runId: 'r1',
      stepId: 's',
      proposalHash: 'h',
      decision: 'rejected',
    });
    expect(second).toBe('already_processed');
    expect(await service.resolve({ runId: 'r1', stepId: 's', currentProposalHash: 'h' })).toEqual({
      status: 'approved',
    });
  });

  it('reports stale when the decision was made for different content', async () => {
    await service.submit({ runId: 'r1', stepId: 's', proposalHash: 'old', decision: 'approved' });
    expect(await service.resolve({ runId: 'r1', stepId: 's', currentProposalHash: 'new' })).toEqual(
      {
        status: 'stale',
      },
    );
  });

  it('migrate is idempotent', async () => {
    expect(await migrate(pool)).toEqual([]);
  });
});
