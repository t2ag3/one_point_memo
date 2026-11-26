// OpenRouter の呼び出し（lib/llm.js）と守り（lib/guard.js）を、偽物で確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkTurnstile, countUse, today } from "../lib/guard.js";
import { buildRequest, callJson, DEFAULT_MODEL, parseJson, schemaProblem } from "../lib/llm.js";
import { CONSULT_SCHEMA, GRADE_SCHEMA } from "../lib/prompts.js";
import { fakeD1, fakeOpenRouter } from "./helpers.js";

const SAY = { say: "相談です。", asks: ["T1"], missing_in_answer: [] };
const env = (extra = {}) => ({ OPENROUTER_API_KEY: "test-key", ...extra });

test("JSON の取り出し", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('説明です\n```json\n{"a": [1, 2]}\n```\n以上'), { a: [1, 2] });
  assert.throws(() => parseJson(""), /空/);
  assert.throws(() => parseJson("[1,2]"), /オブジェクトではありません|JSON が見つかりません/);
});

test("形の確かめ（必須・型・選べる値）", () => {
  assert.equal(schemaProblem(CONSULT_SCHEMA, SAY), null);
  assert.match(schemaProblem(CONSULT_SCHEMA, { say: "x", asks: [] }), /missing_in_answer がありません/);
  assert.match(schemaProblem(CONSULT_SCHEMA, { ...SAY, asks: "T1" }), /asks が配列ではありません/);
  const g = { claims: [{ text: "x", verdict: "maybe", evidence: "" }], targets: [], delivery: [1.5], good: [], missing: [],
    model_answer: "", evidence: [], one_line: "" };
  assert.match(schemaProblem(GRADE_SCHEMA, g), /verdict は correct/);
});

test("要求の形：既定のモデル、予備、JSON の形、考える深さ", () => {
  const body = buildRequest(env(), { kind: "consult", system: "S", user: "U", schema: CONSULT_SCHEMA });
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.messages[0].content, "S");
  assert.ok(body.messages[1].content.startsWith("U\n\n出力は、次の JSON Schema"));
  assert.equal(body.response_format.json_schema.schema, CONSULT_SCHEMA);
  assert.ok(!("models" in body) && !("reasoning" in body));
  const b2 = buildRequest(env({ MODEL_GRADE: "a/b", MODEL_FALLBACKS: "c/d, e/f", JSON_SCHEMA: "0", REASONING_GRADE: "medium" }),
    { kind: "grade", system: "S", user: "U", schema: GRADE_SCHEMA });
  assert.equal(b2.model, "a/b");
  assert.deepEqual(b2.models, ["a/b", "c/d", "e/f"]);
  assert.ok(!("response_format" in b2));
  assert.deepEqual(b2.reasoning, { effort: "medium" });
});

test("崩れた答えは 1 回だけ聞き直す", async () => {
  const f = fakeOpenRouter("JSON ではない", SAY);
  const data = await callJson(env({ FETCH: f.fetch }), { kind: "consult", system: "S", user: "U", schema: CONSULT_SCHEMA });
  assert.deepEqual(data, SAY);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].body.messages[1].content, /前回の出力には次の問題がありました：JSON として読めません/);
  assert.equal(f.calls[0].headers.Authorization, "Bearer test-key");
});

test("2 回崩れたら、画面に出せる理由つきで失敗", async () => {
  const f = fakeOpenRouter({ say: 1 }, { say: 2 });
  await assert.rejects(callJson(env({ FETCH: f.fetch }), { kind: "consult", system: "S", user: "U", schema: CONSULT_SCHEMA }),
    (e) => e.name === "LlmError" && /形が正しくありませんでした/.test(e.message) && e.status === 502);
});

test("失敗の種類ごとの理由", async () => {
  const call = (status) => callJson(env({ FETCH: fakeOpenRouter({ status }).fetch }),
    { kind: "consult", system: "S", user: "U", schema: CONSULT_SCHEMA });
  await assert.rejects(call(429), (e) => e.status === 429 && /混み合っています/.test(e.message));
  await assert.rejects(call(401), (e) => e.status === 503 && /鍵の設定/.test(e.message));
  await assert.rejects(call(402), (e) => e.status === 503 && /残高/.test(e.message));
  await assert.rejects(call(500), (e) => e.status === 502);
  await assert.rejects(callJson({}, { kind: "consult", system: "S", user: "U", schema: CONSULT_SCHEMA }),
    (e) => e.status === 503 && /OPENROUTER_API_KEY/.test(e.message));
});

test("Turnstile：設定がなければ確かめない。あれば確かめる", async () => {
  await checkTurnstile({}, undefined, "1.2.3.4");
  const f = fakeOpenRouter(SAY);
  const e = { TURNSTILE_SECRET: "s", FETCH: f.fetch };
  await checkTurnstile(e, "good", "1.2.3.4");
  await assert.rejects(checkTurnstile(e, "bad", "1.2.3.4"), (x) => x.status === 403);
  await assert.rejects(checkTurnstile(e, "", "1.2.3.4"), (x) => x.status === 403);
});

test("1 日の回数制限（接続元ごと・全体）。接続元はハッシュにして保存する", async () => {
  const db = fakeD1();
  const e = { DB: db, DAILY_LIMIT_PER_IP: "2", DAILY_LIMIT_TOTAL: "3", SESSION_SECRET: "x".repeat(16) };
  await countUse(e, "1.2.3.4");
  await countUse(e, "1.2.3.4");
  await assert.rejects(countUse(e, "1.2.3.4"), (x) => x.status === 429 && /2 回/.test(x.message));
  await countUse(e, "5.6.7.8");
  await assert.rejects(countUse(e, "9.9.9.9"), (x) => x.status === 429 && /全体/.test(x.message));
  assert.ok([...db.rows.keys()].every((k) => !k.includes("1.2.3.4")));
  await countUse({}, "1.2.3.4"); // D1 がなければ数えない
});

test("日付の区切りは日本時間", () => {
  assert.equal(today(Date.UTC(2026, 10, 26, 14, 59)), "2026-11-26");
  assert.equal(today(Date.UTC(2026, 10, 26, 15, 0)), "2026-11-27");
});
