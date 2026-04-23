// QI Tracker — Netlify serverless function v2
// Uses Claude training knowledge (no web search), comprehensive error handling

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
    isin = body.isin || "";
    name = body.name || "";

    const requiredPw = process.env.ACCESS_PASSWORD;
    if (requiredPw && body.password !== requiredPw) {
      return { statusCode: 401, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid access password" }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Netlify environment variables." }) };
    }
    if (!ticker) {
      return { statusCode: 400, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Ticker is required" }) };
    }

    // Call Anthropic API — no tools, pure model knowledge
    const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [{ role: "user", content: buildPrompt(ticker, isin, name) }],
      }),
    });

    const rawText = await apiResponse.text();

    if (!apiResponse.ok) {
      let errMsg = "Anthropic API returned HTTP " + apiResponse.status;
      try { errMsg = JSON.parse(rawText).error?.message || errMsg; } catch (_) {}
      return { statusCode: apiResponse.status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: errMsg }) };
    }

    let data;
    try { data = JSON.parse(rawText); }
    catch (e) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Cannot parse Anthropic response: " + e.message, raw: rawText.slice(0, 300) }) };
    }

    const textContent = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");

    if (!textContent) {
      const types = (data.content || []).map(b => b.type).join(", ");
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "No text in response. stop_reason=" + (data.stop_reason || "?") + " content_types=" + (types || "none") }) };
    }

    const start = textContent.indexOf("{");
    const end = textContent.lastIndexOf("}");

    if (start === -1) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "No JSON found. Model said: " + textContent.slice(0, 200) }) };
    }

    let result;
    try { result = JSON.parse(textContent.slice(start, end + 1)); }
    catch (e) {
      return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "JSON parse failed: " + e.message + ". Near: " + textContent.slice(start, start + 100) }) };
    }

    return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Function error (" + ticker + "): " + err.message }) };
  }
};

function buildPrompt(ticker, isin, name) {
  return `You are a qualified intermediary (QI) tax specialist with expert knowledge of US ETF income classification for withholding tax purposes.

Analyze this ETF using your training knowledge:
- Ticker: ${ticker}
- ISIN: ${isin || "not provided"}
${name ? `- Name: ${name}` : ""}

Determine the correct QI income codes for all distributions made in 2024 and 2025.

Income code rules:
- Code 01 = Interest income: T-bills, treasuries, bonds, money market. Use for: BIL, SHV, SGOV, USFR, JPST, AGG, BND, TIP, VTIP, SCHP, STIP, and all bond/treasury ETFs
- Code 06 = Ordinary dividend: equity dividends. Use for: SPY, IVV, VOO, QQQ, VTI, dividend ETFs like DVY, SDY, VYM, SCHD
- Code 37 = Other US source income: option premiums. Use for: ALL YieldMax ETFs (TSLY, NVDY, MSFO, AMZY, GOOGY, SMCY, MARO, SNOY, CONY, etc.), JEPI, JEPQ, GPIX, XDTE, QDTE, and any covered call / option income strategy ETF
- Code 40 = Return of capital: non-taxable return of principal

Key facts:
- YieldMax ETFs distribute option premium income — always Code 37 with high reclassification risk
- YieldMax and similar option ETFs pay monthly
- T-Bill ETFs (BIL, SHV, SGOV) pay monthly interest — Code 01
- Aggregate bond ETFs (AGG, BND) pay monthly interest — Code 01
- TIPS ETFs (TIP, VTIP, SCHP) pay monthly interest + inflation adjustment — Code 01
- JPST (JPMorgan Ultra-Short Income) pays monthly interest — Code 01
- Reclassification risk is HIGH for option income ETFs, MEDIUM for mixed strategy ETFs, LOW for pure bond/T-bill ETFs

For 2024 and 2025, list monthly distributions for monthly-paying funds (approximately 12 per year), or quarterly for quarterly-paying funds. Use the typical record dates (usually the last business day of each month for monthly payers).

Return ONLY a valid JSON object with absolutely no other text before or after it:
{
  "ticker": "${ticker}",
  "isin": "${isin || ""}",
  "fund_name": "full official name",
  "fund_manager": "investment manager",
  "strategy": "one-line strategy e.g. T-Bill ETF / Option Income ETF / Aggregate Bond ETF",
  "distributions": [
    {
      "record_date": "YYYY-MM-DD",
      "payment_date": "YYYY-MM-DD",
      "income_type": "e.g. T-Bill Interest / Option Premium / Ordinary Dividend / Return of Capital",
      "income_code": "01 or 06 or 37 or 40",
      "confidence": "high or medium or low",
      "source": "basis for this classification",
      "reclassified": false,
      "notes": ""
    }
  ],
  "reclassification_risk": "high or medium or low",
  "reclassification_notes": "explanation of reclassification risk specific to this fund"
}`;
}
