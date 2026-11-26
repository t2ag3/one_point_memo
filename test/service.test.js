// 地獄級の API（lib/service.js と functions/api/hell/*.js）の流れを、偽物の OpenRouter で確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";

import { onRequestPost as startFn } from "../functions/api/hell/index.js";
import data from "../lib/data.js";
import * as service from "../lib/service.js";
import { sign, verify } from "../lib/token.js";
import { fakeD1, fakeOpenRouter, steadyRandom } from "./helpers.js";

const SECRET = "test-secret-0123456789abcdef";
const say = (text) => ({ say: text, asks: [], missing_in_answer: [] });
const GRADE = {
  claims: [{ text: "約20年", verdict: "correct", evidence: "" }],
  targets: [{ id: "T1", status: "covered" }, { id: "T2", status: "partial" }],
  delivery: [3, 2, 1, 0], good: ["結論が先"], missing: ["数"], model_answer: "模範", evidence: [], one_line: "あと一歩",
};

function envWith(f, extra = {}) {
  return { SESSION_SECRET: SECRET, OPENROUTER_API_KEY: "k", FETCH: f.fetch, RANDOM: steadyRandom(), ...extra };
}

test("始める → 回答 → 追加の質問 → 回答 → 採点", async () => {
  const f = fakeOpenRouter(say("食育の法律が変わったそうですね？"), say("ありがとう。計画はいつ決まった？"), GRADE);
  const env = envWith(f);
  const s = await service.start({ genres: ["09"], consultants: 1 }, env, "1.1.1.1");
  assert.equal(s.view.consultants[0].status, "answer1");
  assert.equal(s.view.consultants[0].turns[0].text, "食育の法律が変わったそうですね？");
  assert.ok(!JSON.stringify(s.view).includes("evidence"), "採点の前に、聞かせる事実を見せない");
  assert.match(f.calls[0].body.messages[0].content, /<persona>[\s\S]*<memo genre="国民の理解醸成"/);

  let r = await service.answer({ token: s.tokens[0], text: "約20年ぶりの改正です。" }, env, "1.1.1.1");
  assert.equal(r.consultant.status, "answer2");
  const follow = f.calls[1].body.messages;
  assert.match(follow[1].content, /職員：<answer>約20年ぶりの改正です。<\/answer>/);
  assert.ok(!follow[0].content.includes("約20年ぶりの改正です"), "回答は system に入れない");

  r = await service.answer({ token: r.token, text: "令和8年です。" }, env, "1.1.1.1");
  assert.equal(r.consultant.status, "grading");
  assert.equal(f.calls.length, 2, "2 回目の回答では AI を呼ばない");

  const g = await service.grade({ token: r.token }, env, "1.1.1.1");
  assert.equal(g.grade.total, 40 + 15 + 15);
  assert.equal(g.source.pdf_url, "pdf/09.pdf#page=1");
  assert.equal(g.source.image_url, data.images ? "pages/09/1.png" : "");
  assert.equal(g.grade.targets.length, 3);
});

test("順番の違い・書き換え・期限切れ・並べ替えを断る", async () => {
  const f = fakeOpenRouter(say("相談"));
  const env = envWith(f);
  const r = await service.start({ consultants: 2 }, env, "ip");
  const [token] = r.tokens;
  await assert.rejects(service.grade({ token }, env, "ip"), (e) => e.status === 409);
  const [body, sig] = token.split(".");
  const forged = body.slice(0, -2) + (body.endsWith("A") ? "BB" : "AA") + "." + sig;
  await assert.rejects(service.answer({ token: forged, text: "x" }, env, "ip"), (e) => e.name === "TokenError");
  await assert.rejects(service.viewOf({ tokens: r.tokens }, { SESSION_SECRET: "another-secret-0123456789" }), (e) => e.name === "TokenError");
  await assert.rejects(service.viewOf({ tokens: [...r.tokens].reverse() }, env), (e) => e.status === 400);
  await assert.rejects(service.viewOf({ token }, env), (e) => e.status === 400);
  const before = await sign({ v: 1, cs: [] }, SECRET); // 相談者ごとに分ける前の形
  await assert.rejects(service.answer({ token: before, text: "x" }, env, "ip"), /最初から始めてください/);
  const old = await sign({ v: 2, i: 0, turns: [] }, SECRET, Date.now() - 3 * 60 * 60 * 1000);
  await assert.rejects(verify(old, SECRET), /時間がたった/);
  assert.equal((await service.viewOf({ tokens: r.tokens }, env)).view.consultants.length, 2);
});

