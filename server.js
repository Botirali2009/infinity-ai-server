const https = require("https");
const http = require("http");

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const FREE_LIMIT = 10;

const db = {};

function getUserId(req) {
  return req.headers["x-user-id"] || req.socket.remoteAddress || "anonymous";
}

function callAI(messages, system, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "google/gemma-3-27b-it",
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
        "HTTP-Referer": "https://infnity-ai-server.onrender.com",
        "X-Title": "InfinityAI",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(d) { data += d; });
      res.on("end", function() {
        try {
          var json = JSON.parse(data);
          if (json.error) {
            console.error("OpenRouter xato:", JSON.stringify(json.error));
            reject(new Error(json.error.message || JSON.stringify(json.error)));
          } else {
            resolve(json.choices[0].message.content);
          }
        } catch(e) {
          reject(new Error("Parse xato: " + data.slice(0, 200)));
        }
      });
    });

    req.on("error", function(e) { reject(e); });
    req.write(body);
    req.end();
  });
}

var server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-user-id");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", version: "1.0.0" }));
    return;
  }

  if (req.url === "/chat" && req.method === "POST") {
    var body = "";
    req.on("data", function(d) { body += d; });
    req.on("end", function() {
      var parsed, messages, system, userApiKey, userId;
      try {
        parsed = JSON.parse(body);
        messages = parsed.messages || [];
        system = parsed.system || "Sen AI yordamchisan.";
        userApiKey = parsed.apiKey || null;
        userId = getUserId(req);

        if (!db[userId]) {
          db[userId] = { count: 0 };
        }

        // O'z kaliti bilan
        if (userApiKey) {
          callAI(messages, system, userApiKey).then(function(answer) {
            res.writeHead(200);
            res.end(JSON.stringify({ answer: answer, remaining: 999 }));
          }).catch(function(e) {
            console.error("callAI xato:", e.message);
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          });
          return;
        }

        // Server kaliti yo'q
        if (!OPENROUTER_API_KEY) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Server kaliti yo'q" }));
          return;
        }

        // Limit tekshirish
        if (db[userId].count >= FREE_LIMIT) {
          res.writeHead(403);
          res.end(JSON.stringify({
            error: "FREE_LIMIT_REACHED",
            remaining: 0,
          }));
          return;
        }

        // AI ga so'rov
        callAI(messages, system, OPENROUTER_API_KEY).then(function(answer) {
          db[userId].count++;
          var remaining = FREE_LIMIT - db[userId].count;
          res.writeHead(200);
          res.end(JSON.stringify({
            answer: answer,
            remaining: remaining,
          }));
        }).catch(function(e) {
          console.error("callAI xato:", e.message);
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        });

      } catch(e) {
        console.error("Server xato:", e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, function() {
  console.log("infinity-ai server: http://localhost:" + PORT);
});
