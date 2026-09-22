// Minimal in-memory rate limiter (no extra dependency).
//
// LIMITATION: state lives in the memory of one server instance. On Vercel
// (serverless) each instance has its own counter and counters reset on a cold
// start, so this slows down casual scraping/guessing but is not a hard
// guarantee. For a hard limit use a shared store (e.g. Upstash Redis) or
// Vercel's WAF rate limiting — this is the zero-dependency first line.
const buckets = new Map(); // key -> { count, resetAt }

const clientIP = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";

const rateLimit = ({ windowMs = 10 * 60 * 1000, max = 30, keyPrefix = "rl" } = {}) => (req, res, next) => {
  const now = Date.now();
  const key = `${keyPrefix}:${clientIP(req)}`;

  // opportunistic cleanup so the map can't grow forever
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }

  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;

  if (b.count > max) {
    res.set("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
    return res.status(429).json({ message: "Too many requests. Please try again in a few minutes." });
  }
  next();
};

module.exports = rateLimit;