test("答えになる数値を先に言ったら、言い直させる", async () => {
  const f = fakeOpenRouter(say("約20年ぶりの改正だそうですね。"), say("法律が変わったそうですね。"));
  const r = await service.start({ genres: ["09"], consultants: 1 }, envWith(f), "ip");
  assert.equal(r.view.consultants[0].turns[0].text, "法律が変わったそうですね。");
  assert.match(f.calls[1].body.messages[1].content, /答えになる数値（20）/);
});

test("空の回答は、AI を呼ばずに 0 点", async () => {
  const f = fakeOpenRouter(say("相談1"), say("相談2"));
  const env = envWith(f);
  const s = await service.start({ genres: ["09"], consultants: 1 }, env, "ip");
  let r = await service.answer({ token: s.tokens[0], text: "" }, env, "ip");
  r = await service.answer({ token: r.token, text: "わかりません。" }, env, "ip");
  const g = await service.grade({ token: r.token }, env, "ip");
  assert.equal(g.grade.total, 0);
  assert.equal(f.calls.length, 2);
});

test("始めるときは 1 人目の相談だけを作る。2 人目からは、1 人目と話している間に作れる", async () => {
  const f = fakeOpenRouter(say("相談です"));
  const env = envWith(f);
  const r = await service.start({ consultants: 3 }, env, "ip");
  assert.equal(f.calls.length, 1, "始めるときに待たせるのは 1 人分");
  assert.deepEqual(r.view.consultants.map((c) => [c.index, c.status]), [[0, "answer1"], [1, "opening"], [2, "opening"]]);
  // 別の相談者への要求は同時に送ってよい（トークンが相談者ごとに分かれている）
  const [a, b, c] = await Promise.all([
    service.answer({ token: r.tokens[0], text: "回答です。" }, env, "ip"),
    service.answer({ token: r.tokens[1] }, env, "ip"),
    service.answer({ token: r.tokens[2] }, env, "ip"),
  ]);
  assert.deepEqual([a, b, c].map((x) => [x.consultant.index, x.consultant.status]), [[0, "answer2"], [1, "answer1"], [2, "answer1"]]);
  const v = await service.viewOf({ tokens: [a.token, b.token, c.token] }, env);
  assert.deepEqual(v.view.consultants.map((x) => x.turns.length), [3, 1, 1]);
  assert.equal(f.calls.length, 4);
});

test("2 人目の最初の相談が失敗しても、あとで作り直せる", async () => {
  const f = fakeOpenRouter(say("相談です"), { status: 429 }, say("作り直した相談"));
  const env = envWith(f);
  const r = await service.start({ consultants: 2 }, env, "ip");
  await assert.rejects(service.answer({ token: r.tokens[1] }, env, "ip"), (e) => e.status === 429);
  const again = await service.answer({ token: r.tokens[1] }, env, "ip");
  assert.equal(again.consultant.turns[0].text, "作り直した相談");
});

test("回数制限（D1）を超えたら 429", async () => {
  const f = fakeOpenRouter(say("相談"));
  const env = envWith(f, { DB: fakeD1(), DAILY_LIMIT_PER_IP: "1" });
  const r = await service.start({ genres: ["09"], consultants: 1 }, env, "ip");
  await assert.rejects(service.answer({ token: r.tokens[0], text: "x" }, env, "ip"), (e) => e.status === 429);
});

test("Functions の入口：JSON の応答とエラー", async () => {
  const f = fakeOpenRouter(say("相談"));
  const call = (body) => startFn({ request: new Request("https://dojo.example/api/hell", { method: "POST", body }),
    env: envWith(f, { TURNSTILE_SECRET: "s" }) });
  let res = await call(JSON.stringify({ genres: ["09"], consultants: 1, turnstile: "good" }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).tokens.length, 1);
  res = await call(JSON.stringify({ genres: ["09"], consultants: 1, turnstile: "bad" }));
  assert.equal(res.status, 403);
  res = await call("JSON ではない");
  assert.equal(res.status, 400);
  res = await call(JSON.stringify({ consultants: 9 }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /1〜5 人/);
});
