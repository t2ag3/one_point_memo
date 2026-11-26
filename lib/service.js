// 地獄級の API の本体。functions/api/hell/*.js から呼ぶ（テストからも直接呼べる）。
// 状態は相談者ごとのトークンに入れて毎回返す。AI の呼び出しが途中で失敗しても、同じ要求を送り直せばやり直せる。
// 相談者ごとに分けているので、別の相談者への要求は同時に送ってよい（1 人目と話している間に、2 人目の相談を裏で作れる）。

import * as consult from "./consult.js";
import data from "./data.js";
import { checkTurnstile, countUse } from "./guard.js";
import { HttpError } from "./http.js";
import { callJson } from "./llm.js";
import { sign, verify } from "./token.js";

const GENRES = Object.keys(data.genres);
const TOKEN_VERSION = 2;
const BROKEN = "挑戦の情報が正しくありません。最初から始めてください。";

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

// トークンの中身：{v, i（番号）, p（相談者）, m（ページ）, t（聞かせる事実）, turns}
async function load(env, token) {
  const c = await verify(token, env.SESSION_SECRET);
  if (c.v !== TOKEN_VERSION || !Number.isInteger(c.i) || !Array.isArray(c.turns)) throw new HttpError(BROKEN);
  consult.personaOf(c); // 相談者とページが今のデータにあるか
  return c;
}

const signAll = (env, cs) => Promise.all(cs.map((c) => sign(c, env.SESSION_SECRET)));

async function reply(env, c) {
  return { token: await sign(c, env.SESSION_SECRET), consultant: consult.viewOne(c) };
}

// POST api/hell {genres, consultants, groups, turnstile} → {tokens, view}
//   待たせるのは 1 人目の最初の相談だけ。2 人目からは、画面が裏で api/hell/answer を呼んで作る
export async function start(body, env, ip) {
  const n = Number(body.consultants ?? 3);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError("相談者の人数は 1〜5 人にしてください。");
  const genres = (Array.isArray(body.genres) ? body.genres : []).filter((g) => GENRES.includes(g));
  const groups = (Array.isArray(body.groups) ? body.groups : []).filter((g) => typeof g === "string");
  await checkTurnstile(env, body.turnstile, ip);
  const rng = rngFor(env);
  const cs = consult.pickConsultants(genres.length ? genres : GENRES, n, groups, rng)
    .map(([persona, memoId], i) => ({
      v: TOKEN_VERSION, i, p: persona.id, m: memoId, t: consult.pickTargets(data.pages[memoId], rng), turns: [],
    }));
  cs[0].turns.push({ who: "consultant", text: await consult.consult(cs[0], llmFor(env, ip)) });
  return { tokens: await signAll(env, cs), view: consult.view(cs) };
}

// POST api/hell/answer {token, text} → {token, consultant}（token はその相談者のもの）
//   相談がまだなら作る（text は要らない）。1 回目の回答なら追加の質問を作る。2 回目の回答なら足すだけ
export async function answer(body, env, ip) {
  const c = await load(env, body.token);
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
  return reply(env, c);
}

// POST api/hell/grade {token} → {grade, source}
export async function grade(body, env, ip) {
  const c = await load(env, body.token);
  if (c.turns.length !== 4) throw new HttpError("まだ採点できません（回答が 2 回そろっていません）。", 409);
  return { grade: await consult.grade(c, llmFor(env, ip)), source: consult.source(c.m) };
}

// POST api/hell/view {tokens} → {tokens, view}（AI は呼ばない。再読み込みしたとき用）
export async function viewOf(body, env) {
  const tokens = body.tokens;
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 5) throw new HttpError(BROKEN);
  const cs = await Promise.all(tokens.map((token) => load(env, token)));
  if (cs.some((c, i) => c.i !== i)) throw new HttpError(BROKEN);
  return { tokens: await signAll(env, cs), view: consult.view(cs) };
}
