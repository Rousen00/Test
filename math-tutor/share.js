// Запуск репетитора на своём компьютере с публичной ссылкой.
// 1) читает настройки из settings.env (если есть);
// 2) запускает сервер;
// 3) открывает бесплатный туннель Cloudflare (cloudflared скачивается сам при первом запуске);
// 4) печатает ссылку и, если настроен бот, отправляет её в Telegram-группу.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(ROOT, "bin");

/* ---------- настройки ---------- */
const settingsFile = path.join(ROOT, "settings.env");
if (fs.existsSync(settingsFile)) {
  for (const line of fs.readFileSync(settingsFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && m[2] !== "" && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
process.env.PORT ||= "3000";
process.env.TRUST_PROXY ||= "1"; // запросы приходят через туннель: реальный IP берём из заголовка
const PORT = process.env.PORT;
const NO_TUNNEL = process.env.TUNNEL === "0";

/* ---------- сервер ---------- */
await import("./server.js");

const lan = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => `http://${a.address}:${PORT}`);
console.log(`\nНа этом компьютере:   http://localhost:${PORT}`);
if (lan.length) console.log(`В той же Wi-Fi сети:  ${lan.join("  ")}`);
if (NO_TUNNEL) { console.log("\nТуннель выключен (TUNNEL=0). Доступ только из локальной сети."); }
else startTunnel().catch(e => console.error("\nНе удалось открыть доступ из интернета:", e.message, "\nПриложение работает локально по адресам выше."));

/* ---------- cloudflared ---------- */
function assetName() {
  const arch = os.arch() === "arm64" ? "arm64" : os.arch() === "arm" ? "arm" : os.arch() === "ia32" ? "386" : "amd64";
  if (process.platform === "win32") return { file: `cloudflared-windows-${arch === "arm64" ? "amd64" : arch}.exe`, exe: "cloudflared.exe" };
  if (process.platform === "darwin") return { file: `cloudflared-darwin-${arch === "arm64" ? "arm64" : "amd64"}.tgz`, exe: "cloudflared", tgz: true };
  return { file: `cloudflared-linux-${arch}`, exe: "cloudflared" };
}
function onPath(cmd) {
  try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch (e) { return false; }
}
async function findCloudflared() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  const a = assetName(); const local = path.join(BIN, a.exe);
  if (fs.existsSync(local)) return local;
  if (onPath("cloudflared")) return "cloudflared";
  console.log("\nСкачиваю cloudflared (один раз, ~40 МБ)…");
  fs.mkdirSync(BIN, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${a.file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`скачивание ${url} вернуло ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (a.tgz) {
    const tgz = path.join(BIN, a.file); fs.writeFileSync(tgz, buf);
    execFileSync("tar", ["-xzf", tgz, "-C", BIN]); fs.unlinkSync(tgz);
  } else fs.writeFileSync(local, buf);
  if (process.platform !== "win32") fs.chmodSync(local, 0o755);
  return local;
}

async function startTunnel() {
  const exe = await findCloudflared();
  console.log("\nОткрываю доступ из интернета…");
  // 127.0.0.1, а не localhost: в Windows localhost может уйти на IPv6 (::1), где сервер не слушает → 502
  // http2 (TCP 443) вместо QUIC (UDP): QUIC часто режут провайдеры, туннель от этого то работает, то нет
  const protocol = process.env.TUNNEL_PROTOCOL || "http2";
  const child = spawn(exe, ["tunnel", "--no-autoupdate", "--protocol", protocol, "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  let announced = false;
  const tail = [];
  const onData = buf => {
    const s = String(buf);
    // api.trycloudflare.com — служебный адрес из сообщений об ошибках, не ссылка туннеля
    const m = s.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !announced) { announced = true; announce(m[0]); }
    for (const line of s.split(/\r?\n/)) {
      if (!line.trim()) continue;
      tail.push(line); if (tail.length > 10) tail.shift();
      if (/\bERR\b/.test(line)) console.error("[туннель] " + line);
    }
  };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("exit", code => { if (!stopping) console.error(`\nТуннель остановился (код ${code}). Перезапустите программу, чтобы получить новую ссылку.\nПоследние сообщения cloudflared:\n${tail.join("\n")}`); });
  let stopping = false;
  const stop = () => { stopping = true; child.kill(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("exit", stop);
  setTimeout(() => { if (!announced) console.log("Туннель запускается дольше обычного — проверьте интернет или антивирус/брандмауэр."); }, 30000).unref();
}

async function announce(url) {
  const line = "═".repeat(url.length + 4);
  console.log(`\n╔${line}╗\n║  ${url}  ║\n╚${line}╝`);
  console.log("Это ссылка для студентов. Она работает, пока открыто это окно,");
  console.log("и меняется при каждом новом запуске.\n");
  try { fs.writeFileSync(path.join(ROOT, "public-url.txt"), url + "\n"); } catch (e) {}
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (token && chat) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: (process.env.TELEGRAM_TEXT || "Репетитор по высшей математике открыт:") + "\n" + url, disable_web_page_preview: false })
      });
      const d = await r.json();
      console.log(d.ok ? "Ссылка отправлена в Telegram." : "Telegram не принял сообщение: " + (d.description || r.status));
    } catch (e) { console.log("Не удалось отправить ссылку в Telegram:", e.message); }
  }
}
