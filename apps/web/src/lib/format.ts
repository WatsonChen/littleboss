import type { MessageView } from '@littleboss/shared';

/** Micro-USD as a short dollar amount. Small amounts keep more digits so they never show as 0. */
export function formatUsd(micro: number): string {
  if (micro === 0) return 'US$0';
  const usd = micro / 1_000_000;
  return `US$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
}

/** What a message has cost so far, worded so an estimate never looks like a bill. */
export function messageCostLabel(
  m: Pick<MessageView, 'costMicro' | 'estimatedCostMicro' | 'costIsEstimate'>,
) {
  if (m.costMicro !== null && !m.costIsEstimate) return formatUsd(m.costMicro);
  const v = m.costMicro ?? m.estimatedCostMicro;
  return v === null ? null : `約 ${formatUsd(v)}（估算）`;
}

const STALE_QUEUED_MS = 60_000;
const STALE_RUNNING_MS = 5 * 60_000;

/** A call that has been waiting or running for so long that the person should be offered a retry. */
export function isStuck(
  m: Pick<MessageView, 'status' | 'queuedAt' | 'startedAt'>,
  now: number,
): boolean {
  if (m.status === 'queued' && m.queuedAt) return now - Date.parse(m.queuedAt) > STALE_QUEUED_MS;
  if (m.status === 'running' && m.startedAt)
    return now - Date.parse(m.startedAt) > STALE_RUNNING_MS;
  return false;
}

export const isActive = (m: Pick<MessageView, 'status'>) =>
  m.status === 'queued' || m.status === 'running';

/** Text for a status the person can read at a glance. */
export function statusLabel(m: Pick<MessageView, 'status'>): string {
  switch (m.status) {
    case 'queued':
      return '排隊中';
    case 'running':
      return '思考中';
    case 'failed':
      return '失敗';
    case 'timed_out':
      return '逾時';
    case 'bad_format':
      return '回覆不完整';
    default:
      return '';
  }
}
