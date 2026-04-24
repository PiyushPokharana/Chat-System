class RateLimiterService {
    constructor(options = {}) {
        this.windowMs = options.windowMs || 10_000;
        this.maxRequests = options.maxRequests || 25;
        this.bucketByKey = new Map();
    }

    allow(key) {
        const now = Date.now();
        const bucket = this.bucketByKey.get(key);

        if (!bucket || now - bucket.windowStart > this.windowMs) {
            this.bucketByKey.set(key, { count: 1, windowStart: now });
            return { allowed: true, remaining: this.maxRequests - 1 };
        }

        if (bucket.count >= this.maxRequests) {
            const retryAfterMs = Math.max(0, this.windowMs - (now - bucket.windowStart));
            return { allowed: false, remaining: 0, retryAfterMs };
        }

        bucket.count += 1;
        return { allowed: true, remaining: this.maxRequests - bucket.count };
    }
}

module.exports = new RateLimiterService({
    windowMs: 10_000,
    maxRequests: 25,
});
