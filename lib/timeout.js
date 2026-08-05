/**
 * lib/timeout.js
 * Strict timeout wrapper for all external API calls (Resend, Razorpay).
 * Vercel serverless functions have a hard 10s ceiling; external calls must
 * fail gracefully within 5s to leave headroom for logging and DB writes.
 */

/**
 * Races a promise against a timeout rejection.
 * Always clears the internal timer — no timer leaks in the event loop.
 *
 * @param {number}  ms      - Milliseconds before rejection (default 5000).
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
