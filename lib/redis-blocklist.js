import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KEY_PREFIX = "jwt_blocklist:";

export async function blocklistToken(jti, ttlSeconds) {
  if (!jti) throw new Error("blocklistToken: jti is required");
  const ttl = Math.max(1, Math.min(ttlSeconds || 12 * 60 * 60, 12 * 60 * 60));
  await redis.set(`${KEY_PREFIX}${jti}`, "1", { ex: ttl });
}

export async function isTokenBlocked(jti) {
  if (!jti) return true;
  try {
    const result = await redis.get(`${KEY_PREFIX}${jti}`);
    return result !== null;
  } catch (err) {
    console.log(JSON.stringify({
      level: "CRITICAL",
      timestamp: new Date().toISOString(),
      source: "redis-blocklist",
      event: "BLOCKLIST_CHECK_FAILED_FAIL_OPEN",
      error: err.message,
    }));
    return false;
  }
}
