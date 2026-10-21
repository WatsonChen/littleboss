import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ChooseFlowDraftRequest,
  CreateFlowRequest,
  SaveFlowInputsRequest,
  SetFlowScheduleRequest,
  SetFlowStepDoneRequest,
} from '@littleboss/shared';
import { HttpError } from '../discussion/errors.js';
import type { FlowService } from './service.js';

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

function uuid(value: unknown): string {
  const r = Id.safeParse(value);
  if (!r.success) throw new HttpError(404, 'not_found', 'No such flow.');
  return r.data;
}

/** Registered inside the discussion routes' scope, so auth and error handling are shared. */
export function registerFlowRoutes(api: FastifyInstance, getService: () => FlowService) {
  type P = { id?: string; key?: string };
  api.post('/api/flows', async (req, reply) => {
    const res = await getService().create(parse(CreateFlowRequest, req.body));
    return reply.status(res.deduplicated ? 200 : 201).send(res);
  });
  api.get('/api/flows', async () => ({ flows: await getService().list() }));
  api.get('/api/flows/:id', async (req) => ({
    flow: await getService().get(uuid((req.params as P).id)),
  }));
  api.patch('/api/flows/:id', async (req) => ({
    flow: await getService().saveInputs(
      uuid((req.params as P).id),
      parse(SaveFlowInputsRequest, req.body),
    ),
  }));
  api.post('/api/flows/:id/generate', async (req) => ({
    flow: await getService().generate(uuid((req.params as P).id)),
  }));
  api.post('/api/flows/:id/choose', async (req) => ({
    flow: await getService().choose(
      uuid((req.params as P).id),
      parse(ChooseFlowDraftRequest, req.body),
    ),
  }));
  api.post('/api/flows/:id/schedule', async (req) => ({
    flow: await getService().setSchedule(
      uuid((req.params as P).id),
      parse(SetFlowScheduleRequest, req.body).publishAt,
    ),
  }));
  api.post('/api/flows/:id/steps/:key/done', async (req) => {
    const p = req.params as P;
    return {
      flow: await getService().setStepDone(
        uuid(p.id),
        String(p.key ?? ''),
        parse(SetFlowStepDoneRequest, req.body).done,
      ),
    };
  });
}
