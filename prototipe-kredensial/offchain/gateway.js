// Observer / API gateway: baca-saja + rate limit (Tabel 17, S-11, S-12).
// Dua bentuk dengan antarmuka yang sama:
//   1) createGateway(...)      : objek di dalam proses (dipakai Verifier langsung)
//   2) startHttpGateway(...)   : server REST sederhana (GET saja), dan HttpGatewayClient untuk memanggilnya
const http = require("http");

const CRED_STATUS = ["NONE", "VALID", "REVOKED", "SUPERSEDED"];
const ISSUER_STATUS = ["NONE", "ACTIVE", "SUSPENDED", "REMOVED"];

class RateLimitError extends Error {
  constructor() {
    super("rate limit terlampaui");
    this.code = "RATE_LIMIT";
  }
}

class RateLimiter {
  constructor({ max = 100, windowMs = 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> {start, count}
  }
  check(key) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return;
    }
    h.count += 1;
    if (h.count > this.max) throw new RateLimitError();
  }
}

/** Gateway di dalam proses. Hanya membungkus contract yang terhubung ke provider (tanpa signer). */
function createGateway({ credentialRegistry, issuerRegistry, rateLimit }) {
  const limiter = new RateLimiter(rateLimit);
  return {
    async getStatus(cid, key = "local") {
      limiter.check(key);
      const [status, commitment, issuer, timestamp, newCid] = await credentialRegistry.getStatus(cid); // eth_call: tanpa gas
      return { status: CRED_STATUS[Number(status)], commitment, issuer, timestamp: Number(timestamp), newCid };
    },
    async getIssuer(address, key = "local") {
      limiter.check(key);
      const [did, status] = await issuerRegistry.getIssuer(address);
      return { did, status: ISSUER_STATUS[Number(status)] };
    },
    // Gateway tidak punya hak tulis.
    async sendTransaction() {
      throw new Error("gateway baca-saja: transaksi tulis ditolak");
    },
  };
}

/** Server REST: hanya GET /status/:cid dan GET /issuer/:address. Metode lain ditolak (405). */
function startHttpGateway(gateway, port = 0) {
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "gateway baca-saja" });
    const key = req.socket.remoteAddress || "unknown";
    try {
      const m = /^\/(status|issuer)\/(0x[0-9a-fA-F]+)$/.exec(req.url);
      if (!m) return send(404, { error: "tidak ditemukan" });
      const data = m[1] === "status" ? await gateway.getStatus(m[2], key) : await gateway.getIssuer(m[2], key);
      return send(200, data);
    } catch (e) {
      if (e.code === "RATE_LIMIT") return send(429, { error: e.message });
      return send(500, { error: "galat gateway" });
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

/** Klien REST dengan antarmuka yang sama seperti gateway di dalam proses. */
class HttpGatewayClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  async _get(path) {
    const r = await fetch(this.baseUrl + path);
    if (r.status === 429) throw new RateLimitError();
    if (!r.ok) throw new Error("gateway HTTP " + r.status);
    return r.json();
  }
  getStatus(cid) {
    return this._get("/status/" + cid);
  }
  getIssuer(address) {
    return this._get("/issuer/" + address);
  }
}

module.exports = { createGateway, startHttpGateway, HttpGatewayClient, RateLimitError, CRED_STATUS, ISSUER_STATUS };
