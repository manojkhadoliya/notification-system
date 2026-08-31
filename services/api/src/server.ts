import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { authenticate } from "./auth.js";
import { ApiError } from "./errors.js";
import { notificationRoutes } from "./routes/notifications.js";
import { preferenceRoutes } from "./routes/preferences.js";
import { templateRoutes } from "./routes/templates.js";
import type { ApiDependencies } from "./types.js";

export interface BuildServerOptions {
  /** Off by default so the ~40 `routes/*.test.ts` cases stay readable —
   * `index.ts` (the real entrypoint) explicitly turns it on. */
  readonly logger?: boolean;
}

/**
 * Assembles the Fastify app from already-constructed ports — this
 * function itself is pure composition (no `new PrismaClient()`/env
 * reads), which is what makes it unit-testable via `.inject()` against
 * in-memory fakes instead of live infra (see the `routes/*.test.ts`
 * files). `index.ts` is the only caller that wires real adapters and
 * calls `.listen()`.
 */
export function buildServer(
  deps: ApiDependencies,
  options: BuildServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Every route in this package requires tenant auth (Door 1 has no
  // unauthenticated endpoint yet — POST /v1/webhooks/twilio, which would
  // be the exception, is deliberately deferred; see README).
  app.addHook("onRequest", async (request) => {
    await authenticate(request, deps.apiKeyRepository);
  });

  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    // A Fastify/Ajv schema-validation failure (malformed request body,
    // wrong types, failed enum/format checks) — treated as a 400, same
    // shape as every other error, rather than Fastify's own default
    // validation-error body.
    if (error.validation) {
      reply
        .status(400)
        .send({ error: { code: "validation_error", message: error.message } });
      return;
    }
    request.log.error(error);
    reply.status(500).send({
      error: { code: "internal_error", message: "internal server error" },
    });
  });

  app.register(async (instance) => notificationRoutes(instance, deps));
  app.register(async (instance) => preferenceRoutes(instance, deps));
  app.register(async (instance) => templateRoutes(instance, deps));

  return app;
}
