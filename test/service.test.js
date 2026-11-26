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
  let r = await service.start({ genres: ["09"], consultants: 1 }, env, "1.1.1.1");
  assert.equal(r.view.consultants[0].status, "answer1");
  assert.equal(r.view.consultants[0].turns[0].text, "食育の法律が変わったそうですね？");
  assert.ok(!JSON.stringify(r.view).includes("evidence"), "採点の前に、聞かせる事実を見せない");
  assert.match(f.calls[0].body.messages[0].content, /<persona>[\s\S]*<memo genre="国民の理解醸成"/);

  r = await service.answer({ token: r.token, index: 0, text: "約20年ぶりの改正です。" }, env, "1.1.1.1");
  assert.equal(r.view.consultants[0].status, "answer2");
  const follow = f.calls[1].body.messages;
  assert.match(follow[1].content, /職員：<answer>約20年ぶりの改正です。<\/answer>/);
  assert.ok(!follow[0].content.includes("約20年ぶりの改正です"), "回答は system に入れない");

  r = await service.answer({ token: r.token, index: 0, text: "令和8年です。" }, env, "1.1.1.1");
  assert.equal(r.view.consultants[0].status, "grading");
  assert.equal(f.calls.length, 2, "2 回目の回答では AI を呼ばない");

  const g = await service.grade({ token: r.token, index: 0 }, env, "1.1.1.1");
  assert.equal(g.grade.total, 40 + 15 + 15);
  assert.equal(g.source.pdf_url, "pdf/09.pdf#page=1");
  assert.equal(g.source.image_url, data.images ? "pages/09/1.png" : "");
  assert.equal(g.grade.targets.length, 3);
});

test("順番の違い・書き換え・期限切れを断る", async () => {
  const f = fakeOpenRouter(say("相談"));
  const env = envWith(f);
  const r = await service.start({ genres: ["09"], consultants: 1 }, env, "ip");
  await assert.rejects(service.grade({ token: r.token, index: 0 }, env, "ip"), (e) => e.status === 409);
  await assert.rejects(service.answer({ token: r.token, index: 3, text: "x" }, env, "ip"), (e) => e.status === 404);
  const [body, sig] = r.token.split(".");
  const forged = body.slice(0, -2) + (body.endsWith("A") ? "BB" : "AA") + "." + sig;
  await assert.rejects(service.answer({ token: forged, index: 0, text: "x" }, env, "ip"), (e) => e.name === "TokenError");
  await assert.rejects(service.viewOf({ token: r.token }, { SESSION_SECRET: "another-secret-0123456789" }), (e) => e.name === "TokenError");
  const old = await sign({ v: 1, cs: [] }, SECRET, Date.now() - 3 * 60 * 60 * 1000);
  await assert.rejects(verify(old, SECRET), /時間がたった/);
  assert.equal((await service.viewOf({ token: r.token }, env)).view.consultants.length, 1);
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
  let r = await service.start({ genres: ["09"], consultants: 1 }, env, "ip");
  r = await service.answer({ token: r.token, index: 0, text: "" }, env, "ip");
  r = await service.answer({ token: r.token, index: 0, text: "わかりません。" }, env, "ip");
  const g = await service.grade({ token: r.token, index: 0 }, env, "ip");
  assert.equal(g.grade.total, 0);
  assert.equal(f.calls.length, 2);
});

test("2 人目の最初の相談が失敗しても始められ、あとで作り直せる", async () => {
  const f = fakeOpenRouter(say("1 人目"), { status: 429 }, say("3 人目"), say("2 人目（作り直し）"));
  const env = envWith(f);
  let r = await service.start({ consultants: 3 }, env, "ip");
  assert.deepEqual(r.view.consultants.map((c) => c.status), ["answer1", "opening", "answer1"]);
  r = await service.answer({ token: r.token, index: 1 }, env, "ip");
  assert.equal(r.view.consultants[1].turns[0].text, "2 人目（作り直し）");
});

test("回数制限（D1）を超えたら 429", async () => {
  const f = fakeOpenRouter(say("相談"));
  const env = envWith(f, { DB: fakeD1(), DAILY_LIMIT_PER_IP: "1" });
  const r = await service.start({ genres: ["09"], consultants: 1 }, env, "ip");
  await assert.rejects(service.answer({ token: r.token, index: 0, text: "x" }, env, "ip"), (e) => e.status === 429);
});

test("Functions の入口：JSON の応答とエラー", async () => {
  const f = fakeOpenRouter(say("相談"));
  const call = (body) => startFn({ request: new Request("https://dojo.example/api/hell", { method: "POST", body }),
    env: envWith(f, { TURNSTILE_SECRET: "s" }) });
  let res = await call(JSON.stringify({ genres: ["09"], consultants: 1, turnstile: "good" }));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).token);
  res = await call(JSON.stringify({ genres: ["09"], consultants: 1, turnstile: "bad" }));
  assert.equal(res.status, 403);
  res = await call("JSON ではない");
  assert.equal(res.status, 400);
  res = await call(JSON.stringify({ consultants: 9 }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /1〜5 人/);
});
