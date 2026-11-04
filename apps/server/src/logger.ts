import pino from "pino";

export type AppLogger = pino.Logger;

export function requestPathForLog(url: string): string {
  return url.split(/[?#]/, 1)[0] || "/";
}

export function createLogger(nodeEnv: string, destination?: pino.DestinationStream): AppLogger {
  const options = {
    level: nodeEnv === "test" ? "silent" : "info",
    base: {
      service: "ash-atlas-server"
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-csrf-token']",
        "request.headers.authorization",
        "request.headers.cookie",
        "request.headers['x-csrf-token']",
        "credential",
        "*.credential",
        "sessionToken",
        "*.sessionToken",
        "deviceToken",
        "*.deviceToken",
        "csrfToken",
        "*.csrfToken",
        "email",
        "*.email"
      ],
      censor: "[REDACTED]"
    }
  };
  return destination ? pino(options, destination) : pino(options);
}
