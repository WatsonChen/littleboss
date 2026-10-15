import type { ApprovalRepository, Decision } from '../core/approval.js';
import type { Pool } from './pool.js';

export class PgApprovalRepository implements ApprovalRepository {
  constructor(private readonly pool: Pool) {}

  async insertIfAbsent(row: { key: string; proposalHash: string; decision: Decision }) {
    const res = await this.pool.query(
      `insert into approvals (key, proposal_hash, decision)
       values ($1, $2, $3)
       on conflict (key) do nothing`,
      [row.key, row.proposalHash, row.decision],
    );
    return res.rowCount === 1;
  }

  async get(key: string) {
    const res = await this.pool.query<{ proposal_hash: string; decision: Decision }>(
      'select proposal_hash, decision from approvals where key = $1',
      [key],
    );
    const row = res.rows[0];
    return row ? { proposalHash: row.proposal_hash, decision: row.decision } : null;
  }
}
