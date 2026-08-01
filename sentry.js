// Unified Sentry browser scope for all frontend entry points
// (index.html, login.html, admin.html). Loaded as a same-origin static asset
// via <script src="/sentry.js" defer> so CSP 'self' covers it — no inline
// script hashing required.
(function () {
  try {
    if (typeof Sentry === 'undefined') return;
    Sentry.onLoad(function () {
      Sentry.init({
        dsn: 'https://8c95014606a2fe163620b886475ee784@o4511563071750144.ingest.de.sentry.io/4511563091542096',
        environment: 'production',
        tracesSampleRate: 0.1,
        beforeSend(event) {
          if (window.location.hostname === 'localhost' ||
              window.location.hostname.includes('github.dev')) {
            return null;
          }
          return event;
        }
      });
    });
  } catch (e) {
    console.warn('Sentry initialization skipped:', e);
  }
})();
