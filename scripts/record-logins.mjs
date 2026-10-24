// ════════════════════════════════════════════════════════════
//  로그인 앱 '한 번만 로그인' 기록 — 내 맥에서 처음 한 번만 실행
//
//  1. 브라우저 창이 열리면 KS 앱스토어에 관리자 계정으로 로그인
//  2. 로그인이 필요한 앱이 하나씩 열림 → 직접 로그인하고 화면 위 노란 띠의 '로그인 끝' 버튼
//  3. 로그인 상태(열쇠)만 골라 GitHub 비밀값 APP_SESSIONS 로 올리고, 내 컴퓨터에 남은 건 지움
//  그다음부터는 매일 새벽 자동 실행이 이 열쇠로 '로그인된 화면'을 찍어요.
//  비밀번호는 어디에도 저장하지 않아요. 열쇠는 GitHub 안에 암호화돼 보관되고 실행 기록에도 안 나와요.
//
//  실행: cd scripts && npm install && npx playwright install chromium && node record-logins.mjs
// ════════════════════════════════════════════════════════════
import { chromium } from "playwright";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = process.env.KS_STORE || "https://aznail1980-ctrl.github.io/ks-app-store/";
// 확인용(리허설): KS_DRY=1 이면 GitHub에 올리지 않고 크기만 보여 줌, KS_AUTO=1 이면 창 없이 버튼을 저절로 누름
const DRY = process.env.KS_DRY === "1", AUTO = process.env.KS_AUTO === "1";
const REPO = "aznail1980-ctrl/ks-app-store";
const MAX_SECRET = 48_000;                   // GitHub 비밀값 크기 한도(약 48KB)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 화면 맨 위에 노란 안내 띠 + 버튼을 붙임 (페이지가 바뀌어도 다시 붙임)
function banner(page, text, buttons) {
  const inject = () => page.evaluate(([text, buttons]) => {
    if (document.getElementById("ks-bar")?.dataset.text === text) return;
    document.getElementById("ks-bar")?.remove();
    const bar = document.createElement("div");
    bar.id = "ks-bar"; bar.dataset.text = text;
    bar.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;background:#FFE14D;color:#23211F;border:2px solid #23211F;border-radius:12px;padding:10px 12px;font:600 14px/1.5 -apple-system,'Apple SD Gothic Neo',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
    const p = document.createElement("div"); p.textContent = text; bar.appendChild(p);
    if (buttons.length) {
      const row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;margin-top:8px";
      for (const [label, action, dark] of buttons) {
        const b = document.createElement("button"); b.textContent = label;
        b.style.cssText = `flex:1;min-height:42px;border-radius:10px;border:2px solid #23211F;font:700 15px -apple-system,'Apple SD Gothic Neo',sans-serif;cursor:pointer;background:${dark ? "#23211F" : "#fff"};color:${dark ? "#fff" : "#23211F"}`;
        b.onclick = () => window.ksDone(action);
        row.appendChild(b);
      }
      bar.appendChild(row);
    }
    document.documentElement.appendChild(bar);
  }, [text, buttons]).catch(() => {});
  page.on("load", inject);
  const timer = setInterval(inject, 1500);   // 앱이 화면을 새로 그려 띠가 지워져도 다시 붙임
  inject();
  return () => clearInterval(timer);
}

const dir = mkdtempSync(join(tmpdir(), "ks-login-"));    // 이번 한 번만 쓰는 빈 브라우저 (끝나면 지움)
const ctx = await chromium.launchPersistentContext(dir, { headless: AUTO, viewport: { width: 430, height: 900 }, locale: "ko-KR" });
// 중간에 창을 닫거나 Ctrl+C로 멈춰도 내 컴퓨터에 로그인 흔적이 남지 않게 정리
const cleanup = async () => { await ctx.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); };
process.on("SIGINT", async () => { console.log("\n멈췄어요. 아무것도 올리지 않았어요."); await cleanup(); process.exit(130); });
let closed = false;
ctx.on("close", () => { closed = true; rmSync(dir, { recursive: true, force: true }); });   // 브라우저 창을 통째로 닫은 경우
const waiters = new Map();
await ctx.exposeBinding("ksDone", ({ page }, action) => waiters.get(page)?.(action));

