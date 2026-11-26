// POST /api/hell/grade：2 往復のやりとりを採点する
import { clientIp } from "../../../lib/guard.js";
import { handle, json, readJson } from "../../../lib/http.js";
import { grade } from "../../../lib/service.js";

export const onRequestPost = handle(async ({ request, env }) => json(await grade(await readJson(request), env, clientIp(request))));
