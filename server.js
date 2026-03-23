const https = require("https");
const http = require("http");
const tls = require("tls");
const net = require("net");
const urlMod = require("url");

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const REDIS_URL = process.env.REDIS_URL;
const FREE_LIMIT = 10;

// ── Minimal Redis client (TLS, no npm needed) ─────────────────────────────────
function redisCmd(redisUrl, ...args) {
  return new Promise((resolve, reject) => {
    const parsed = new urlMod.URL(redisUrl);
    const host = parsed.hostname;
    const port = parseInt(parsed.port) || 6379;
    const password = decodeURIComponent(parsed.password || "");
    const useTLS = redisUrl.startsWith("rediss://");

    const cmd = `*${args.length}\r\n` + args.map(a => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('');
    let data = "";
    let authed = !password;

    const sock = useTLS
      ? tls.connect({ host, port, rejectUnauthorized: false })
      : net.createConnection({ host, port });

    sock.on("secureConnect", () => {
      if (password) sock.write(`*2\r\n$4\r\nAUTH\r\n$${password.length}\r\n${password}\r\n`);
      else sock.write(cmd);
    });

    sock.on("connect", () => {
      if (!useTLS) {
        if (password) sock.write(`*2\r\n$4\r\nAUTH\r\n$${password.length}\r\n${password}\r\n`);
        else sock.write(cmd);
      }
    });

    sock.on("data", (chunk) => {
      data += chunk.toString();
      const lines = data.split("\r\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        if (line === "+OK" && !authed) {
          authed = true;
          sock.write(cmd);
          data = "";
          return;
        }
        if (line.startsWith(":")) { resolve(parseInt(line.slice(1))); sock.destroy(); return; }
        if (line.startsWith("+")) { resolve(line.slice(1)); sock.destroy(); return; }
        if (line.startsWith("-")) { reject(new Error(line.slice(1))); sock.destroy(); return; }
        if (line === "$-1") { resolve(null); sock.destroy(); return; }
        if (line.startsWith("$") && lines[i+1] !== undefined) { resolve(lines[i+1]); sock.destroy(); return; }
        if (line.startsWith("*")) {
          const count = parseInt(line.slice(1));
          const result = [];
          for (let j = i+1; j < lines.length && result.length < count; j++) {
            if (lines[j] && !lines[j].startsWith("$") && !lines[j].startsWith("*")) result.push(lines[j]);
          }
          if (result.length === count) { resolve(result); sock.destroy(); return; }
        }
      }
    });

    sock.on("error", (e) => { reject(e); });
    sock.setTimeout(6000, () => { sock.destroy(); reject(new Error("Redis timeout")); });
  });
}

// Helpers
const rc = (...args) => redisCmd(REDIS_URL, ...args);

// In-memory fallback
const mem = {};
let redisOk = false;

async function testRedis() {
  if (!REDIS_URL) return false;
  try { await rc("SET", "ping", "pong"); redisOk = true; console.log("✅ Redis connected!"); return true; }
  catch(e) { console.log("Redis failed:", e.message); return false; }
}

// ── User DB ───────────────────────────────────────────────────────────────────
async function getCount(userId) {
  try {
    if (redisOk) {
      const val = await rc("GET", `user:${userId}:count`);
      return parseInt(val) || 0;
    }
  } catch(e) { console.error("Redis get error:", e.message); }
  return mem[userId]?.count || 0;
}

async function incrCount(userId) {
  try {
    if (redisOk) {
      const count = await rc("INCR", `user:${userId}:count`);
      await rc("SET", `user:${userId}:lastSeen`, Date.now());
      await rc("SET", `user:${userId}:firstSeen_nx`, Date.now()); // only if not exists logic in app
      return count;
    }
  } catch(e) { console.error("Redis incr error:", e.message); }
  if (!mem[userId]) mem[userId] = { count: 0, firstSeen: Date.now() };
  mem[userId].count++;
  mem[userId].lastSeen = Date.now();
  return mem[userId].count;
}

async function getTotalStats() {
  try {
    if (redisOk) {
      const totalReqs = await rc("GET", "stats:requests");
      const totalUsers = await rc("GET", "stats:users");
      return { totalRequests: parseInt(totalReqs) || 0, totalUsers: parseInt(totalUsers) || 0 };
    }
  } catch(e) {}
  const users = Object.keys(mem).length;
  const reqs = Object.values(mem).reduce((s, u) => s + (u.count || 0), 0);
  return { totalRequests: reqs, totalUsers: users };
}

async function trackRequest(userId, isNew) {
  try {
    if (redisOk) {
      await rc("INCR", "stats:requests");
      if (isNew) await rc("INCR", "stats:users");
    }
  } catch(e) {}
}

// ── AI Call ───────────────────────────────────────────────────────────────────
function callAI(messages, system, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "deepseek/deepseek-chat-v3-0324",
      max_tokens: 4096,
      messages: [{ role: "system", content: system }, ...messages],
    });
    const options = {
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "HTTP-Referer": "https://infinityai-dev.netlify.app",
        "X-Title": "InfinityAI",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { console.error("OpenRouter:", JSON.stringify(json.error)); reject(new Error(json.error.message)); }
          else resolve(json.choices[0].message.content);
        } catch(e) { reject(new Error("Parse error: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getUserId(req) {
  return req.headers["x-user-id"] || req.socket.remoteAddress || "anon";
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-user-id");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // Health + stats
  if (req.url === "/" && req.method === "GET") {
    const stats = await getTotalStats();
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", version: "2.0.0", redis: redisOk ? "connected" : "memory", ...stats }));
    return;
  }

  // Public stats endpoint
  if (req.url === "/stats" && req.method === "GET") {
    const stats = await getTotalStats();
    res.writeHead(200);
    res.end(JSON.stringify(stats));
    return;
  }

  // Chat
  if (req.url === "/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const messages = parsed.messages || [];
        const system = parsed.system || "Sen AI yordamchisan.";
        const userApiKey = parsed.apiKey || null;
        const userId = getUserId(req);

        // Own key → unlimited
        if (userApiKey) {
          const answer = await callAI(messages, system, userApiKey);
          res.writeHead(200);
          res.end(JSON.stringify({ answer, remaining: 999, ownKey: true }));
          return;
        }

        if (!OPENROUTER_API_KEY) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Server key missing" }));
          return;
        }

        const currentCount = await getCount(userId);
        const isNew = currentCount === 0;

        if (currentCount >= FREE_LIMIT) {
          res.writeHead(403);
          res.end(JSON.stringify({
            error: "FREE_LIMIT_REACHED",
            remaining: 0,
            count: currentCount,
          }));
          return;
        }

        const answer = await callAI(messages, system, OPENROUTER_API_KEY);
        const newCount = await incrCount(userId);
        await trackRequest(userId, isNew);

        res.writeHead(200);
        res.end(JSON.stringify({
          answer,
          count: newCount,
          remaining: FREE_LIMIT - newCount,
          limit: FREE_LIMIT,
        }));

      } catch(e) {
        console.error("Server error:", e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

testRedis().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ infinity-ai server v2.0 running on port ${PORT}`);
    console.log(`   Redis: ${redisOk ? "connected ✅" : "memory mode ⚠️"}`);
    console.log(`   Free limit: ${FREE_LIMIT} requests per user`);
  });
});
