// Сервер репетитора «В гостях у высшей математики».
// Без внешних зависимостей, кроме необязательного @anthropic-ai/sdk для Алисы.
// Хранит пользователей, сессии и прогресс в data/db.json.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const DB_FILE = path.join(DATA_DIR, "db.json");
const SESSION_DAYS = 60;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/* ---------------- хранилище ---------------- */
let db = { users: {}, logins: {}, sessions: {}, progress: {} };
fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); }
  catch (e) { console.error("Не удалось прочитать", DB_FILE, e.message); process.exit(1); }
}
let saveTimer = null, writing = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const data = JSON.stringify(db);
  writing = writing.then(async () => {
    const tmp = DB_FILE + ".tmp";
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, DB_FILE);
  }).catch(e => console.error("Ошибка записи базы:", e.message));
  return writing;
}
// чистка просроченных сессий раз в час
setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < now) { delete db.sessions[k]; n++; }
  if (n) save();
}, 3600e3).unref();

/* ---------------- пароли и сессии ---------------- */
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); const key = await scrypt(pw, salt); return { salt: salt.toString("base64"), hash: key.toString("base64") }; }
async function checkPassword(pw, user) { const key = await scrypt(pw, Buffer.from(user.salt, "base64")); const ref = Buffer.from(user.hash, "base64"); return key.length === ref.length && crypto.timingSafeEqual(key, ref); }
const DUMMY_USER = { salt: crypto.randomBytes(16).toString("base64"), hash: crypto.randomBytes(64).toString("base64") };
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

