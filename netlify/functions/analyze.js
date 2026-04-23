// QI Tracker — Netlify serverless function v5
// Uses Node built-in https module (no fetch dependency, works on all Node versions)

const https = require("https");

function apiPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Netlify environment variables." }) };
    }
    if (!ticker) {
      return { statusCode: 400, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "Ticker is required" }) };
    }

    const response = await apiPost({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: buildPrompt(ticker, isin, name) }],
    });

    if (response.status < 200 || response.status >= 300) {
      let errMsg = "Anthropic API error (HTTP " + response.status + ")";
      try { errMsg = JSON.parse(response.body).error?.message || errMsg; } catch (_) {}
      return { statusCode: response.status, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: errMsg }) };
    }

    let data;
    try { data = JSON.parse(response.body); }
    catch (e) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "Cannot parse Anthropic response: " + e.message }) };
    }

    const textContent = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (!textContent) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "No text in response. stop_reason=" + (data.stop_reason || "?") }) };
    }

    const start = textContent.indexOf("{");
    const end   = textContent.lastIndexOf("}");

    if (start === -1) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "No JSON in response: " + textContent.slice(0, 200) }) };
    }

    let result;
    try {
      result = JSON.parse(textContent.slice(start, end + 1));
    } catch (_) {
      result = recoverPartialJson(textContent.slice(start), ticker, isin, name);
    }

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

function buildPrompt(ticker, isin, name) {
  return `You are a QI (qualified intermediary) tax specialist. Analyze this US ETF's distributions and provide detailed income classification including per-share amounts and any reclassifications.

ETF: ${ticker}${isin ? " | ISIN: " + isin : ""}${name ? " | " + name : ""}

CRITICAL DEFINITIONS:
- RECORD DATE: The date an investor must be on the shareholder register to receive the distribution. This is typically 1 business day AFTER the ex-dividend date, and BEFORE the payment date.
- PAYMENT DATE: The date the cash is actually paid to shareholders. This is typically 1-2 weeks after the record date.
- These are DIFFERENT dates. Do NOT use the payment date as the record date.

INCOME CODE RULES:
- "01" = Interest income → T-bill ETFs (BIL, SHV, SGOV, USFR), bond ETFs (AGG, BND, TIP, VTIP, SCHP, JPST, NEAR)
- "06" = Ordinary dividend → equity ETFs (SPY, IVV, VOO, QQQ, VTI, VYM, SCHD, DVY)
- "37" = Other income / option premium → ALL YieldMax ETFs (TSLY, NVDY, MSFO, AMZY, GOOGY, SMCY, MARO, SNOY, CONY, NVOY, APLY, JPMO, etc.), JEPI, JEPQ, GPIX, XDTE, QDTE, and any covered-call or option-income ETF
- "40" = Return of capital

RECLASSIFICATION RULES:
- A reclassification occurs when a fund restates the income character of a distribution after initial reporting
- Common at year-end via 19a-1 notices or SEC Form 8937 filings
- A distribution can be SPLIT: e.g. 60% Code 37 + 40% Code 40
- Report the FINAL restated income character
- Set "reclassified": true if the initial reporting was later changed

PER-SHARE AMOUNTS:
- Provide the per-share USD amount where known from your training data
- For split distributions, provide per-share amount for EACH component
- If exact amount unknown, set to null and use confidence "low"

List distributions for 2025 only (Jan-Apr actual where known, May-Dec estimated).

Return ONLY valid JSON, no other text before or after:
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