async function main() {
  // ① 앱스토어에 관리자로 로그인 → 로그인이 필요한 앱 목록을 받아 옴
  console.log("① 열린 창에서 KS 앱스토어에 관리자 계정으로 로그인해 주세요.");
  const store = ctx.pages()[0] || await ctx.newPage();
  await store.goto(STORE);
  const stopStore = banner(store, "① KS 앱스토어에 관리자 계정으로 로그인해 주세요. 로그인되면 저절로 다음 단계로 넘어가요.", []);
  let apps = null;
  for (let t = 0; t < 600 && !apps && !store.isClosed(); t++) {   // 최대 20분 기다림
    await sleep(2000);
    apps = await store.evaluate(() => window.App?.guideLoginApps?.() ?? null).catch(() => null);
  }
  stopStore();
  if (!apps) { console.log(closed || store.isClosed() ? "창을 닫아서 멈췄어요. 아무것도 올리지 않았어요." : "20분 동안 앱스토어 로그인이 확인되지 않아 멈췄어요. 다시 실행해 주세요."); return 1; }
  const storeOrigin = new URL(STORE).origin;
  apps = apps.filter(a => { try { return new URL(a.url).origin !== storeOrigin; } catch { return false; } });
  if (!apps.length) { console.log("로그인이 필요한 앱이 없어요. 할 일이 없네요!"); return 0; }
  console.log(`로그인이 필요한 앱 ${apps.length}개: ${apps.map(a => a.name).join(", ")}`);

  // ② 앱마다 직접 로그인
  const done = [];
  for (const [i, ap] of apps.entries()) {
    console.log(`② (${i + 1}/${apps.length}) '${ap.name}'에 로그인해 주세요.`);
    const page = await ctx.newPage();
    page.on("close", () => waiters.get(page)?.("skip"));      // 창을 그냥 닫으면 건너뛴 걸로
    await page.goto(ap.url).catch(() => {});
    const stop = banner(page, `② (${i + 1}/${apps.length}) ‘${ap.name}’에 로그인해 주세요. 가이드 사진은 회원 모두가 보니, 가능하면 가이드용 계정이 좋아요. 로그인 후 앱 첫 화면이 보이면 ‘로그인 끝’을 눌러요.`,
      [["건너뛰기", "skip", false], ["로그인 끝 ✓", "done", true]]);
    if (AUTO) setTimeout(() => page.click("#ks-bar button:last-child").catch(() => {}), 4000);
    const act = await new Promise(r => waiters.set(page, r));
    stop();
    if (act === "done") { done.push(ap); console.log("   → 로그인 기록함"); } else console.log("   → 건너뜀");
    await sleep(800);                         // 로그인 정보가 저장될 시간을 조금 줌
    if (!page.isClosed()) await page.close();
  }
  if (!done.length) { console.log("기록한 앱이 없어 아무것도 올리지 않았어요."); return 0; }

  // ③ 로그인 상태만 골라 담기 (그 앱들의 쿠키 + 로그인 정보 저장소만, 앱 데이터 저장소는 뺌)
  const origins = new Set(done.map(a => new URL(a.url).origin));
  const hosts = [...origins].map(o => new URL(o).hostname);
  const st = await ctx.storageState({ indexedDB: true });
  const pick = (maxItem) => ({
    cookies: st.cookies.filter(c => hosts.some(h => h === c.domain.replace(/^\./, "") || h.endsWith("." + c.domain.replace(/^\./, "")))),
    origins: st.origins.filter(o => origins.has(o.origin)).map(o => ({
      origin: o.origin,
      localStorage: (o.localStorage || []).filter(it => it.value.length <= maxItem),
      indexedDB: (o.indexedDB || []).filter(db => /firebase|auth|session|token/i.test(db.name) && !/firestore/i.test(db.name)),
    })),
  });
  const pack = obj => gzipSync(Buffer.from(JSON.stringify(obj))).toString("base64");
  let data = pack(pick(8000));
  if (data.length > MAX_SECRET) data = pack(pick(1000));
  if (data.length > MAX_SECRET) { console.log("로그인 기록이 너무 커서 올리지 못했어요. Claude에게 알려 주세요."); return 1; }

  if (DRY) { console.log(`[리허설] 올릴 로그인 기록: 앱 ${done.length}개, 크기 ${data.length}자 (한도 ${MAX_SECRET}) — 실제로는 올리지 않았어요.`); return 0; }
  // ④ GitHub 비밀값으로 올리고 가이드를 바로 새로 만들기 (값은 화면에 찍지 않음)
  const up = spawnSync("gh", ["secret", "set", "APP_SESSIONS", "--repo", REPO], { input: data, encoding: "utf8" });
  if (up.status !== 0) { console.log("GitHub에 올리지 못했어요. gh 로그인을 확인해 주세요."); return 1; }
  console.log(`③ 로그인 기록 ${done.length}개를 GitHub에 안전하게 올렸어요.`);
  const run = spawnSync("gh", ["workflow", "run", "app-guides.yml", "--repo", REPO, "-f", "force=true"], { encoding: "utf8" });
  console.log(run.status === 0 ? "④ 가이드 새로 만들기를 시작했어요. 5분쯤 뒤 앱스토어에서 확인해 보세요." : "④ 가이드 실행은 내일 새벽에 자동으로 돌아요.");
  return 0;
}

let code = 0;
try { code = await main(); }
catch (e) { console.log(closed ? "창을 닫아서 멈췄어요. 아무것도 올리지 않았어요." : "문제가 생겼어요: " + String(e?.message || e).split("\n")[0]); code = 1; }
finally {
  await ctx.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });           // 내 컴퓨터에 남은 로그인 흔적 지우기
}
process.exit(code);
