import type { AppConfig } from "./config.js";

export function securityHeadersOptions(config: AppConfig) {
  return {
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" as const },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://accounts.google.com/gsi/client",
          "https://static.cloudflareinsights.com"
        ],
        scriptSrcAttr: ["'none'"],
        frameSrc: ["https://accounts.google.com/gsi/"],
        frameAncestors: ["'none'"],
        connectSrc: [
          "'self'",
          new URL(config.WORLD_API_BASE).origin,
          "https://accounts.google.com/gsi/",
          "https://tile.openstreetmap.org",
          "https://cloudflareinsights.com"
        ],
        imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org"],
        styleSrc: ["'self'", "https://accounts.google.com/gsi/style"],
        styleSrcAttr: ["'unsafe-inline'"],
        workerSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    }
  };
}
