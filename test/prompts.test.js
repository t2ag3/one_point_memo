// JS に移した指示文・点数・漏れチェック・称号が、Python（prompts.py・hell.py・memo_text.py）と同じ結果になるか。
// 見本（lib/fixtures.json）は tools/build_cloudflare.py が Python で作る。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as consult from "../lib/consult.js";
import data from "../lib/data.js";
import * as prompts from "../lib/prompts.js";
import { normalize, numbers } from "../lib/text.js";

const fx = JSON.parse(readFileSync(new URL("../lib/fixtures.json", import.meta.url)));
const page = data.pages[fx.memo_id];
const persona = consult.PERSONAS.find((p) => p.id === fx.persona_id);

test("指示文が Python と同じ", () => {
  assert.equal(prompts.consultSystem(persona, page, page.genre, fx.targets), fx.consult_system);
  assert.equal(prompts.CONSULT_OPEN, fx.consult_open);
  assert.equal(prompts.consultFollowup(fx.turns.slice(0, 2)), fx.consult_followup);
  assert.equal(prompts.gradeSystem(persona, page, page.genre, fx.targets), fx.grade_system);
  assert.equal(prompts.gradeUser(fx.turns), fx.grade_user);
  assert.deepEqual(prompts.CONSULT_SCHEMA, fx.consult_schema);
  assert.deepEqual(prompts.GRADE_SCHEMA, fx.grade_schema);
  assert.deepEqual(prompts.DELIVERY_POINTS, fx.delivery_points);
});

test("点数・空の回答の講評が Python と同じ", () => {
  assert.deepEqual(consult.score(fx.grade_input, fx.targets, page.norm), fx.score);
  assert.deepEqual(consult.emptyGrade(fx.targets), fx.empty_grade);
});

test("漏れチェック・称号・正規化が Python と同じ", () => {
  assert.deepEqual([...consult.leakedNumbers("約20年ぶりで、令和8年6月に決定", fx.targets, fx.turns.slice(0, 1))].sort(), fx.leaked);
  for (const [avg, name] of Object.entries(fx.ranks)) assert.equal(consult.rank(Number(avg)), name);
  for (const [t, n] of Object.entries(fx.normalize)) assert.equal(normalize(t), n);
  for (const [t, ns] of Object.entries(fx.numbers)) assert.deepEqual([...numbers(t)].sort(), ns);
});

test("採点の形の確かめが Python と同じ", () => {
  assert.equal(prompts.checkGrade({ delivery: [0, 1, 2, 3] }), fx.check_grade.ok);
  assert.equal(prompts.checkGrade({ delivery: [0, 1] }), fx.check_grade.short);
  assert.equal(prompts.checkGrade({ delivery: [0, 1, 2, 4] }), fx.check_grade.range);
});

test("丸めは Python と同じ偶数への丸め", () => {
  assert.deepEqual([2.5, 7.5, 12.5, 22.5, 3.4, 3.6].map(consult.roundHalfEven), [2, 8, 12, 22, 3, 4]);
});

test("空の回答とみなすもの", () => {
  for (const t of ["", "  ", "わかりません。", "分からない", "不明．"]) assert.ok(consult.isEmpty(t), t);
  assert.ok(!consult.isEmpty("約20年です"));
});
