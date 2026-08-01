import * as Sentry from "@sentry/node";

if (!process.env.SENTRY_DSN) {
  throw new Error('CRITICAL: SENTRY_DSN must be defined for error monitoring.');
}

// Eager init so @sentry/node's default integrations (uncaughtException /
// unhandledRejection hooks) are armed from cold start — not lazily on first
// ERROR. This guarantees runtime exceptions are captured even if a handler
// throws before any structured log is emitted.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV || "development",
  tracesSampleRate: 0.1,
});

export function captureException(error, context = {}) {
  if (!(error instanceof Error)) return;
  Sentry.captureException(error, { extra: context });
}

const LEVELS = { INFO: 0, WARN: 1, ERROR: 2, CRITICAL: 3 };

export function logEvent(source, data, level = "INFO") {
  const entry = { level, timestamp: new Date().toISOString(), source, ...data };
  console.log(JSON.stringify(entry));

  if (LEVELS[level] >= LEVELS.ERROR) {
    Sentry.captureMessage(`[${source}] ${data.event || "error"}`, {
      level: level === "CRITICAL" ? "fatal" : "error",
      extra: entry,
    });
  }
}

export function makeLogger(source) {
  return (data, level = "INFO") => logEvent(source, data, level);
}
