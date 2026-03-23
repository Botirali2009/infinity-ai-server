const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const FREE_LIMIT = 10;
const db = {};

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
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.choices[0].message.content);
        } catch(e) { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
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
    res.end(JSON.stringify({ status: "ok", totalUsers: users, totalRequests: reqs }));
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

        if (userApiKey) {
          const answer = await callAI(messages, system, userApiKey);
          res.writeHead(200);
          res.end(JSON.stringify({ answer, remaining: 999 }));
          return;
        }

        if (!OPENROUTER_API_KEY) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Server key missing" }));
          return;
        }

        if (!db[userId]) db[userId] = { count: 0 };

        if (db[userId].count >= FREE_LIMIT) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: "FREE_LIMIT_REACHED", remaining: 0 }));
          return;
        }

        const answer = await callAI(messages, system, OPENROUTER_API_KEY);
        db[userId].count++;

        res.writeHead(200);
        res.end(JSON.stringify({
          answer,
          count: db[userId].count,
          remaining: FREE_LIMIT - db[userId].count,
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
  console.log("infinity-ai server running on port " + PORT);
});