function parseCookies(req) {
  const out = {}; for (const part of (req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out;
}
function isHttps(req) { return process.env.COOKIE_SECURE === "1" || req.socket.encrypted || (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"; }
function setSession(req, res, uid) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions[sha(token)] = { uid, exp: Date.now() + SESSION_DAYS * 864e5 }; save();
  res.setHeader("Set-Cookie", `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? "; Secure" : ""}`);
}
function clearSession(req, res) {
  const t = parseCookies(req).sid; if (t) { delete db.sessions[sha(t)]; save(); }
  res.setHeader("Set-Cookie", `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`);
}
function currentUser(req) {
  const t = parseCookies(req).sid; if (!t) return null;
  const s = db.sessions[sha(t)]; if (!s || s.exp < Date.now()) return null;
  return db.users[s.uid] || null;
}

/* ---------------- ограничение частоты ---------------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++; return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 600e3).unref();
const clientIp = req => (process.env.TRUST_PROXY === "1" ? (req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";

/* ---------------- HTTP-утилиты ---------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/i.test(req.headers["content-type"] || "")) return reject(Object.assign(new Error("Нужен JSON"), { status: 415 }));
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Слишком большой запрос"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(Object.assign(new Error("Некорректный JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
}
const publicUser = u => ({ id: u.id, login: u.login, name: u.name, avatar: u.avatar || null });
// аватар — маленькая картинка, которую браузер уже ужал до 128×128
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const AVATAR_MAX = 60 * 1024;

/* ---------------- рейтинг ---------------- */
function boardRow(uid) {
  const u = db.users[uid]; const s = db.progress[uid] || {};
  let ok = 0, tries = 0; for (const v of Object.values(s.stats || {})) { ok += +v.ok || 0; tries += +v.tries || 0; }
  const best = (s.exams || []).reduce((m, e) => Math.max(m, e.total ? Math.round(100 * e.score / e.total) : 0), 0);
  const days = new Set(s.days || []); let streak = 0; const d = new Date();
  if (!days.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() - 1); // вчерашняя серия ещё не прервана
  while (days.has(d.toISOString().slice(0, 10))) { streak++; d.setDate(d.getDate() - 1); }
  return { id: uid, name: u.name, avatar: u.avatar || null, xp: +s.xp || 0, solved: ok, tries, best, streak };
}

/* ---------------- Алиса (Claude API) ---------------- */
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try { const { default: Anthropic } = await import("@anthropic-ai/sdk"); anthropic = new Anthropic(); }
  catch (e) { console.warn("ANTHROPIC_API_KEY задан, но пакет @anthropic-ai/sdk не установлен (npm install). Алиса отключена."); }
}
// локальная модель через Ollama — если нет ключа Claude, но задан OLLAMA_MODEL
const OLLAMA_MODEL = !anthropic && process.env.OLLAMA_MODEL || "";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const tutorOn = () => !!(anthropic || OLLAMA_MODEL);
const tutorLabel = () => anthropic ? "включена, " + MODEL : OLLAMA_MODEL ? "включена, Ollama " + OLLAMA_MODEL : "выключена";
const tutorSystem = ctx => `Ты — Алиса, дружелюбный репетитор по высшей математике для студентов технического вуза. Ты опираешься на методичку А. А. Нуятова «В гостях у высшей математики» (НГТУ им. Р. Е. Алексеева, 2025).
${ctx}
Правила: отвечай по-русски, коротко и по шагам; формулы пиши в LaTeX внутри $...$ (строчные) или $$...$$ (выносные); используй обозначения российской традиции (tg, ctg, arctg). Если студент просит решить задачу, сначала дай наводящую подсказку и спроси, хочет ли он полное решение. Если находишь ошибку в рассуждениях — укажи место ошибки. Не выдумывай номера страниц и теорем методички. На вопросы не по математике мягко возвращай к учёбе.`;

async function tutor(req, res, user) {
  if (!tutorOn()) return send(res, 503, { error: "Алиса не настроена на сервере." });
  if (limited("tutor:" + user.id, 40, 3600e3)) return send(res, 429, { error: "Слишком много вопросов за час. Сделайте перерыв и спросите позже." });
  const body = await readJson(req, 128 * 1024);
  const ctx = String(body.context || "").slice(0, 800);
  let msgs = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
  msgs = msgs.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 6000) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  // соседние сообщения одной роли склеиваем
  const merged = []; for (const m of msgs) { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += "\n\n" + m.content; else merged.push({ ...m }); }
  if (!merged.length || merged[merged.length - 1].role !== "user") return send(res, 400, { error: "Нет вопроса." });

  const hint = body.mode === "hint";
  const system = tutorSystem(ctx) + (hint ? "\n\nРежим подсказки: дай ОДНУ короткую наводящую подсказку (2–4 предложения) — с какой формулы или шага начать. Не называй ответ, не выполняй вычисления до конца и не пиши полное решение, даже если студент об этом просит." : "");
  if (!anthropic) return tutorOllama(req, res, system, merged, hint);
  const params = { model: MODEL, max_tokens: hint ? 600 : 4000, system, messages: merged, output_config: { effort: "low" } };
  if (FALLBACK_MODELS.has(MODEL)) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }
  const stream = anthropic.beta.messages.stream(params);
  req.on("close", () => { if (!res.writableEnded) stream.abort(); });
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  try {
    for await (const ev of stream) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") res.write(ev.delta.text);
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") res.write("\n\n(На этот вопрос я ответить не могу. Давай вернёмся к математике.)");
    else if (final.stop_reason === "max_tokens") res.write("\n\n(ответ обрезан — попроси продолжить)");
  } catch (e) {
    if (!res.writableEnded) res.write("\n\n(Не удалось получить ответ" + (e && e.status === 429 ? ": сервис перегружен, попробуйте через минуту" : "") + ".)");
    if (!(e && e.name === "APIUserAbortError")) console.error("Ошибка Claude API:", e && (e.status || ""), e && e.message);
  }
  res.end();
}

