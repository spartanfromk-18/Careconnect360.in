/**
 * lib/timeout.js
 * Strict timeout utilities for all external I/O (Resend, Razorpay).
 * Vercel serverless functions have a hard 10s ceiling; external calls must
 * fail gracefully within 5s to leave headroom for DB writes and logging.
 */

/**
 * Races a promise against a timeout rejection.
 * Always clears the internal timer — no timer leaks in the event loop.
 *
 * @param {number}  ms      - Milliseconds before rejection.
 * @param {Promise} promise - The async operation to race.
 * @param {string}  [label] - Human-readable label for the error message.
 * @returns {Promise}
 */
export const withTimeout = (ms = 5000, promise, label = 'operation') => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`[timeout] ${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

/**
 * fetch() with a hard AbortSignal deadline. Unlike a bare Promise.race,
 * the underlying HTTP request is genuinely aborted when the deadline hits —
 * the socket is closed instead of the promise merely losing the race.
 *
 * @param {string}  url         - Target URL.
 * @param {object}  [options]   - fetch options (may include its own signal).
 * @param {number}  [ms=5000]   - Abort deadline in milliseconds.
 * @returns {Promise<Response>}
 */
export const fetchWithTimeout = (url, options = {}, ms = 5000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  const externalSignal = options.signal || null;
  const signal = externalSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  return fetch(url, { ...options, signal }).finally(() => clearTimeout(timeoutId));
};
