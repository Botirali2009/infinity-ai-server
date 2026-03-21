const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const FREE_LIMIT = 10;

// Foydalanuvchilar bazasi (fayl sifatida)
const DB_FILE = path.join(os.tmpdir(), "infinity_users.json");

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf-8")); } catch { return {}; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function getUserId(req) {
  return req.headers["x-user-id"] || req.socket.remoteAddress;
}

// OpenRouter ga so'rov
function callAI(messages, system, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "deepseek/deepseek-chat-v3-0324",
      max_tokens: 8192,
      messages: [{ role: "system", content: system }, ...messages],
    });
    const options = {
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://infinity-ai.uz",
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
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.choices[0].message.content);
        } catch(e) { reject(new Error("Xato: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-user-id, x-api-key");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // Health check
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", name: "infinity-ai-server", version: "1.0.0" }));
    return;
  }

  // Chat endpoint
  if (req.url === "/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { messages, system, apiKey } = JSON.parse(body);
        const userId = getUserId(req);
        const db = loadDB();

        // Foydalanuvchini tekshirish
        if (!db[userId]) db[userId] = { count: 0, firstSeen: Date.now() };

        let useKey = apiKey || OPENROUTER_API_KEY;

        // Bepul limit tekshirish
        if (!apiKey && db[userId].count >= FREE_LIMIT) {
          res.writeHead(403);
          res.end(JSON.stringify({
            error: "FREE_LIMIT_REACHED",
            message: `Bepul ${FREE_LIMIT} ta so'rov tugadi! Davom etish uchun openrouter.ai dan kalit oling.`,
            count: db[userId].count,
            limit: FREE_LIMIT,
          }));
          return;
        }

        // AI ga so'rov
        const answer = await callAI(messages, system, useKey);

        // Hisoblagich
        if (!apiKey) {
          db[userId].count++;
          saveDB(db);
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          answer,
          count: db[userId].count,
          limit: FREE_LIMIT,
          remaining: Math.max(0, FREE_LIMIT - db[userId].count),
        }));

      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`✅ infinity-ai server: http://localhost:${PORT}`);
});