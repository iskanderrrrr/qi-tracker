// QI Tracker — Netlify serverless function v8
// Fixes: searches for actual record dates, full 2024+2025 history, all payments listed

const https = require("https");

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function braveSearch(apiKey, query, count) {
  const path = "/res/v1/web/search?q=" + encodeURIComponent(query) + "&count=" + (count || 6) + "&search_lang=en";
  const res = await httpsGet("api.search.brave.com", path, {
    "Accept": "application/json",
    "Accept-Encoding": "identity",
    "X-Subscription-Token": apiKey,
  });
  if (res.status !== 200) return [];
  try {
    return (JSON.parse(res.body).web?.results || []).map(r => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.description || r.extra_snippets?.[0] || "",
    }));
  } catch (_) { return []; }
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

    // ── Web search ────────────────────────────────────────────────────────
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    let searchContext = "";

    if (braveKey) {
      const [r1, r2, r3, r4] = await Promise.all([
        // Record dates are published on financial data sites
        braveSearch(braveKey, `"${ticker}" ETF "record date" dividend distribution history 2024 2025`, 6),
        braveSearch(braveKey, `"${ticker}" ETF dividend history "record date" "payment date" per share`, 6),
        braveSearch(braveKey, `"${ticker}" income reclassification "19a-1" OR "Form 8937" 2024 2025`, 5),
        braveSearch(braveKey, `"${ticker}" ETF income type "interest" OR "dividend" OR "return of capital" OR "option premium"`, 4),
      ]);

      const fmt = (results, label) => {
        if (!results.length) return "";
        return `\n[${label}]\n` + results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
        ).join("\n");
      };

      searchContext =
        fmt(r1, "Record Dates & Distribution History") +
        fmt(r2, "Payment Dates & Per-Share Amounts") +
        fmt(r3, "Reclassification Notices") +
        fmt(r4, "Income Type Classification");
    }

    // ── Claude analysis ───────────────────────────────────────────────────
    const apiRes = await httpsPost(
      "api.anthropic.com", "/v1/messages",
      { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      { model: "claude-sonnet-4-6", max_tokens: 8192, messages: [{ role: "user", content: buildPrompt(ticker, isin, name, searchContext) }] }
    );

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

    // Find last complete JSON object in response
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
               body: JSON.stringify({ error: "Cannot find JSON boundaries in response" }) };
    }

    let result;
    try {
      result = JSON.parse(textContent.slice(jsonStart, lastBrace + 1));
    } catch (_) {
      result = recoverPartialJson(textContent.slice(jsonStart), ticker, isin, name);
    }

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
    reclassification_notes: "Response truncated — partial data only.",
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
  return `You are a QI (qualified intermediary) tax specialist. Provide a COMPLETE distribution history for this ETF covering ALL of 2024 and all of 2025 year-to-date (through April 2025).

ETF: ${ticker}${isin ? " | ISIN: " + isin : ""}${name ? " | " + name : ""}

${hasSearch
  ? `== WEB SEARCH RESULTS — USE AS PRIMARY SOURCE ==\n${searchContext}\n== END SEARCH RESULTS ==\n`
  : "No web search available — use training knowledge.\n"}

━━ RECORD DATE — READ CAREFULLY ━━
The record date is a distinct published date, different from both the ex-dividend date and the payment date.
Record dates are published on financial data sites such as Nasdaq.com, ETF.com, Bloomberg, and the fund company's own website.
Use the record dates from the search results above. Do not substitute ex-dividend dates or payment dates.
If the search results do not contain record dates for a specific payment, set confidence to "low" and state that in notes.

━━ COVERAGE — ALL PAYMENTS ━━
You MUST list every single distribution made from January 2024 through April 2025.
- Monthly-paying funds: this is approximately 16 payments. Do not stop early.
- Quarterly-paying funds: approximately 5 payments.
- List ALL of them. Do not summarise or truncate.
- For 2025 payments that are estimated, set confidence to "low".

━━ INCOME CODES ━━
"01" = Interest → BIL, SHV, SGOV, USFR, AGG, BND, TIP, VTIP, SCHP, JPST, NEAR and all T-bill/bond ETFs
"06" = Ordinary dividend → SPY, IVV, VOO, QQQ, VTI, VYM, SCHD and all equity ETFs
"37" = Other/option premium → ALL YieldMax ETFs (TSLY, NVDY, MSFO, AMZY, GOOGY, SMCY, MARO, SNOY, CONY, NVOY, APLY, JPMO etc), JEPI, JEPQ, GPIX, XDTE, QDTE
"40" = Return of capital

━━ RECLASSIFICATIONS ━━
Set reclassified:true if a payment's income character was restated after initial reporting (via 19a-1 or Form 8937).
A payment can be split across two codes — list both as separate components with individual per-share amounts.
Report the final restated character, not the original.

Return ONLY the JSON object. No explanation, no markdown, nothing before or after the JSON:

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
  "reclassification_notes": "explanation of reclassification risk and any known reclassification history"
}`;
}
