// Outperform Institute Diagnostic — Secure API Handler
// Netlify Function: /netlify/functions/api
// All API keys live in Netlify environment variables — never in the browser

const AIRTABLE_BASE_ID   = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY   = process.env.AIRTABLE_API_KEY;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  switch (body.action) {
    case 'save':      return handleSave(body);
    case 'narrative': return handleNarrative(body);
    case 'notify':    return handleNotify(body);
    default:          return json(400, { error: 'Unknown action' });
  }
};

// ── SAVE TO AIRTABLE ─────────────────────────────────────────────
async function handleSave({ fields }) {
  if (!fields?.Email) return json(400, { error: 'Email required' });
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Diagnostic%20Responses`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, typecast: true }),
      }
    );
    const data = await res.json();
    if (!res.ok) return json(502, { error: 'Airtable error', detail: data });
    return json(200, { success: true, recordId: data.id });
  } catch (e) {
    return json(500, { error: e.message });
  }
}

// ── CLAUDE NARRATIVE ─────────────────────────────────────────────
async function handleNarrative({ contactData, pillarScores, overall, scores, pillars }) {
  const scoreDetails = pillars.map((p, i) => {
    const qLines = p.questions.map(q => {
      const raw = scores[`${p.id}_${q.id}`] || 3;
      return `    - ${q.label}: ${raw}/5 (scaled: ${(raw*2).toFixed(1)}/10)`;
    }).join('\n');
    return `${p.name} (${pillarScores[i].toFixed(1)}/10, weight ${Math.round(p.weight*100)}%):\n${qLines}`;
  }).join('\n\n');

  const prompt = buildPrompt(contactData, pillarScores, overall, scoreDetails);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20251022',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return json(502, { error: 'Claude error', detail: data });
    return json(200, { success: true, narrative: data.content[0].text });
  } catch (e) {
    return json(500, { error: e.message });
  }
}

// ── ZAPIER NOTIFY ────────────────────────────────────────────────
async function handleNotify(payload) {
  if (!ZAPIER_WEBHOOK_URL) return json(200, { success: true, skipped: true });
  const body = Object.entries(payload.data)
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  try {
    await fetch(ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return json(200, { success: true });
  } catch (e) {
    return json(500, { error: e.message });
  }
}

// ── PROMPT ───────────────────────────────────────────────────────
function buildPrompt(c, pillarScores, overall, scoreDetails) {
  return `You are a senior sales performance advisor at Outperform Institute. Write a direct, practitioner-to-practitioner diagnostic narrative for this sales leader. No hedging. Call out what the scores actually mean.

RESPONDENT: ${c.firstName} ${c.lastName}, ${c.title} at ${c.company}
Team: ${c.teamSize} reps | ARR: ${c.arr} | Industry: ${c.industry}

OVERALL SCORE: ${overall.toFixed(1)}/10

${scoreDetails}

PILLAR WEIGHTS: Control 25%, Define/Shape/Enlighten 20% each, Excite 15%

Write five sections with ALL CAPS headers:

EXECUTIVE SUMMARY (2-3 sentences): What does ${overall.toFixed(1)} mean for ${c.company}? Systems or heroics?

WHERE THE WEIGHT IS (3-4 sentences): Which 1-2 pillars are creating the most drag? Name downstream business consequences — forecast variance, pipeline quality, rep spread.

STRUCTURAL PATTERN: Name the archetype. Examples: "Motivated team, no execution discipline" / "Fired up with nowhere to go" / "Strong strategy, weak execution layer"

THE LOAD-BEARING REPAIRS (3-4 sentences): Top 2-3 highest-leverage fixes, sequenced. What breaks first if they don't act?

THE HONEST CLOSE (2 sentences): Direct statement about what stands between now and where they need to be. Actionable, not discouraging.

Tone: Direct operator. Short sentences. Strong verbs. No "moreover", "furthermore", "essentially", "basically", "delve".`;
}

function json(status, data) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

// Note: The 'notify' action sends both the internal notification to Brian
// AND (when send_to_prospect=true) triggers Zapier to email the prospect.
// Set up a second Zap at the same webhook that checks for prospect_email field
// and sends the email_body to that address.
