export type Decision = 'approved' | 'rejected';

export interface ApprovalRepository {
  /** Atomically store a decision unless one already exists for the key. Returns true if stored. */
  insertIfAbsent(row: { key: string; proposalHash: string; decision: Decision }): Promise<boolean>;
  get(key: string): Promise<{ proposalHash: string; decision: Decision } | null>;
}

export type SubmitResult = 'accepted' | 'already_processed';

export type ResolveResult =
  | { status: 'pending' }
  | { status: 'approved' }
  | { status: 'rejected' }
  /** A decision exists, but it was made for different content/destination/action. */
  | { status: 'stale' };

/**
 * Approvals live in our own database, not in the workflow engine's event system, so a decision
 * that arrives before the run reaches its wait point is never lost, and a double submit only
 * counts once. `proposalHash` binds the decision to exactly what the person saw
 * (content + destination + action).
 */
export class ApprovalService {
  constructor(private readonly repo: ApprovalRepository) {}

  static keyFor(runId: string, stepId: string): string {
    return `${runId}:${stepId}`;
  }

  async submit(input: {
    runId: string;
    stepId: string;
    proposalHash: string;
    decision: Decision;
  }): Promise<SubmitResult> {
    const stored = await this.repo.insertIfAbsent({
      key: ApprovalService.keyFor(input.runId, input.stepId),
      proposalHash: input.proposalHash,
      decision: input.decision,
    });
    return stored ? 'accepted' : 'already_processed';
  }

  /** Called by the run when it reaches the approval step with the hash of what it will do. */
  async resolve(input: {
    runId: string;
    stepId: string;
    currentProposalHash: string;
  }): Promise<ResolveResult> {
    const row = await this.repo.get(ApprovalService.keyFor(input.runId, input.stepId));
    if (!row) return { status: 'pending' };
    if (row.proposalHash !== input.currentProposalHash) return { status: 'stale' };
    return { status: row.decision };
  }
}

/** In-memory repository for tests. The real one will be backed by the chosen database. */
export class InMemoryApprovalRepository implements ApprovalRepository {
  private rows = new Map<string, { proposalHash: string; decision: Decision }>();

  async insertIfAbsent(row: { key: string; proposalHash: string; decision: Decision }) {
    if (this.rows.has(row.key)) return false;
    this.rows.set(row.key, { proposalHash: row.proposalHash, decision: row.decision });
    return true;
  }

  async get(key: string) {
    return this.rows.get(key) ?? null;
  }
}
