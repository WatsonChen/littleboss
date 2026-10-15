import { afterAll, beforeAll } from 'vitest';
import { runEngineContract } from '../../../apps/api/src/core/engine-contract';
import { InngestHarnessFactory } from './harness';

const factory = new InngestHarnessFactory();
beforeAll(() => factory.setup(), 120_000);
afterAll(() => factory.teardown());

runEngineContract('Inngest (dev server, Fastify app)', () => factory.make());
