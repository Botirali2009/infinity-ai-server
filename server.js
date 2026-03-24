const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const FREE_LIMIT = 10;
const db = {};

console.log("=== infinity-ai server starting ===");
console.log("PORT:", PORT);
console.log("API KEY:", OPENROUTER_API_KEY ? "bor (" + OPENROUTER_API_KEY.slice(0,12) + "...)" : "YOQ!!!");

function getUserId(req) {
  return req.headers["x-user-id"] || req.socket.remoteAddress || "anon";
}

function callAI(messages, system, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "deepseek/deepseek-chat-v3-0324",
      max_tokens: 4096,
      messages: [{ role: "system", content: system }, ...messages],
    });

    console.log("→ OpenRouter ga yuborilmoqda...");
    console.log("  Model: deepseek/deepseek-chat-v3-0324");
    console.log("  Key:", apiKey.slice(0,12) + "...");

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
      console.log("  OpenRouter status:", res.statusCode);
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        console.log("  OpenRouter javob:", data.slice(0, 400));
        try {
          const json = JSON.parse(data);
          if (json.error) {
            console.log("  XATO:", JSON.stringify(json.error));
            reject(new Error(json.error.message || JSON.stringify(json.error)));
          } else {
            console.log("  ✓ Javob keldi!");
            resolve(json.choices[0].message.content);
          }
        } catch(e) {
          console.log("  Parse xato:", e.message);
          reject(new Error("Parse error: " + data.slice(0, 200)));
        }
      });
    });

    req.on("error", (e) => {
      console.log("  Request xato:", e.message);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-user-id");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.url === "/" && req.method === "GET") {
    const users = Object.keys(db).length;
    const reqs = Object.values(db).reduce((s, u) => s + u.count, 0);
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", totalUsers: users, totalRequests: reqs, version: "2.1.0" }));
    return;
  }

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

        console.log("\n--- Yangi so'rov ---");
        console.log("  userId:", userId);
        console.log("  userApiKey:", userApiKey ? "bor" : "yo'q");
        console.log("  messages:", messages.length, "ta");

        // O'z kaliti bilan — cheksiz
        if (userApiKey) {
          console.log("  → O'z kaliti bilan yuborilmoqda");
          const answer = await callAI(messages, system, userApiKey);
          res.writeHead(200);
          res.end(JSON.stringify({ answer, remaining: 999 }));
          return;
        }

        // Server kaliti yo'q
        if (!OPENROUTER_API_KEY) {
          console.log("  XATO: Server kaliti yo'q!");
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Server kaliti yo'q" }));
          return;
        }

        // Limit tekshirish
        if (!db[userId]) db[userId] = { count: 0 };
        console.log("  User count:", db[userId].count, "/", FREE_LIMIT);

        if (db[userId].count >= FREE_LIMIT) {
          console.log("  → Limit tugagan!");
          res.writeHead(403);
          res.end(JSON.stringify({ error: "FREE_LIMIT_REACHED", remaining: 0 }));
          return;
        }

        // Server kaliti bilan
        console.log("  → Server kaliti bilan yuborilmoqda");
        const answer = await callAI(messages, system, OPENROUTER_API_KEY);
        db[userId].count++;

        res.writeHead(200);
        res.end(JSON.stringify({
          answer,
          count: db[userId].count,
          remaining: FREE_LIMIT - db[userId].count,
        }));

      } catch(e) {
        console.log("  SERVER XATO:", e.message);
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
  console.log("✅ infinity-ai server port " + PORT + " da ishlamoqda");
  console.log("   API Key:", OPENROUTER_API_KEY ? "✓ bor" : "✗ YOQ!");
});
