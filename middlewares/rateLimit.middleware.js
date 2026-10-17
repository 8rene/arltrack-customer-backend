// Minimal in-memory rate limiter (no extra dependency).
//
// LIMITATION: state lives in the memory of one server instance. On Vercel
// (serverless) each instance has its own counter and counters reset on a cold
// start, so this slows down casual scraping/guessing but is not a hard
// guarantee. For a hard limit use a shared store (e.g. Upstash Redis) or
// Vercel's WAF rate limiting — this is the zero-dependency first line.
const buckets = new Map(); // key -> { count, resetAt }

// Which address is "the client"?
// X-Forwarded-For is only a header — anyone can send their own. Each proxy in front of
// the app APPENDS the address it saw to the RIGHT end of the list, so the LEFT-most entry
// is client-controlled (the old code used it, which let a caller change the header on every
// request and never hit the limit). Only the entries added by OUR OWN proxies can be trusted.
//
// TRUST_PROXY_HOPS = how many proxies sit between the internet and this app:
//   unset on Vercel -> 1 (Vercel is the single proxy; it sets the header itself)
//   unset elsewhere -> 0 (no proxy: use the TCP connection's own address)
//   e.g. 2 behind Cloudflare + a load balancer
const trustedHops = () => {
  const raw = process.env.TRUST_PROXY_HOPS;
  const n = Number(raw);
  if (raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 0) return n;
  return process.env.VERCEL ? 1 : 0;
};

const clientIP = (req) => {
  const hops = trustedHops();
  if (hops > 0) {
    const list = String(req.headers["x-forwarded-for"] || "").split(",").map((v) => v.trim()).filter(Boolean);
    if (list.length) return list[Math.max(0, list.length - hops)]; // the address our own proxy recorded
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
  }
  return req.socket?.remoteAddress || req.ip || "unknown";
};

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
module.exports.clientIP = clientIP; // exported for tests
