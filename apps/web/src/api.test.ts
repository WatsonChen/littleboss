import { describe, expect, it } from 'vitest';
import { fetchHealth } from './api';

describe('fetchHealth', () => {
  it('parses a valid response', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({ ok: true, service: 'littleboss-api', time: '2026-10-15T00:00:00Z' }),
      )) as typeof fetch;
    await expect(fetchHealth(fake)).resolves.toMatchObject({ ok: true });
  });

  it('throws on a non-200 response', async () => {
    const fake = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    await expect(fetchHealth(fake)).rejects.toThrow('500');
  });

  it('throws when the body does not match the shared contract', async () => {
    const fake = (async () => new Response(JSON.stringify({ ok: false }))) as typeof fetch;
    await expect(fetchHealth(fake)).rejects.toThrow();
  });
});
