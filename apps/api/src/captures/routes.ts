import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApproveCaptureItemRequest,
  CreateCaptureRequest,
  EditCaptureItemRequest,
  SetShoppingDoneRequest,
} from '@littleboss/shared';
import { HttpError } from '../discussion/errors.js';
import type { CaptureService } from './service.js';

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
  if (!r.success) throw new HttpError(404, 'not_found', 'No such item.');
  return r.data;
}

/** Registered inside the discussion routes' scope, so auth and error handling are shared. */
export function registerCaptureRoutes(api: FastifyInstance, getService: () => CaptureService) {
  type P = { id?: string; itemId?: string };
  api.post('/api/captures', async (req, reply) => {
    const res = await getService().create(parse(CreateCaptureRequest, req.body));
    return reply.status(res.deduplicated ? 200 : 201).send(res);
  });
  api.get('/api/captures', async () => ({ captures: await getService().list() }));
  api.get('/api/captures/:id', async (req) => ({
    capture: await getService().get(uuid((req.params as P).id)),
  }));
  api.post('/api/captures/:id/retry', async (req) => ({
    capture: await getService().retry(uuid((req.params as P).id)),
  }));
  api.patch('/api/captures/:id/items/:itemId', async (req) => {
    const p = req.params as P;
    return {
      capture: await getService().editItem(
        uuid(p.id),
        uuid(p.itemId),
        parse(EditCaptureItemRequest, req.body),
      ),
    };
  });
  api.post('/api/captures/:id/items/:itemId/approve', async (req) => {
    const p = req.params as P;
    return getService().approveItem(
      uuid(p.id),
      uuid(p.itemId),
      parse(ApproveCaptureItemRequest, req.body),
    );
  });
  api.post('/api/captures/:id/items/:itemId/reject', async (req) => {
    const p = req.params as P;
    return getService().rejectItem(uuid(p.id), uuid(p.itemId));
  });
  api.get('/api/shopping', async () => ({ items: await getService().listShopping() }));
  api.patch('/api/shopping/:id', async (req) => {
    const body = parse(SetShoppingDoneRequest, req.body);
    return { item: await getService().setShoppingDone(uuid((req.params as P).id), body.done) };
  });
}
