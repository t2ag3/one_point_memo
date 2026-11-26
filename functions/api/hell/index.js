// POST /api/hell：地獄級を始める（相談者とページを選び、最初の相談を作る）
import { clientIp } from "../../../lib/guard.js";
import { handle, json, readJson } from "../../../lib/http.js";
import { start } from "../../../lib/service.js";

export const onRequestPost = handle(async ({ request, env }) => json(await start(await readJson(request), env, clientIp(request))));
