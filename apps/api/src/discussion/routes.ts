import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateThreadRequest,
  EditMessageRequest,
  EstimateRequest,
  SaveConclusionRequest,
  SendMessageRequest,
} from '@littleboss/shared';
import { createAuthHook } from './auth.js';
import { HttpError } from './errors.js';
import type { DiscussionService } from './service.js';

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
  const p = params as { id?: string };
  const r = Id.safeParse(p.id);
  if (!r.success) throw new HttpError(404, 'not_found', 'No such item.');
  return r.data;
}

export function registerDiscussionRoutes(
  app: FastifyInstance,
  getService: () => DiscussionService,
  env: Record<string, string | undefined>,
) {
  void app.register(async (api) => {
    api.setErrorHandler((err, _req, reply) => {
      if (err instanceof HttpError) {
        return reply
          .status(err.status)
          .send({ error: { code: err.code, message: err.message, ...err.extra } });
      }
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode && e.statusCode < 500) {
        return reply
          .status(e.statusCode)
          .send({ error: { code: 'invalid_request', message: e.message ?? 'Bad request.' } });
      }
      api.log.error(err);
      return reply
        .status(500)
        .send({ error: { code: 'internal_error', message: 'Something went wrong.' } });
    });
    api.addHook('onRequest', createAuthHook(env));

    api.get('/api/agents', async () => ({ agents: getService().agents() }));

    api.get('/api/threads', async () => ({ threads: await getService().listThreads() }));
    api.post('/api/threads', async (req, reply) => {
      const thread = await getService().createThread(parse(CreateThreadRequest, req.body ?? {}));
      return reply.status(201).send({ thread });
    });
    api.get('/api/threads/:id', async (req) => getService().getThread(id(req.params)));

    api.post('/api/threads/:id/estimate', async (req) =>
      getService().estimate(id(req.params), parse(EstimateRequest, req.body)),
    );
    api.post('/api/threads/:id/messages', async (req, reply) => {
      const res = await getService().send(id(req.params), parse(SendMessageRequest, req.body));
      return reply.status(res.deduplicated ? 200 : 201).send(res);
    });

    api.post('/api/messages/:id/retry', async (req) => ({
      message: await getService().retry(id(req.params)),
    }));
    api.patch('/api/messages/:id', async (req) => ({
      message: await getService().editBadFormat(
        id(req.params),
        parse(EditMessageRequest, req.body),
      ),
    }));
    api.get('/api/messages/:id/record', async (req) => getService().record(id(req.params)));

    api.get('/api/threads/:id/conclusions', async (req) => ({
      conclusions: await getService().listConclusions(id(req.params)),
    }));
    api.post('/api/threads/:id/conclusions', async (req, reply) => {
      const conclusion = await getService().saveConclusion(
        id(req.params),
        parse(SaveConclusionRequest, req.body),
      );
      return reply.status(201).send({ conclusion });
    });
  });
}
