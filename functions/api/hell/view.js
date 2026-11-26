// POST /api/hell/view：相談者ごとのトークンから画面の形を作る（AI は呼ばない。再読み込みしたとき用）
import { handle, json, readJson } from "../../../lib/http.js";
import { viewOf } from "../../../lib/service.js";

export const onRequestPost = handle(async ({ request, env }) => json(await viewOf(await readJson(request), env)));
