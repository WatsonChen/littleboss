import { afterAll, beforeAll } from 'vitest';
import { runEngineContract } from '../../../apps/api/src/core/engine-contract';
import { VercelWorkflowHarnessFactory } from './harness';

const factory = new VercelWorkflowHarnessFactory();
beforeAll(() => factory.setup(), 60_000);
afterAll(() => factory.teardown());

runEngineContract('Vercel Workflows (Postgres world, built Nitro server)', () => factory.make());
