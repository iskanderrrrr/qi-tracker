// QI Tracker — Netlify serverless function v7
// Uses Brave Search API for web search (compact results, no token bloat)

const https = require("https");

// Generic HTTPS GET
function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: "GET", headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Generic HTTPS POST
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(payload) },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Brave Search — returns compact snippets only
async function braveSearch(apiKey, query, count = 5) {
  const path = "/res/v1/web/search?q=" + encodeURIComponent(query) + "&count=" + count + "&search_lang=en";
  const res = await httpsGet("api.search.brave.com", path, {
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
    "X-Subscription-Token": apiKey,
  });
  if (res.status !== 200) return [];
  try {
    const data = JSON.parse(res.body);
    return (data.web?.results || []).map(r => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.description || r.extra_snippets?.[0] || "",
    }));
  } catch (_) { return []; }
}

// Anthropic API call
async function claudePost(apiKey, messages) {
  const res = await httpsPost(
    "api.anthropic.com", "/v1/messages",
    { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    { model: "claude-sonnet-4-6", max_tokens: 4096, messages }
  );
  return res;
}

exports.handler = async function (event) {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "Method Not Allowed" };

  let ticker = "", isin = "", name = "";

  try {
    const body = JSON.parse(event.body || "{}");
    ticker = body.ticker || "";
    isin   = body.isin   || "";
    name   = body.name   || "";

    const requiredPw = process.env.ACCESS_PASSWORD;
    if (requiredPw && body.password !== requiredPw) {
      return { statusCode: 401, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "Invalid access password" }) };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not set." }) };
    }
    if (!ticker) {
      return { statusCode: 400, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "Ticker is required" }) };
    }

    const braveKey = process.env.BRAVE_SEARCH_API_KEY;

    // ── Step 1: Web search (if Brave key available) ───────────────────────
    let searchContext = "";

    if (braveKey) {
      const fundLabel = name || ticker;
      const [r1, r2, r3] = await Promise.all([
        braveSearch(braveKey, `${ticker} ETF distribution record date payment date 2025 per share`, 5),
        braveSearch(braveKey, `${ticker} ${fundLabel} income reclassification 19a-1 Form 8937 2024 2025`, 5),
        braveSearch(braveKey, `${ticker} ETF dividend interest option premium income type classification`, 4),
      ]);

      const formatResults = (results, label) => {
        if (!results.length) return "";
        return `\n[${label}]\n` + results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
        ).join("\n");
      };

      searchContext =
        formatResults(r1, "Distributions & Record Dates") +
        formatResults(r2, "Reclassification Notices") +
        formatResults(r3, "Income Classification");
    }

    // ── Step 2: Claude analysis ───────────────────────────────────────────
    const prompt = buildPrompt(ticker, isin, name, searchContext);

    const apiRes = await claudePost(anthropicKey, [{ role: "user", content: prompt }]);

    if (apiRes.status < 200 || apiRes.status >= 300) {
      let errMsg = "Anthropic API error (HTTP " + apiRes.status + ")";
      try { errMsg = JSON.parse(apiRes.body).error?.message || errMsg; } catch (_) {}
      return { statusCode: apiRes.status, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: errMsg }) };
    }

    let apiData;
    try { apiData = JSON.parse(apiRes.body); }
    catch (e) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "Cannot parse Anthropic response: " + e.message }) };
    }

    const textContent = (apiData.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!textContent) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "No text in response. stop_reason=" + (apiData.stop_reason || "?") }) };
    }

    // Find the last complete JSON object in the response
    const lastBrace = textContent.lastIndexOf("}");
    if (lastBrace === -1) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "No JSON in response: " + textContent.slice(0, 200) }) };
    }

    let depth = 0, jsonStart = -1;
    for (let i = lastBrace; i >= 0; i--) {
      if (textContent[i] === "}") depth++;
      else if (textContent[i] === "{") { depth--; if (depth === 0) { jsonStart = i; break; } }
    }

    if (jsonStart === -1) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "Cannot find JSON boundaries" }) };
    }

    let result;
    try {
      result = JSON.parse(textContent.slice(jsonStart, lastBrace + 1));
    } catch (_) {
      result = recoverPartialJson(textContent.slice(jsonStart), ticker, isin, name);
    }

    // Tag whether result came from web search or training data
    result._source = braveKey ? "web_search" : "training_data";

    return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" },
             body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
             body: JSON.stringify({ error: "Function error (" + ticker + "): " + err.message }) };
  }
};

function recoverPartialJson(partial, ticker, isin, name) {
  const result = {
    ticker, isin, fund_name: name || ticker, fund_manager: "", strategy: "",
    distributions: [], reclassification_risk: "unknown",
    reclassification_notes: "Response was truncated — partial data only.",
    _truncated: true,
  };
  ["fund_name", "fund_manager", "strategy", "reclassification_risk", "reclassification_notes"].forEach(f => {
    const m = partial.match(new RegExp('"' + f + '"\\s*:\\s*"([^"]*)"'));
    if (m) result[f] = m[1];
  });
  return result;
}

function buildPrompt(ticker, isin, name, searchContext) {
  const hasSearch = searchContext && searchContext.trim().length > 0;

  return `You are a QI (qualified intermediary) tax specialist. Analyze this US ETF's distributions for 2025.

ETF: ${ticker}${isin ? " | ISIN: " + isin : ""}${name ? " | " + name : ""}

${hasSearch ? `== WEB SEARCH RESULTS ==
Use the following search results as your primary source. Prefer this data over your training knowledge.
${searchContext}
== END OF SEARCH RESULTS ==` : `No web search results available — use your training knowledge.`}

CRITICAL DEFINITIONS:
- RECORD DATE: Date investor must be on shareholder register to receive distribution. Always BEFORE the payment date (typically 1 business day after ex-dividend date).
- PAYMENT DATE: Date cash is actually paid. Always AFTER the record date (typically 1-2 weeks later).
- Never confuse or swap these two dates.

INCOME CODE RULES:
- "01" = Interest → T-bill/bond ETFs: BIL, SHV, SGOV, USFR, AGG, BND, TIP, VTIP, SCHP, JPST, NEAR
- "06" = Ordinary dividend → equity ETFs: SPY, IVV, VOO, QQQ, VTI, VYM, SCHD, DVY
- "37" = Other income / option premium → YieldMax ETFs (TSLY, NVDY, MSFO, AMZY, GOOGY, SMCY, MARO, SNOY, CONY, NVOY, APLY, JPMO, etc.), JEPI, JEPQ, GPIX, XDTE, QDTE
- "40" = Return of capital

RECLASSIFICATION:
- Set "reclassified": true if a distribution's income character was restated after initial reporting
- A distribution can be split: e.g. 70% Code 37 + 30% Code 40 — show both as separate components
- Report the final restated character, not the original

List 2025 distributions only. Return ONLY the JSON object — no explanation, no markdown:

{
  "ticker": "${ticker}",
  "isin": "${isin || ""}",
  "fund_name": "full official fund name",
  "fund_manager": "investment manager name",
  "strategy": "one-line strategy description",
  "distributions": [
    {
      "record_date": "YYYY-MM-DD",
      "payment_date": "YYYY-MM-DD",
      "total_per_share": 0.1234,
      "components": [
        {
          "income_code": "01",
          "income_type": "T-Bill Interest",
          "per_share": 0.1234,
          "percentage": 100
        }
      ],
      "reclassified": false,
      "confidence": "high",
      "notes": ""
    }
  ],
  "reclassification_risk": "low",
  "reclassification_notes": "explanation of reclassification risk"
}`;
}