// Ollama отдаёт ответ потоком: одна JSON-строка на кусок текста
async function tutorOllama(req, res, system, messages, hint) {
  const ac = new AbortController();
  req.on("close", () => { if (!res.writableEnded) ac.abort(); });
  let r;
  try {
    r = await fetch(OLLAMA_URL + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal,
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: true, think: false, keep_alive: "30m", messages: [{ role: "system", content: system }, ...messages], options: { num_predict: hint ? 400 : 2000, temperature: 0.4 } })
    });
  } catch (e) {
    if (e.name !== "AbortError") console.error("Ollama недоступна:", e.message);
    return send(res, 503, { error: "Алиса сейчас недоступна: на сервере не запущена Ollama." });
  }
  if (!r.ok) {
    const t = await r.text().catch(() => ""); console.error("Ошибка Ollama:", r.status, t.slice(0, 300));
    return send(res, 502, { error: r.status === 404 ? `Модель ${OLLAMA_MODEL} не скачана (ollama pull ${OLLAMA_MODEL}).` : "Алиса не смогла ответить." });
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const dec = new TextDecoder(); let buf = "", cut = false;
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true }); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        if (ev.message && ev.message.content) res.write(ev.message.content);
        if (ev.done && ev.done_reason === "length") cut = true;
      }
    }
    if (cut) res.write("\n\n(ответ обрезан — попроси продолжить)");
  } catch (e) {
    if (e.name !== "AbortError") { console.error("Ошибка Ollama:", e.message); if (!res.writableEnded) res.write("\n\n(Не удалось получить ответ.)"); }
  }
  res.end();
}

