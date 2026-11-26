// 地獄級の中身（hell.py を移したもの）：相談者とページの選び方、聞かせる事実、漏れチェック、点数、称号、画面に返す形。
// AI の呼び出しは llm（lib/llm.js の callJson）を受け取って使う。状態は相談者ごとのトークン（lib/token.js）に入れる。

import data from "./data.js";
import { HttpError } from "./http.js";
import * as prompts from "./prompts.js";
import { normalize, numbers } from "./text.js";

export const PERSONAS = data.personas;
const PERSONA_BY_ID = Object.fromEntries(PERSONAS.map((p) => [p.id, p]));
// 相談のページに合う相談者が見つからないときに代わりを務める（どの分野でも相談に来うる）
const FALLBACK = ["p14", "p15", "p16", "p17", "p13"];
const ICONS = { "中山間地域の農業者": "⛰️", "大規模農業者": "🚜", JA: "🤝", "企業・大学": "🔬", "公設試": "🧪", "議員": "🏛️" };
const EMPTY_ANSWERS = new Set(["", "わからない", "わかりません", "分からない", "分かりません", "不明"]);
export const MAX_ANSWER = 2000;

export class ConsultError extends HttpError {}

// ---- 乱数（テストでは決まった並びにできる） ----

export function makeRng(random = Math.random) {
  return {
    choice: (list) => list[Math.floor(random() * list.length)],
    shuffle: (list) => {
      const a = [...list];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}

// ---- 相談者とページを選ぶ ----

// data.js に入っているのは、地獄級に使えるページ（大事な事実が 2 件以上、文字が十分）だけ
export function usablePages(genres) {
  return Object.fromEntries(Object.entries(data.pages).filter(([, p]) => genres.includes(p.genre_id)));
}

export function pickConsultants(genres, n, groups, rng) {
  const pages = usablePages(genres);
  if (!Object.keys(pages).length) {
    throw new ConsultError("選んだジャンルには、地獄級に使えるページがまだありません。詳細設定でジャンルを増やしてください。");
  }
  const allowed = PERSONAS.filter((p) => !groups.length || groups.includes(p.group));
  if (!allowed.length) throw new ConsultError("相談者の区分の指定が正しくありません。");
  const picked = [];
  const usedPages = new Set();
  const usedPersonas = new Set();
  const left = () => Object.keys(pages).filter((m) => !usedPages.has(m)).sort();
  const take = (persona, candidates) => {
    const mid = rng.choice([...candidates].sort());
    picked.push([persona, mid]);
    usedPages.add(mid);
    usedPersonas.add(persona.id);
  };
  // 1. そのページの相談に来そうな相手（問題作りのときに付けたタグ）を優先する
  for (const persona of rng.shuffle(allowed)) {
    if (picked.length >= n) break;
    const tagged = left().filter((m) => pages[m].persona_tags.includes(persona.id));
    if (tagged.length) take(persona, tagged);
  }
  // 2. 足りなければ、どの分野でも相談に来うる相手で補う
  for (const pid of FALLBACK) {
    const persona = PERSONA_BY_ID[pid];
    if (picked.length < n && allowed.includes(persona) && !usedPersonas.has(pid) && left().length) take(persona, left());
  }
  // 3. それでも足りなければ、同じ相談者が別のページで来る
  while (picked.length < n && picked.length && left().length) {
    take(rng.choice(picked.map(([p]) => p)), left());
  }
  if (!picked.length) {
    throw new ConsultError("選んだジャンルと相談者の区分の組み合わせでは、相談を作れません。区分を「おまかせ」にしてみてください。");
  }
  return picked;
}

// 聞かせる事実（targets）は、key_facts の番号でトークンに入れる
export function pickTargets(page, rng) {
  return rng.shuffle(page.key_facts.map((_, i) => i)).slice(0, 3);
}

export function targetsOf(c) {
  const page = data.pages[c.m];
  return c.t.map((idx, i) => ({ id: `T${i + 1}`, fact: page.key_facts[idx].fact, evidence: page.key_facts[idx].evidence }));
}

export function personaOf(c) {
  const p = PERSONA_BY_ID[c.p];
  if (!p || !data.pages[c.m]) throw new ConsultError("挑戦の情報が正しくありません。最初から始めてください。");
  return p;
}

// ---- AI を呼ぶ ----

// 相談者の次の発言。メモの数値を先に言ってしまったら、1 回だけ言い直させる
export async function consult(c, llm) {
  const page = data.pages[c.m];
  const targets = targetsOf(c);
  const system = prompts.consultSystem(personaOf(c), page, page.genre, targets);
  const user = c.turns.length ? prompts.consultFollowup(c.turns) : prompts.CONSULT_OPEN;
  let reply = await llm({ kind: "consult", system, user, schema: prompts.CONSULT_SCHEMA });
  const leaked = leakedNumbers(reply.say, targets, c.turns);
  if (leaked.size) {
    const note = `\n注意：前の案では、答えになる数値（${[...leaked].sort().join("、")}）を相談者が先に言っていました。`
      + "相談者は答えを知らない立場なので、数値を言わずに相談し直してください。";
    reply = await llm({ kind: "consult", system, user: user + note, schema: prompts.CONSULT_SCHEMA });
  }
  return String(reply.say).trim();
}

// 相談者の発言に出てきた、答えになる数値（職員がまだ言っていないもの）
export function leakedNumbers(say, targets, turns) {
  const answer = new Set();
  for (const t of targets) for (const n of [...numbers(t.fact), ...numbers(t.evidence)]) answer.add(n);
  const said = new Set();
  for (const t of turns) if (t.who === "staff") for (const n of numbers(t.text)) said.add(n);
  return new Set([...numbers(say)].filter((n) => answer.has(n) && !said.has(n)));
}

export async function grade(c, llm) {
  const page = data.pages[c.m];
  const targets = targetsOf(c);
  if (c.turns.filter((t) => t.who === "staff").every((t) => isEmpty(t.text))) return emptyGrade(targets);
  const system = prompts.gradeSystem(personaOf(c), page, page.genre, targets);
  const reply = await llm({ kind: "grade", system, user: prompts.gradeUser(c.turns), schema: prompts.GRADE_SCHEMA,
    check: prompts.checkGrade });
  return score(reply, targets, page.norm);
}

export function isEmpty(text) {
  return EMPTY_ANSWERS.has(normalize(text).replace(/^[。.、 ]+|[。.、 ]+$/g, ""));
}

// ---- 点数（AI が付けたラベルから、サーバーで計算する。正確さ 40・要点 30・伝え方 30） ----

// Python の round と同じ、偶数への丸め（7.5 → 8、12.5 → 12）
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function score(reply, targets, norm) {
  const verdicts = reply.claims.map((cl) => cl.verdict);
  const count = (v) => verdicts.filter((x) => x === v).length;
  const accuracy = verdicts.length
    ? Math.max(0, 40 - 15 * count("wrong_major") - 6 * count("wrong_minor") - 2 * count("unsupported")) : 0;
  const status = Object.fromEntries(reply.targets.map((t) => [t.id, t.status]));
  const covered = targets.filter((t) => status[t.id] === "covered").length;
  const partial = targets.filter((t) => status[t.id] === "partial").length;
  const coverage = targets.length ? roundHalfEven((30 * (covered + 0.5 * partial)) / targets.length) : 0;
  const detail = reply.delivery.map((d) => Math.max(0, Math.min(3, Math.trunc(d)))).slice(0, 4);
  const delivery = roundHalfEven(detail.reduce((a, b) => a + b, 0) * 2.5);
  const inMemo = (q) => normalize(q || "").length >= 4 && norm.includes(normalize(q || ""));
  return {
    total: accuracy + coverage + delivery, accuracy, coverage, delivery,
    delivery_detail: prompts.DELIVERY_POINTS.map((point, i) => [point, detail[i]]).filter(([, v]) => v !== undefined)
      .map(([point, value]) => ({ point, value })),
    claims: reply.claims.map((cl) => ({ ...cl, evidence: inMemo(cl.evidence) ? cl.evidence : "" })),
    targets: targets.map((t) => ({ id: t.id, fact: t.fact, evidence: t.evidence, status: status[t.id] || "missing" })),
    good: reply.good, missing: reply.missing, model_answer: String(reply.model_answer).trim(),
    evidence: reply.evidence.filter(inMemo), one_line: String(reply.one_line).trim(),
  };
}

export function emptyGrade(targets) {
  return {
    total: 0, accuracy: 0, coverage: 0, delivery: 0,
    delivery_detail: prompts.DELIVERY_POINTS.map((point) => ({ point, value: 0 })), claims: [],
    targets: targets.map((t) => ({ ...t, status: "missing" })), good: [],
    missing: ["回答がありませんでした。"], model_answer: "このメモで伝えたいこと：" + targets.map((t) => t.fact).join("／"),
    evidence: targets.map((t) => t.evidence), one_line: "まずは、分かる範囲で答えてみましょう。",
  };
}

export function rank(avg) {
  for (const [border, name] of [[90, "免許皆伝"], [75, "師範代"], [60, "黒帯"], [40, "茶帯"]]) if (avg >= border) return name;
  return "白帯";
}

// ---- 画面に返す形（Flask 版の hell.view と同じ形。採点の結果は画面の側で足す） ----

export function statusOf(c) {
  return { 1: "answer1", 3: "answer2", 4: "grading" }[c.turns.length] || "opening";
}

export function source(memoId) {
  const p = data.pages[memoId];
  return {
    memo_id: memoId, genre_id: p.genre_id, genre: p.genre, page: p.page, print_page: p.print_page, title: p.title,
    pdf_url: `pdf/${p.genre_id}.pdf#page=${p.page}`, image_url: data.images ? `pages/${p.genre_id}/${p.page}.png` : "",
  };
}

// 相談者 1 人分（c.i が番号）
export function viewOne(c) {
  const p = personaOf(c);
  return {
    index: c.i, status: statusOf(c), genre: data.pages[c.m].genre, turns: c.turns, error: null, elapsed: 0,
    persona: { group: p.group, role: p.role, profile: p.profile, icon: ICONS[p.group] || "🙂" },
  };
}

export function view(cs) {
  return { consultants: cs.map(viewOne), finished: false, average: null, rank: null };
}
