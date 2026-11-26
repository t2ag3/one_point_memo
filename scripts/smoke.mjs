// デプロイの前に、本物の OpenRouter で地獄級を 1 人分ためす（ネットにつながる PC で動かす）。
// モデルが決まった形の JSON を返せるか、日本語の相談・採点の質がどうかを、目で確かめる。
//
//   OPENROUTER_API_KEY=sk-or-… node scripts/smoke.mjs [ジャンル] ["1 回目の回答"] ["2 回目の回答"]
//   （Windows の PowerShell なら：$env:OPENROUTER_API_KEY="sk-or-…"; node scripts/smoke.mjs）
// モデルを変えて試すときは、MODEL_CONSULT・MODEL_GRADE・MODEL_FALLBACKS・JSON_SCHEMA も環境変数で渡せる。
// AI を 3〜5 回呼ぶ（無料のモデルなら 0 円。回数の上限には数えられる）。

import { randomBytes } from "node:crypto";

import * as service from "../lib/service.js";
import { DEFAULT_MODEL } from "../lib/llm.js";

const [genre = "09", answer1 = "すみません、詳しくは分かりません。", answer2 = "調べてお返事します。"] = process.argv.slice(2);
const env = {
  ...process.env,
  SESSION_SECRET: randomBytes(24).toString("base64url"),
};
if (!env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY を環境変数で渡してください。");
  process.exit(1);
}

async function step(label, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`\n[${label}：${((Date.now() - started) / 1000).toFixed(1)} 秒]`);
    return result;
  } catch (e) {
    console.error(`\n[${label}] 失敗：${e.message}`);
    process.exit(1);
  }
}

console.log(`相談者のモデル：${env.MODEL_CONSULT || DEFAULT_MODEL}／採点のモデル：${env.MODEL_GRADE || DEFAULT_MODEL}`);
let r = await step("最初の相談", () => service.start({ genres: [genre], consultants: 1 }, env, "smoke"));
const c = () => r.view.consultants[0];
console.log(`相談者：${c().persona.role}（${c().genre}）\n${c().turns.at(-1).text}`);
console.log(`職員：${answer1}`);
r = await step("追加の質問", () => service.answer({ token: r.token, index: 0, text: answer1 }, env, "smoke"));
console.log(`相談者：${c().turns.at(-1).text}`);
console.log(`職員：${answer2}`);
r = await step("2 回目の回答", () => service.answer({ token: r.token, index: 0, text: answer2 }, env, "smoke"));
const g = await step("採点", () => service.grade({ token: r.token, index: 0 }, env, "smoke"));
const s = g.grade;
console.log(`${s.total} 点（正確さ ${s.accuracy}・要点 ${s.coverage}・伝え方 ${s.delivery}）　${s.one_line}`);
console.log(`模範回答：${s.model_answer}`);
for (const t of s.targets) console.log(`  ${t.status}：${t.fact}`);
console.log(`\n出典：${g.source.genre} p.${g.source.print_page}（${g.source.pdf_url}）`);
