import type { FastifyInstance, RouteHandlerMethod } from "fastify";

import {
  HTTP_ROUTE_POLICIES,
  type HttpRouteFamily,
  type HttpRouteMethod
} from "../routePolicyRegistry.js";

export type HttpRouteFamilyRegistrar = Readonly<{
  delete(path: string, handler: RouteHandlerMethod): void;
  get(path: string, handler: RouteHandlerMethod): void;
  patch(path: string, handler: RouteHandlerMethod): void;
  post(path: string, handler: RouteHandlerMethod): void;
}>;

export function createRouteFamily(
  app: FastifyInstance,
  family: HttpRouteFamily
): HttpRouteFamilyRegistrar {
  const register = (method: HttpRouteMethod, path: string, handler: RouteHandlerMethod): void => {
    const policy = HTTP_ROUTE_POLICIES.find((candidate) =>
      candidate.method === method && candidate.path === path
    );
    if (!policy) throw new Error(`HTTP route policy is missing for ${method} ${path}`);
    if (policy.family !== family) {
      throw new Error(
        `HTTP route ${method} ${path} belongs to ${policy.family}, not ${family}`
      );
    }
    app.route({ method, url: path, handler });
  };
  return {
    delete: (path, handler) => register("DELETE", path, handler),
    get: (path, handler) => register("GET", path, handler),
    patch: (path, handler) => register("PATCH", path, handler),
    post: (path, handler) => register("POST", path, handler)
  };
}
