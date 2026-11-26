// 地獄級の API の本体。functions/api/hell/*.js から呼ぶ（テストからも直接呼べる）。
// 状態はトークンに入れて毎回返す。AI の呼び出しが途中で失敗しても、同じ要求を送り直せばやり直せる。

import * as consult from "./consult.js";
import data from "./data.js";
import { checkTurnstile, countUse } from "./guard.js";
import { HttpError } from "./http.js";
import { callJson } from "./llm.js";
import { sign, verify } from "./token.js";

const GENRES = Object.keys(data.genres);

// AI を 1 回呼ぶたびに、1 日の回数を数える
function llmFor(env, ip) {
  return async (request) => {
    await countUse(env, ip);
    return callJson(env, request);
  };
}

function rngFor(env) {
  return consult.makeRng(env.RANDOM || Math.random);
}

async function load(env, body) {
  const state = await verify(body.token, env.SESSION_SECRET);
  if (!Array.isArray(state.cs) || !state.cs.length) throw new HttpError("挑戦の情報が正しくありません。最初から始めてください。");
  return state;
}

function pick(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.cs.length) throw new HttpError("相談者の番号が正しくありません。", 404);
  const c = state.cs[index];
  consult.personaOf(c); // 相談者とページが今のデータにあるか
  return c;
}

async function reply(env, state) {
  return { token: await sign(state, env.SESSION_SECRET), view: consult.view(state) };
}

// POST api/hell {genres, consultants, groups, turnstile}
export async function start(body, env, ip) {
  const n = Number(body.consultants ?? 3);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError("相談者の人数は 1〜5 人にしてください。");
  const genres = (Array.isArray(body.genres) ? body.genres : []).filter((g) => GENRES.includes(g));
  const groups = (Array.isArray(body.groups) ? body.groups : []).filter((g) => typeof g === "string");
  await checkTurnstile(env, body.turnstile, ip);
  const rng = rngFor(env);
  const cs = consult.pickConsultants(genres.length ? genres : GENRES, n, groups, rng)
    .map(([persona, memoId]) => ({ p: persona.id, m: memoId, t: consult.pickTargets(data.pages[memoId], rng), turns: [] }));
  // 全員の最初の相談を同時に作る。1 人目が失敗したら全体を失敗にし、2 人目からは画面がその人に移ったときに作り直す
  const llm = llmFor(env, ip);
  const results = await Promise.allSettled(cs.map((c) => consult.consult(c, llm)));
  if (results[0].status === "rejected") throw results[0].reason;
  results.forEach((r, i) => { if (r.status === "fulfilled") cs[i].turns.push({ who: "consultant", text: r.value }); });
  return reply(env, { v: 1, cs });
}

// POST api/hell/answer {token, index, text}
//   相談がまだなら作る（text は要らない）。1 回目の回答なら追加の質問を作る。2 回目の回答なら足すだけ
export async function answer(body, env, ip) {
  const state = await load(env, body);
  const c = pick(state, body.index);
  const text = String(body.text ?? "").trim();
  if (text.length > consult.MAX_ANSWER) throw new HttpError(`回答は ${consult.MAX_ANSWER} 字以内にしてください。`);
  const llm = llmFor(env, ip);
  if (c.turns.length === 0) {
    c.turns.push({ who: "consultant", text: await consult.consult(c, llm) });
  } else if (c.turns.length === 1) {
    c.turns.push({ who: "staff", text });
    c.turns.push({ who: "consultant", text: await consult.consult(c, llm) });
  } else if (c.turns.length === 3) {
    c.turns.push({ who: "staff", text });
  } else {
    throw new HttpError("この相談者への回答は終わっています。", 409);
  }
  return reply(env, state);
}

// POST api/hell/grade {token, index}
export async function grade(body, env, ip) {
  const state = await load(env, body);
  const c = pick(state, body.index);
  if (c.turns.length !== 4) throw new HttpError("まだ採点できません（回答が 2 回そろっていません）。", 409);
  return { grade: await consult.grade(c, llmFor(env, ip)), source: consult.source(c.m) };
}

// POST api/hell/view {token}（AI は呼ばない。再読み込みしたとき用）
export async function viewOf(body, env) {
  return reply(env, await load(env, body));
}
