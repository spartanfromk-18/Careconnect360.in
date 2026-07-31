import * as Sentry from "@sentry/node";

let sentryInitialized = false;

function ensureSentry() {
  if (sentryInitialized || !process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV || "development",
    tracesSampleRate: 0.1,
  });
  sentryInitialized = true;
}

const LEVELS = { INFO: 0, WARN: 1, ERROR: 2, CRITICAL: 3 };

export function logEvent(source, data, level = "INFO") {
  const entry = { level, timestamp: new Date().toISOString(), source, ...data };
  console.log(JSON.stringify(entry));

  if (LEVELS[level] >= LEVELS.ERROR) {
    ensureSentry();
    if (sentryInitialized) {
      Sentry.captureMessage(`[${source}] ${data.event || "error"}`, {
        level: level === "CRITICAL" ? "fatal" : "error",
        extra: entry,
      });
    }
  }
}

export function makeLogger(source) {
  return (data, level = "INFO") => logEvent(source, data, level);
}
