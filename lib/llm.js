// AI（OpenRouter）を呼び、決まった形の JSON を受け取る。
// 無料のモデルには JSON の形の指定（response_format）に対応していないものがあるので、
// 指示文でも JSON を求め、答えから取り出して形を確かめる。崩れていたら理由を添えて 1 回だけ聞き直す（ai.py と同じ）。
//
// 設定（wrangler.toml の vars か、Cloudflare の画面の環境変数）：
//   MODEL_CONSULT / MODEL_GRADE  相談者・採点のモデル（省くと DEFAULT_MODEL）
//   MODEL_FALLBACKS              予備のモデル（カンマ区切り。最初のモデルが使えないとき OpenRouter が順に試す）
//   JSON_SCHEMA                  "0" で response_format を送らない
//   REASONING_CONSULT / REASONING_GRADE  "low"・"medium"・"high"（考える深さ。対応しているモデルだけ。省くと送らない）
//   MAX_TOKENS                   答えの長さの上限（省くと 4000）
//   OPENROUTER_API_KEY           秘密の値（wrangler pages secret put で入れる）

export const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 90 * 1000;

export class LlmError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

// 答えの形の説明（指示文の最後に付ける）
function jsonInstruction(schema) {
  return "\n\n出力は、次の JSON Schema に合う JSON オブジェクト 1 つだけにしてください（前後に説明や ``` を付けない）。\n"
    + JSON.stringify(schema);
}

// AI の答えから JSON のオブジェクトを取り出す（前後に説明や ``` が付いていても読む）
export function parseJson(text) {
  if (!text || !String(text).trim()) throw new Error("答えが空です");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("JSON が見つかりません");
    try { data = JSON.parse(m[0]); } catch (e) { throw new Error(e.message); }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("JSON のオブジェクトではありません");
  return data;
}

// JSON Schema のうち、ここで使う分（type・properties・required・items・enum）だけを確かめる
export function schemaProblem(schema, value, path = "答え") {
  const t = schema.type;
  if (t === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} がオブジェクトではありません`;
    for (const key of schema.required || []) if (!(key in value)) return `${path} に ${key} がありません`;
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) {
        const p = schemaProblem(sub, value[key], `${path}.${key}`);
        if (p) return p;
      }
    }
    return null;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return `${path} が配列ではありません`;
    for (let i = 0; i < value.length; i++) {
      const p = schemaProblem(schema.items, value[i], `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (t === "string" && typeof value !== "string") return `${path} が文字列ではありません`;
  if (t === "integer" && !Number.isInteger(value)) return `${path} が整数ではありません`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} は ${schema.enum.join("・")} のどれかにしてください`;
  return null;
}

function modelsFor(env, kind) {
  const main = (kind === "grade" ? env.MODEL_GRADE : env.MODEL_CONSULT) || DEFAULT_MODEL;
  const fallbacks = String(env.MODEL_FALLBACKS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { main, fallbacks };
}

export function buildRequest(env, { kind, system, user, schema }) {
  const { main, fallbacks } = modelsFor(env, kind);
  const body = {
    model: main,
    messages: [{ role: "system", content: system }, { role: "user", content: user + jsonInstruction(schema) }],
    max_tokens: Number(env.MAX_TOKENS || 4000),
  };
  if (fallbacks.length) body.models = [main, ...fallbacks];
  if (env.JSON_SCHEMA !== "0") {
    body.response_format = { type: "json_schema", json_schema: { name: "answer", strict: true, schema } };
  }
  const effort = kind === "grade" ? env.REASONING_GRADE : env.REASONING_CONSULT;
  if (effort) body.reasoning = { effort };
  return body;
}

async function post(env, body) {
  if (!env.OPENROUTER_API_KEY) throw new LlmError("AI の設定（OPENROUTER_API_KEY）がありません。管理者に知らせてください。", 503);
  const doFetch = env.FETCH || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json",
        ...(env.SITE_URL ? { "HTTP-Referer": env.SITE_URL } : {}), "X-Title": "Hitokuchi Memo Dojo",
      },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
  } catch (e) {
    throw new LlmError(e.name === "AbortError" ? "AI の答えが時間内に返ってきませんでした。「やり直す」を押してください。"
      : `AI を呼び出せませんでした（${e.message}）`);
  } finally {
    clearTimeout(timer);
  }
  const payload = await res.json().catch(() => ({}));
  if (res.status === 429) throw new LlmError("AI が混み合っています（無料のモデルの回数の上限など）。少し待ってから「やり直す」を押してください。", 429);
  if (res.status === 401 || res.status === 403) throw new LlmError("AI の鍵の設定が正しくありません。管理者に知らせてください。", 503);
  if (res.status === 402) throw new LlmError("AI の利用の残高が足りません。管理者に知らせてください。", 503);
  if (!res.ok || payload.error) {
    const why = payload.error && payload.error.message ? payload.error.message : `状態 ${res.status}`;
    throw new LlmError(`AI を呼び出せませんでした（${why}）`);
  }
  const choice = (payload.choices || [])[0] || {};
  if (choice.finish_reason === "length") throw new LlmError("AI の答えが途中で切れました。「やり直す」を押してください。");
  const content = choice.message ? choice.message.content : "";
  return Array.isArray(content) ? content.map((c) => c.text || "").join("") : String(content || "");
}

// kind：「consult」か「grade」。check(data) はおかしければ理由の文字列を返す関数（省いてよい）
export async function callJson(env, { kind, system, user, schema, check }) {
  let problem = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ask = problem === null ? user
      : `${user}\n前回の出力には次の問題がありました：${problem}\n指定の JSON の形で、もう一度出力してください。`;
    const text = await post(env, buildRequest(env, { kind, system, user: ask, schema }));
    let data;
    try {
      data = parseJson(text);
    } catch (e) {
      problem = `JSON として読めません（${e.message}）`;
      continue;
    }
    problem = schemaProblem(schema, data) || (check ? check(data) : null);
    if (problem === null) return data;
  }
  throw new LlmError(`AI の答えの形が正しくありませんでした（${problem}）。「やり直す」を押してください。`);
}
