// QI Tracker — Netlify serverless function v6
// Uses Anthropic built-in web search, Node https module

const https = require("https");

function apiPost(apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": apiKey,
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

    // First attempt: with web search
    let result = await callClaude(apiKey, ticker, isin, name, true);

    // If web search failed (e.g. tool not available), fall back to training knowledge
    if (result.error && result.useTraining) {
      result = await callClaude(apiKey, ticker, isin, name, false);
    }

    if (result.error) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: result.error }) };
    }

    return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" },
             body: JSON.stringify(result.data) };

  } catch (err) {
    return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
             body: JSON.stringify({ error: "Function error (" + ticker + "): " + err.message }) };
  }
};

async function callClaude(apiKey, ticker, isin, name, useWebSearch) {
  const requestBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: buildPrompt(ticker, isin, name, useWebSearch) }],
  };

  if (useWebSearch) {
    requestBody.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  const response = await apiPost(apiKey, requestBody);

  if (response.status < 200 || response.status >= 300) {
    let errMsg = "Anthropic API error (HTTP " + response.status + ")";
    try {
      const parsed = JSON.parse(response.body);
      errMsg = parsed.error?.message || errMsg;
      // If error mentions the tool is not available, signal fallback
      if (useWebSearch && (errMsg.includes("tool") || errMsg.includes("web_search") || response.status === 400)) {
        return { error: errMsg, useTraining: true };
      }
    } catch (_) {}
    return { error: errMsg };
  }

  let data;
  try { data = JSON.parse(response.body); }
  catch (e) { return { error: "Cannot parse Anthropic response: " + e.message }; }

  // Extract all text content blocks (skip tool_use, tool_result blocks)
  const textContent = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (!textContent) {
    const types = (data.content || []).map(b => b.type).join(", ");
    // If web search was used but produced no text, try falling back
    if (useWebSearch) {
      return { error: "No text in response (types: " + types + ")", useTraining: true };
    }
    return { error: "No text in response. stop_reason=" + (data.stop_reason || "?") + " types=" + types };
  }

  // Find the JSON object — look for the LAST { } block as that's the final answer
  const lastBrace = textContent.lastIndexOf("}");
  if (lastBrace === -1) {
    return { error: "No JSON found in response: " + textContent.slice(0, 200) };
  }

  // Walk backwards from the last } to find its matching {
  let depth = 0;
  let jsonStart = -1;
  for (let i = lastBrace; i >= 0; i--) {
    if (textContent[i] === "}") depth++;
    else if (textContent[i] === "{") {
      depth--;
      if (depth === 0) { jsonStart = i; break; }
    }
  }

  if (jsonStart === -1) {
    return { error: "Cannot find JSON boundaries in response" };
  }

  let parsed;
  try {
    parsed = JSON.parse(textContent.slice(jsonStart, lastBrace + 1));
  } catch (_) {
    parsed = recoverPartialJson(textContent.slice(jsonStart), ticker, isin, name);
  }

  return { data: parsed };
}

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

function buildPrompt(ticker, isin, name, useWebSearch) {
  const searchInstruction = useWebSearch
    ? `Search the web for the following information about this ETF:
1. All distribution payments made in 2025 with their exact record dates and payment dates
2. Per-share distribution amounts for each payment
3. SEC EDGAR Form 8937 filings for this fund (search "site:sec.gov 8937 ${ticker}")
4. Any 19a-1 notices or tax character announcements from the fund company
5. Any year-end income reclassification announcements

Use multiple searches to gather accurate data before producing your answer.`
    : `Use your training knowledge to provide the best available information about this ETF's 2025 distributions.`;

  return `You are a QI (qualified intermediary) tax specialist. Analyze this US ETF's distributions and provide detailed income classification including per-share amounts and any reclassifications.

ETF: ${ticker}${isin ? " | ISIN: " + isin : ""}${name ? " | " + name : ""}

${searchInstruction}

CRITICAL DEFINITIONS:
- RECORD DATE: The date an investor must appear on the shareholder register to receive the distribution. Typically 1 business day AFTER the ex-dividend date, and always BEFORE the payment date.
- PAYMENT DATE: The actual cash payment date, typically 1-2 weeks after the record date.
- Do NOT confuse these two dates. They are always different.

INCOME CODE RULES:
- "01" = Interest income → T-bill ETFs (BIL, SHV, SGOV, USFR), bond ETFs (AGG, BND, TIP, VTIP, SCHP, JPST, NEAR)
- "06" = Ordinary dividend → equity ETFs (SPY, IVV, VOO, QQQ, VTI, VYM, SCHD, DVY)
- "37" = Other income / option premium → ALL YieldMax ETFs (TSLY, NVDY, MSFO, AMZY, GOOGY, SMCY, MARO, SNOY, CONY, NVOY, APLY, JPMO, etc.), JEPI, JEPQ, GPIX, XDTE, QDTE, and any covered-call or option-income ETF
- "40" = Return of capital

RECLASSIFICATION:
- A reclassification occurs when a fund restates the income character after initial reporting (via 19a-1 or Form 8937)
- A single distribution can be SPLIT across two codes (e.g. 70% Code 37 + 30% Code 40)
- Report the FINAL restated character; set "reclassified": true if original was changed
- Include the per-share amount for each component of a split

List distributions for 2025 only. Return ONLY the JSON object below — no explanation, no markdown, no text before or after:

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
