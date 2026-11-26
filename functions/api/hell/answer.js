// POST /api/hell/answer：回答を受け取る（1 回目なら追加の質問を作る）。相談がまだなら作る
import { clientIp } from "../../../lib/guard.js";
import { handle, json, readJson } from "../../../lib/http.js";
import { answer } from "../../../lib/service.js";

export const onRequestPost = handle(async ({ request, env }) => json(await answer(await readJson(request), env, clientIp(request))));
