import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        "accessToken",
        "refreshToken",
        "clientSecret",
        "authorization",
        "req.headers.authorization",
        "headers.authorization",
        "*.access_token",
        "*.refresh_token",
      ],
      censor: "[REDACTED]",
    },
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { colorize: true } },
  });
}

export type Logger = ReturnType<typeof createLogger>;
