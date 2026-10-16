import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateRunRequest,
  SubmitApprovalRequest,
  SubmitInputRequest,
} from '@littleboss/shared';
import { HttpError } from '../discussion/errors.js';
import type { RunService } from './service.js';

const Id = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, 'invalid_request', 'The request is not valid.', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

function id(params: unknown): string {
  const r = Id.safeParse((params as { id?: string }).id);
  if (!r.success) throw new HttpError(404, 'not_found', 'No such item.');
  return r.data;
}

/** Registered inside the discussion routes' scope, so auth and error handling are shared. */
export function registerRunRoutes(api: FastifyInstance, getService: () => RunService) {
  api.post('/api/threads/:id/runs', async (req, reply) => {
    const res = await getService().create(id(req.params), parse(CreateRunRequest, req.body));
    return reply.status(res.deduplicated ? 200 : 201).send(res);
  });
  api.get('/api/threads/:id/runs', async (req) => ({
    runs: await getService().listForThread(id(req.params)),
  }));
  api.get('/api/runs/waiting', async () => ({ runs: await getService().listWaiting() }));
  api.get('/api/runs/:id', async (req) => ({ run: await getService().get(id(req.params)) }));
  api.post('/api/runs/:id/input', async (req) =>
    getService().submitInput(id(req.params), parse(SubmitInputRequest, req.body)),
  );
  api.post('/api/runs/:id/approval', async (req) =>
    getService().submitApproval(id(req.params), parse(SubmitApprovalRequest, req.body)),
  );
  api.post('/api/runs/:id/cancel', async (req) => ({ run: await getService().cancel(id(req.params)) }));
}
