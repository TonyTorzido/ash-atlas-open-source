import type { FastifyReply } from "fastify";

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): void {
  reply.status(statusCode).send({
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  });
}