/* ---------------- API ---------------- */
const LOGIN_RE = /^[a-z0-9._@+-]{3,64}$/;
async function handleApi(req, res, route) {
  const user = currentUser(req);
  const method = req.method;

  if (route === "config" && method === "GET") return send(res, 200, { tutor: tutorOn() });

  if (route === "register" && method === "POST") {
    if (limited("auth:" + clientIp(req), 20, 600e3)) return send(res, 429, { error: "Слишком много попыток. Подождите 10 минут." });
    const b = await readJson(req, 8 * 1024);
    const login = String(b.login || "").trim().toLowerCase(), name = String(b.name || "").trim().replace(/\s+/g, " "), pw = String(b.password || "");
    if (!LOGIN_RE.test(login)) return send(res, 400, { error: "Логин: от 3 до 64 символов — латинские буквы, цифры и . _ @ + -" });
    if (name.length < 1 || name.length > 60) return send(res, 400, { error: "Укажите имя (до 60 символов)." });
    if (pw.length < 6 || pw.length > 200) return send(res, 400, { error: "Пароль должен быть не короче 6 символов." });
    if (db.logins[login]) return send(res, 409, { error: "Такой логин уже занят." });
    const id = crypto.randomUUID(); const { salt, hash } = await hashPassword(pw);
    if (db.logins[login]) return send(res, 409, { error: "Такой логин уже занят." });
    db.users[id] = { id, login, name, salt, hash, created: Date.now() }; db.logins[login] = id; save();
    setSession(req, res, id);
    return send(res, 201, { user: publicUser(db.users[id]), progress: null });
  }

  if (route === "login" && method === "POST") {
    if (limited("auth:" + clientIp(req), 20, 600e3)) return send(res, 429, { error: "Слишком много попыток. Подождите 10 минут." });
    const b = await readJson(req, 8 * 1024);
    const login = String(b.login || "").trim().toLowerCase(), pw = String(b.password || "");
    const u = db.users[db.logins[login]];
    // для несуществующего логина тоже считаем хеш, чтобы по времени ответа нельзя было узнать, есть ли такой пользователь
    const ok = await checkPassword(pw, u || DUMMY_USER);
    if (!u || !ok) return send(res, 401, { error: "Неверный логин или пароль." });
    setSession(req, res, u.id);
    return send(res, 200, { user: publicUser(u), progress: db.progress[u.id] || null });
  }

  if (route === "logout" && method === "POST") { clearSession(req, res); return send(res, 200, { ok: true }); }

  if (!user) return send(res, 401, { error: "Нужно войти в аккаунт." });

  if (route === "me" && method === "GET") return send(res, 200, { user: publicUser(user), progress: db.progress[user.id] || null });

  if (route === "progress" && method === "PUT") {
    const b = await readJson(req, 512 * 1024);
    const s = b && b.state;
    if (!s || typeof s !== "object" || Array.isArray(s) || s.v !== 1) return send(res, 400, { error: "Некорректные данные прогресса." });
    db.progress[user.id] = s; save();
    return send(res, 200, { ok: true });
  }

  if (route === "profile" && method === "PUT") {
    const b = await readJson(req, 128 * 1024);
    const next = {};
    if (b.name !== undefined) {
      const name = String(b.name || "").trim().replace(/\s+/g, " ");
      if (name.length < 1 || name.length > 60) return send(res, 400, { error: "Укажите имя (до 60 символов)." });
      next.name = name;
    }
    if (b.login !== undefined) {
      const login = String(b.login || "").trim().toLowerCase();
      if (!LOGIN_RE.test(login)) return send(res, 400, { error: "Логин: от 3 до 64 символов — латинские буквы, цифры и . _ @ + -" });
      if (login !== user.login && db.logins[login]) return send(res, 409, { error: "Такой логин уже занят." });
      next.login = login;
    }
    if (b.avatar !== undefined) {
      if (b.avatar === null || b.avatar === "") next.avatar = null;
      else if (typeof b.avatar === "string" && b.avatar.length <= AVATAR_MAX && AVATAR_RE.test(b.avatar)) next.avatar = b.avatar;
      else return send(res, 400, { error: "Не удалось сохранить фото: нужен JPEG, PNG или WebP небольшого размера." });
    }
    if (next.login && next.login !== user.login) { delete db.logins[user.login]; db.logins[next.login] = user.id; }
    Object.assign(user, next); if (user.avatar === null) delete user.avatar;
    save();
    return send(res, 200, { user: publicUser(user) });
  }

  if (route === "password" && method === "POST") {
    const b = await readJson(req, 8 * 1024);
    if (!(await checkPassword(String(b.old || ""), user))) return send(res, 400, { error: "Текущий пароль указан неверно." });
    const pw = String(b.password || ""); if (pw.length < 6 || pw.length > 200) return send(res, 400, { error: "Новый пароль должен быть не короче 6 символов." });
    Object.assign(user, await hashPassword(pw));
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === user.id) delete db.sessions[k];
    save(); setSession(req, res, user.id);
    return send(res, 200, { ok: true });
  }

  if (route === "leaderboard" && method === "GET") {
    const rows = Object.keys(db.progress).filter(id => db.users[id]).map(boardRow).filter(r => r.xp > 0 || r.id === user.id)
      .sort((a, b) => b.xp - a.xp || b.solved - a.solved).slice(0, 200)
      .map(({ id, ...r }) => ({ ...r, me: id === user.id }));
    return send(res, 200, { rows });
  }

  if (route === "tutor" && method === "POST") return tutor(req, res, user);

  return send(res, 404, { error: "Не найдено." });
}

/* ---------------- статика ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const st = await fsp.stat(file); if (!st.isFile()) throw 0;
    const ext = path.extname(file);
    const noCache = ext === ".html" || path.basename(file) === "sw.js" || ext === ".webmanifest";
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": noCache ? "no-cache" : "public, max-age=86400" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Не найдено"); }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com",
  "worker-src 'self'", "manifest-src 'self'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"
].join("; ");

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", CSP);
  try {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname.slice(5).replace(/\/$/, ""));
    if (pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, pathname);
  } catch (e) {
    const code = e && e.status || 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) send(res, code, { error: code === 500 ? "Внутренняя ошибка сервера." : e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Репетитор запущен: http://localhost:${PORT}  (данные: ${DB_FILE}; Алиса: ${tutorLabel()})`);
});
const shutdown = async () => { server.close(); await flush(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
