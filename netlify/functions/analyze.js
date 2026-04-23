// QI Tracker — Netlify serverless function v4
// Supports split reclassifications, per-share amounts, correct record vs payment dates

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

    const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [{ role: "user", content: buildPrompt(ticker, isin, name) }],
      }),
    });

    const rawText = await apiResponse.text();

    if (!apiResponse.ok) {
      let errMsg = "Anthropic API error (HTTP " + apiResponse.status + ")";
      try { errMsg = JSON.parse(rawText).error?.message || errMsg; } catch (_) {}
      return { statusCode: apiResponse.status, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: errMsg }) };
    }

    let data;
    try { data = JSON.parse(rawText); }
    catch (e) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "Cannot parse Anthropic envelope: " + e.message }) };
    }

    const textContent = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    if (!textContent) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "No text in response. stop_reason=" + (data.stop_reason || "?") }) };
    }

    const start = textContent.indexOf("{");
    const end   = textContent.lastIndexOf("}");

    if (start === -1) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "No JSON found: " + textContent.slice(0, 200) }) };
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
    ticker, isin,
    fund_name: name || ticker,
    fund_manager: "", strategy: "", distributions: [],
    reclassification_risk: "unknown",
    reclassification_notes: "Response was truncated — partial data only.",
    _truncated: true,
  };
  const fields = ["fund_name", "fund_manager", "strategy", "reclassification_risk", "reclassification_notes"];
  fields.forEach(f => {
    const m = partial.match(new RegExp('"' + f + '"\\s*:\\s*"([^"]*)"'));
    if (m) result[f] = m[1];
  });
  return result;
}

function buildPrompt(ticker, isin, name) {
  return `You are a QI (qualified intermediary) tax specialist. Analyze this US ETF's distributions and provide detailed income classification including per-share amounts and any reclassifications.

ETF: ${ticker}${isin ? " | ISIN: " + isin : ""}${name ? " | " + name : ""}

CRITICAL DEFINITIONS:
- RECORD DATE: The date an investor must be on the shareholder register to receive the distribution. This is typically 1 business day AFTER the ex-dividend date.
- PAYMENT DATE: The date the cash is actually paid to shareholders. This is typically 1-2 weeks after the record date.
- These are DIFFERENT dates. Do NOT confuse them.

INCOME CODE RULES:
- "01" = Interest income → T-bill ETFs (BIL, SHV, SGOV, USFR), bond ETFs (AGG, BND, TIP, VTIP, SCHP, JPST, NEAR)
- "06" = Ordinary dividend → equity ETFs (SPY, IVV, VOO, QQQ, VTI, VYM, SCHD, DVY)
- "37" = Other income / option premium → ALL YieldMax ETFs (TSLY, NVDY, MSFO, AMZY, GOOGY, SMCY, MARO, SNOY, CONY, NVOY, APLY, JPMO, etc.), JEPI, JEPQ, GPIX, XDTE, QDTE, and any covered-call or option-income ETF
- "40" = Return of capital

RECLASSIFICATION RULES:
- A reclassification occurs when a fund restates the income character of a distribution after it was initially reported
- This is common at year-end via 19a-1 notices or SEC Form 8937 filings
- A distribution can be SPLIT across two income codes (e.g. 60% Code 37 + 40% Code 06)
- For each distribution, report the FINAL restated income character (after any reclassification)
- Set "reclassified": true if the initial reporting was later changed

PER-SHARE AMOUNTS:
- Provide the per-share distribution amount in USD where known
- For split distributions, provide the per-share amount for EACH component
- If the exact amount is not known, set to null and note confidence as "low"

List distributions for 2025 only (Jan–Apr 2025 actual, May–Dec 2025 estimated based on fund's typical schedule).

Return ONLY a valid JSON object, no other text:
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
}

EXAMPLE of a split reclassification entry:
{
  "record_date": "2025-01-31",
  "payment_date": "2025-02-07",
  "total_per_share": 0.8500,
  "components": [
    {"income_code": "37", "income_type": "Option Premium", "per_share": 0.6800, "percentage": 80},
    {"income_code": "40", "income_type": "Return of Capital", "per_share": 0.1700, "percentage": 20}
  ],
  "reclassified": true,
  "confidence": "medium",
  "notes": "Initially reported as 100% Code 37; restated via 19a-1 notice to include ROC component"
}`;
}    }

    const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [{ role: "user", content: buildPrompt(ticker, isin, name) }],
      }),
    });

    const rawText = await apiResponse.text();

    if (!apiResponse.ok) {
      let errMsg = "Anthropic API error (HTTP " + apiResponse.status + ")";
      try { errMsg = JSON.parse(rawText).error?.message || errMsg; } catch (_) {}
      return { statusCode: apiResponse.status, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: errMsg }) };
    }

    let data;
    try { data = JSON.parse(rawText); }
    catch (e) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "Cannot parse Anthropic envelope: " + e.message }) };
    }

    const textContent = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    if (!textContent) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "No text in response. stop_reason=" + (data.stop_reason || "?") }) };
    }

    const start = textContent.indexOf("{");
    const end   = textContent.lastIndexOf("}");

    if (start === -1) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
               body: JSON.stringify({ error: "No JSON found in response: " + textContent.slice(0, 200) }) };
    }

    let result;

    if (end > start) {
      // Normal case — try to parse the full JSON
      try {
        result = JSON.parse(textContent.slice(start, end + 1));
      } catch (_) {
        // JSON is malformed — try to recover the partial object
        result = recoverPartialJson(textContent.slice(start), ticker, isin, name);
      }
    } else {
      // end <= start means truncated — recover partial
      result = recoverPartialJson(textContent.slice(start), ticker, isin, name);
    }

    return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" },
             body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" },
             body: JSON.stringify({ error: "Function error (" + ticker + "): " + err.message }) };
  }
};

