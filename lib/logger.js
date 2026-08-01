import * as Sentry from "@sentry/node";

// Telemetry must NEVER take down the application. SENTRY_DSN is optional: when
// it is absent, Sentry is skipped, a single WARN is emitted, and all capture
// calls become no-ops so the app keeps serving users without monitoring.
const SENTRY_DSN = process.env.SENTRY_DSN;
let sentryEnabled = false;

if (SENTRY_DSN) {
  // Eager init so @sentry/node's default integrations (uncaughtException /
  // unhandledRejection hooks) are armed from cold start — not lazily on first
  // ERROR. This guarantees runtime exceptions are captured even if a handler
  // throws before any structured log is emitted.
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.VERCEL_ENV || "development",
    tracesSampleRate: 0.1,
  });
  sentryEnabled = true;
} else {
  console.log(JSON.stringify({
    level: "WARN",
    timestamp: new Date().toISOString(),
    source: "logger",
    event: "SENTRY_DISABLED",
    error: "SENTRY_DSN not defined — error monitoring disabled, continuing without it",
  }));
}

export function captureException(error, context = {}) {
  if (!sentryEnabled || !(error instanceof Error)) return;
  Sentry.captureException(error, { extra: context });
}

const LEVELS = { INFO: 0, WARN: 1, ERROR: 2, CRITICAL: 3 };

export function logEvent(source, data, level = "INFO") {
  const entry = { level, timestamp: new Date().toISOString(), source, ...data };
  console.log(JSON.stringify(entry));

  if (sentryEnabled && LEVELS[level] >= LEVELS.ERROR) {
    Sentry.captureMessage(`[${source}] ${data.event || "error"}`, {
      level: level === "CRITICAL" ? "fatal" : "error",
      extra: entry,
    });
  }
}

export function makeLogger(source) {
  return (data, level = "INFO") => logEvent(source, data, level);
}