// Attempt to recover usable data from a truncated/broken JSON string
function recoverPartialJson(partial, ticker, isin, name) {
  const result = {
    ticker: ticker,
    isin: isin,
    fund_name: name || ticker,
    fund_manager: "",
    strategy: "",
    distributions: [],
    reclassification_risk: "unknown",
    reclassification_notes: "Response was truncated — partial data recovered.",
    _truncated: true,
  };

  // Extract simple string fields
  const fields = ["fund_name", "fund_manager", "strategy", "reclassification_risk", "reclassification_notes"];
  fields.forEach(field => {
    const m = partial.match(new RegExp('"' + field + '"\\s*:\\s*"([^"]*)"'));
    if (m) result[field] = m[1];
  });

  // Extract any complete distribution objects
  const distPattern = /\{[^{}]*"record_date"[^{}]*"income_code"[^{}]*\}/g;
  const distMatches = partial.match(distPattern) || [];
  distMatches.forEach(distStr => {
    try {
      const d = JSON.parse(distStr);
      if (d.record_date && d.income_code) result.distributions.push(d);
    } catch (_) {}
  });

  return result;
}

function buildPrompt(ticker, isin, name) {
  return `You are a QI (qualified intermediary) tax specialist. Classify the income type for this US ETF's distributions.

ETF: ${ticker}${isin ? " | ISIN: " + isin : ""}${name ? " | " + name : ""}

IMPORTANT: Return ONLY a JSON object. No explanation, no markdown, no text before or after the JSON.

Use these QI income codes:
- "01" = Interest (T-bills, bonds, money market) → BIL, SHV, SGOV, USFR, AGG, BND, TIP, VTIP, SCHP, JPST, NEAR
- "06" = Ordinary dividend (equity dividends) → SPY, IVV, VOO, QQQ, VTI, VYM, SCHD, DVY
- "37" = Other income / option premium → ALL YieldMax ETFs (TSLY, NVDY, MSFO, AMZY, GOOGY, SMCY, MARO, SNOY, CONY, NVOY, APLY, MSFO, JPMO etc.), JEPI, JEPQ, GPIX, XDTE, QDTE, any covered-call or option-income ETF
- "40" = Return of capital → ROC distributions

List distributions for 2025 only (Jan–Apr 2025 confirmed, May–Dec 2025 estimated). Monthly payers: list every month. Quarterly payers: list each quarter. Use last business day of each month as the record date.

JSON format (return this exactly, filled in):
{
  "ticker": "${ticker}",
  "isin": "${isin || ""}",
  "fund_name": "full name",
  "fund_manager": "manager name",
  "strategy": "one-line description",
  "distributions": [
    {
      "record_date": "2025-01-31",
      "income_type": "e.g. T-Bill Interest",
      "income_code": "01",
      "confidence": "high",
      "reclassified": false,
      "notes": ""
    }
  ],
  "reclassification_risk": "low",
  "reclassification_notes": "brief explanation"
}`;
}
