// ════════════════════════════════════════════════════════════
//  KS 앱스토어 — 초간단 가이드 · AI 소개 자동 만들기
//
//  하는 일 (앱 하나마다)
//   1. 휴대폰 크기 브라우저로 앱을 열어 화면을 최대 3장 찍음
//   2. 화면 글자·파일 목록으로 '지문'을 만들어 어제와 비교 → 바뀐 앱만 다음 단계로
//   3. Gemini에게 사진을 보여 주고 한 줄 요약 · 화면별 설명 · 앱 소개를 받음
//   4. Firestore guides/앱ID (가이드), apps/앱ID (소개) 에 저장
//
//  누가 돌리나: GitHub Actions (.github/workflows/app-guides.yml), 매일 새벽 3시(한국 시간)
//  필요한 비밀값: FIREBASE_SERVICE_ACCOUNT (필수), GEMINI_API_KEY (선택 — 없으면 앱스토어 설정의 키를 씀)
//
//  ⚠️ 저장소가 공개라서 실행 기록(로그)도 누구나 볼 수 있어요.
//     앱 이름·주소는 로그에 찍지 않고, 앱 ID 앞 4글자만 찍습니다.
// ════════════════════════════════════════════════════════════
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import admin from "firebase-admin";
import { chromium, devices } from "playwright";
import sharp from "sharp";

const GUIDE_EXCLUDE = ["업무관리지원", "네모냥이"];        // index.html 의 GUIDE_EXCLUDE 와 같게
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash"];
const REFERER = "https://aznail1980-ctrl.github.io/";       // 키 사용처를 이 사이트로 제한해 둔 경우 통과용
const FORCE = process.env.FORCE === "true";                 // 바뀐 게 없어도 전부 새로 만들기
const ONLY = (process.env.ONLY_APP || "").trim();           // 한 앱만 (앱 ID 또는 이름 일부)
const MAX_SHOTS = 4;
const SHOT_WIDTH = 540;                                     // 저장하는 사진 폭(px)
const SHOT_MAX_BYTES = 150_000;                             // 장당 이보다 크면 더 줄임 (문서 하나 1MB 제한)

const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
const excluded = ap => ap.noGuide === true || GUIDE_EXCLUDE.some(n => norm(ap.name).includes(norm(n)));
const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 24);
const tag = id => `[${String(id).slice(0, 4)}]`;
// 오류 문구에 들어 있는 주소는 가림
const clean = e => String(e?.message || e).split("\n")[0].replace(/https?:\/\/\S+/g, "[주소]").replace(/[\w-]+(\.[\w-]+)+\.(app|dev|com|net|io|kr)\b/g, "[주소]").slice(0, 160);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 관리자가 처음에 직접 쓴 소개 (AI가 덮어쓰면 descManual 에 보관) — AI가 예전에 쓴 글을 다시 근거로 쓰지 않음
const origDesc = ap => ap.descManual || (ap.descBy !== "ai" ? ap.description : "") || "";

// ── 0. 준비 ─────────────────────────────────────────────
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.log("::warning::FIREBASE_SERVICE_ACCOUNT 비밀값이 없어 건너뜁니다. 앱스토어 관리 → 설정의 '처음 한 번 연결하는 방법'을 보세요.");
  process.exit(0);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

let KEY = (process.env.GEMINI_API_KEY || "").trim();
if (!KEY) KEY = (await db.doc("config/ai").get()).data()?.geminiKey || "";
if (KEY) console.log("::add-mask::" + KEY);

const apps = (await db.collection("apps").get()).docs.map(d => ({ id: d.id, ...d.data() }));
// 로그에 앱 이름·주소가 혹시라도 찍히면 *** 로 가려지게 등록
for (const ap of apps) {
  for (const v of [ap.url, ap.apkUrl, ap.name]) if (v && String(v).length >= 3) console.log("::add-mask::" + v);
  try { if (ap.url) console.log("::add-mask::" + new URL(ap.url).hostname); } catch {}
}
console.log(`앱 ${apps.length}개${FORCE ? " · 전부 새로 만들기" : ""}${ONLY ? " · 한 앱만" : ""}${KEY ? "" : " · AI 키 없음(사진만 찍음)"}`);

const browser = await chromium.launch();
const DEVICE = { ...devices["Pixel 7"], locale: "ko-KR", timezoneId: "Asia/Seoul" };
const ctx = await browser.newContext(DEVICE);

// 로그인 앱의 '한 번 로그인' 기록 (내 맥에서 record-logins.mjs 로 만든 GitHub 비밀값 APP_SESSIONS)
// 이 열쇠로 앱을 열면 로그인된 화면이 보여서 실제 화면을 찍을 수 있음. 내용은 절대 로그에 찍지 않음.
let SESSIONS = { cookies: [], origins: [] };
if (process.env.APP_SESSIONS) {
  try { SESSIONS = JSON.parse(gunzipSync(Buffer.from(process.env.APP_SESSIONS, "base64")).toString("utf8")); }
  catch { console.log("::warning::로그인 기록을 읽지 못했어요. 내 맥에서 record-logins.mjs 를 다시 실행해 주세요."); }
}
function sessionFor(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const origin = SESSIONS.origins.find(o => o.origin === u.origin);
  const cookies = SESSIONS.cookies.filter(c => { const d = c.domain.replace(/^\./, ""); return u.hostname === d || u.hostname.endsWith("." + d); });
  return origin || cookies.length ? { cookies, origins: origin ? [origin] : [] } : null;
}
console.log(`로그인 기록 ${SESSIONS.origins.length}개`);

// ── 1. 화면 찍기 ─────────────────────────────────────────
async function capture(url, context = ctx) {
  const page = await context.newPage();
  page.on("dialog", d => d.dismiss().catch(() => {}));   // '정말 ~할까요?' 같은 창이 뜨면 항상 '취소'
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await sleep(2500);                                         // 첫 화면 애니메이션이 끝나길 기다림
    // 지문 재료: 제목, 설명, 파일 목록(배포하면 이름이 바뀜), 화면 글자(숫자는 날마다 바뀌니 뺌)
    const info = await page.evaluate(() => {
      // 페이지 자체가 길면 창을, 아니면 안쪽에서 가장 큰 스크롤 영역을 내려 가며 찍음
      const vh = innerHeight;
      let scroller = document.scrollingElement;
      if (!scroller || scroller.scrollHeight < vh * 1.4) {
        const cand = [...document.querySelectorAll("body *")].filter(el => {
          const s = getComputedStyle(el);
          return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight * 1.4 && el.clientHeight > vh * .4;
        }).sort((a, b) => b.clientHeight - a.clientHeight)[0];
        if (cand) { cand.setAttribute("data-ks-scroll", "1"); scroller = cand; }
      }
      return {
        title: document.title || "",
        meta: document.querySelector('meta[name="description"]')?.content || "",
        assets: [...document.querySelectorAll("script[src],link[rel=stylesheet][href]")].map(e => (e.src || e.href).split("?")[0]).sort().join("|"),
        text: (document.body?.innerText || "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 4000),
        steps: scroller ? Math.min(3, Math.floor(scroller.scrollHeight / (scroller.clientHeight || vh) + .4)) : 1,
        inner: scroller?.hasAttribute?.("data-ks-scroll") || false,
      };
    });
    const raws = [];
    for (let k = 0; k < Math.max(1, info.steps) && raws.length < MAX_SHOTS; k++) {
      if (k) {
        await page.evaluate(([k, inner]) => {
          const el = inner ? document.querySelector("[data-ks-scroll]") : document.scrollingElement;
          el.scrollTo(0, Math.round((el.clientHeight || innerHeight) * .85 * k));
        }, [k, info.inner]);
        await sleep(800);
      }
      const png = await page.screenshot({ type: "png" });
      if (!(await isDuplicate(png, raws))) raws.push(png);
    }
    // 앱처럼 생긴 화면은 스크롤이 없어서 한 장뿐 → 아래쪽 메뉴 탭(홈/기록/통계 같은)을 눌러 다른 화면도 찍음.
    // 지우기·결제·로그아웃·보내기 같은 버튼, 다른 사이트로 가는 링크는 절대 누르지 않음.
    if (raws.length < MAX_SHOTS) {
      await page.evaluate(() => { const el = document.querySelector("[data-ks-scroll]") || document.scrollingElement; el.scrollTo(0, 0); });
      const n = await page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const bad = /삭제|지우|로그아웃|탈퇴|결제|구매|주문|송금|보내|전송|초기화|리셋|공유|신고|delete|remove|logout|log out|sign ?out|pay|buy|order|send|reset|share/i;
        const inNav = el => el.closest('nav, footer, [role="tablist"], [role="navigation"], [class*="tab" i], [class*="nav" i]');
        const seen = new Set(), picks = [];
        // 1순위: 화면 아래쪽 메뉴 막대의 작은 버튼, 2순위: 화면 어디든 '탭'으로 표시된 버튼
        const all = [...document.querySelectorAll('a, button, [role="tab"]')];
        const score = el => { const r = el.getBoundingClientRect(); return r.top >= vh * 0.72 ? 0 : 1; };
        for (const el of all.sort((a, b) => score(a) - score(b))) {
          const r = el.getBoundingClientRect();
          const txt = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
          const isTab = el.matches('[role="tab"], [role="tablist"] *');
          if (!r.width || !r.height || r.bottom > vh + 2 || r.top < 0 || r.width > vw * 0.5) continue;      // 지금 화면에 보이는 작은 버튼만
          if (!isTab && r.top < vh * 0.72) continue;
          if (!(isTab || inNav(el)) || !txt || txt.length > 12 || bad.test(txt) || seen.has(txt)) continue;
          if (el.matches('[aria-current="page"], [aria-selected="true"], [disabled]')) continue;                    // 지금 보고 있는 탭은 건너뜀
          if (el.tagName === "A") {
            const href = el.getAttribute("href") || "";
            if (el.target === "_blank" || /^(mailto|tel|javascript):/i.test(href)) continue;
            try { if (new URL(href, location.href).origin !== location.origin) continue; } catch { continue; }
          }
          seen.add(txt); picks.push(el);
        }
        picks.slice(0, 5).forEach((el, i) => el.setAttribute("data-ks-tap", String(i)));
        return Math.min(picks.length, 5);
      });
      const home = new URL(page.url()).origin;
      for (let i = 0; i < n && raws.length < MAX_SHOTS; i++) {
        try {
          await page.locator(`[data-ks-tap="${i}"]`).first().click({ timeout: 3000 });
          await sleep(1500);
          if (new URL(page.url()).origin !== home) break;                                 // 다른 사이트로 넘어가면 그만
          const png = await page.screenshot({ type: "png" });
          if (!(await isDuplicate(png, raws))) raws.push(png);
        } catch {}
      }
    }
    const shots = [];
    for (const png of raws) shots.push(await toWebp(png));
    return { shots, sig: sha([info.title, info.meta, info.assets, info.text].join("\n")), text: info.text.slice(0, 600), title: info.title };
  } finally { await page.close().catch(() => {}); }
}
// 거의 같은 사진이면(스크롤해도 화면이 안 바뀐 경우) 빼기
async function isDuplicate(png, list) {
  const tiny = b => sharp(b).resize(16, 32, { fit: "fill" }).grayscale().raw().toBuffer();
  const a = await tiny(png);
  for (const other of list) {
    const b = await tiny(other);
    let diff = 0; for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    if (diff / a.length < 4) return true;
  }
  return false;
}
async function toWebp(png) {
  let q = 70, w = SHOT_WIDTH, out;
  for (let tries = 0; tries < 4; tries++) {
    out = await sharp(png).resize({ width: w }).webp({ quality: q }).toBuffer();
    if (out.length <= SHOT_MAX_BYTES) break;
    q -= 12; w -= 40;
  }
  return "data:image/webp;base64," + out.toString("base64");
}

// ── 2. AI에게 쓰게 하기 ──────────────────────────────────
async function writeWithAI(ap, images, pageText, { manual = false } = {}) {
  if (!KEY) return null;
  const n = images.length;
  const prompt =
    `당신은 작은 앱스토어 'KS 앱스토어'의 안내 담당이에요. ${n ? `첨부한 앱 화면 사진 ${n}장(순서대로 1~${n}번)과 ` : ""}아래 정보를 보고 JSON 하나로만 답하세요.\n` +
    `- description: 앱 소개 두 문장, 합쳐서 90자 안팎. 친구에게 슬쩍 추천하듯 다정하고 재치 있게. 첫 문장은 무엇을 하는 앱인지, 둘째 문장은 언제 쓰면 좋은지. 과장이나 없는 기능은 쓰지 마세요.\n` +
    `- features: 이 앱으로 할 수 있는 일 3~5개, 각각 12자 이내.\n` +
    `- oneLine: 가이드 맨 위에 둘 한 줄 요약, 30자 이내.\n` +
    (n ? `- shots: 사진마다 하나씩, 정확히 ${n}개, 순서대로. 각각 {"keep": true 또는 false, "step": "설명"}.\n` +
         `  keep: ${manual ? "모두 true." : "로그인·회원가입·비밀번호 입력 화면, 빈 화면, 로딩 화면, 오류 화면이면 false. 앱의 실제 기능이 보이는 화면이면 true."}\n` +
         `  step: 그 화면에서 무엇을 보고 무엇을 누르면 되는지 35자 이내의 쉬운 말. 사진에 안 보이는 건 쓰지 마세요. keep이 false면 빈칸.\n`
       : `- shots: 빈 배열.\n`) +
    `- 근거 규칙: 이 앱에 대해 확실한 건 [관리자가 쓴 원래 소개], [관리자 메모], 그리고 실제 앱 화면(로그인 화면 제외)뿐이에요. 앱 이름이나 주소만 보고 무슨 앱인지 짐작하지 마세요(예: 이름에 Rich가 있다고 돈·주식 앱이라고 쓰면 안 돼요). 근거가 부족하면 확실한 내용만 짧게 쓰세요. 로그인 화면 사진이나 로그인 화면 글자는 앱 내용의 근거가 아니에요.\n` +
    `이모지와 마크다운은 쓰지 마세요.\n` +
    `{"description":"","features":[],"oneLine":"","shots":[{"keep":true,"step":""}]}\n\n` +
    `[앱 이름] ${ap.name || ""}\n[카테고리] ${ap.category || "기타"}\n[종류] ${ap.apkUrl ? "안드로이드 앱(APK)" : "웹앱"}\n` +
    `[관리자 메모] ${ap.aiMemo || "(없음)"}\n[관리자가 쓴 원래 소개] ${origDesc(ap) || "(없음)"}\n[화면 글자 일부] ${pageText || "(없음)"}`;
  const parts = [{ text: prompt }];
  for (const src of images) {
    const m = String(src).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": KEY, Referer: REFERER },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.8 } }),
        });
        const data = await res.json();
        if (res.status === 429 || res.status >= 500) { await sleep(8000); continue; }   // 잠깐 쉬었다 다시
        if (res.status === 404) break;                                                    // 다음 모델로
        if (!res.ok) { console.log(`  AI 오류 ${res.status}: ${clean(data?.error?.message)}`); return null; }
        const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
        const j = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || "null");
        if (!j?.description) return null;
        const tidy = (s, max) => String(s || "").replace(/\*\*|__|`|#/g, "").trim().slice(0, max);
        return {
          description: tidy(j.description, 300),
          features: (Array.isArray(j.features) ? j.features : []).map(f => tidy(f, 20)).filter(Boolean).slice(0, 5),
          oneLine: tidy(j.oneLine, 60),
          // 사진별 판단: 남길지(keep) + 설명(step). 답이 모자라면 남기는 쪽으로
          shots: Array.from({ length: n }, (_, i) => {
            const s = Array.isArray(j.shots) ? j.shots[i] : null;
            return { keep: manual || s?.keep !== false, step: tidy(s?.step ?? j.steps?.[i] ?? "", 70) };
          }),
        };
      } catch (e) { console.log(`  AI 호출 실패: ${clean(e)}`); await sleep(3000); }
    }
  }
  return null;
}

// ── 3. 앱마다 돌기 ────────────────────────────────────────
const stat = { checked: 0, updated: 0, failed: 0, skipped: 0 };
for (const ap of apps) {
  if (ONLY && ap.id !== ONLY && !norm(ap.name).includes(norm(ONLY))) continue;
  stat.checked++;
  const off = excluded(ap);
  const gRef = db.doc(`guides/${ap.id}`);
  try {
    const g = (await gRef.get()).data() || {};
    const manual = (g.manualShots || []).filter(s => s?.src);
    let cap = null, usedSession = false;
    if (ap.url && !ap.apkUrl) {
      const sess = sessionFor(ap.url);
      usedSession = !!sess;
      const sctx = sess ? await browser.newContext({ ...DEVICE, storageState: sess }) : ctx;   // 로그인 기록이 있으면 로그인된 상태로 열기
      try { cap = await capture(ap.url, sctx); }
      catch (e) { console.log(`${tag(ap.id)} 화면을 못 찍었어요: ${clean(e)}`); }
      finally { if (sctx !== ctx) await sctx.close().catch(() => {}); }
    }
    // 지문: 앱 정보 + 화면 지문 + 직접 올린 사진
    const fp = sha(JSON.stringify([
      ap.name, ap.url, ap.apkUrl, ap.category, ap.aiMemo || "", ap.autoDesc !== false, off,
      cap?.sig || "", manual.map(s => s.src.length + s.src.slice(-24)),
    ]));
    const needDesc = ap.autoDesc !== false && (!ap.description || ap.descBy !== "ai");
    if (!FORCE && fp === ap.autoFp && !needDesc) { stat.skipped++; console.log(`${tag(ap.id)} 바뀐 것 없음`); continue; }

    // AI에게 보여 줄 사진: 직접 올린 사진이 있으면 그것, 없으면 방금 찍은 사진
    const images = manual.length ? manual.map(s => s.src) : (cap?.shots || []);
    const ai = await writeWithAI(ap, images, cap?.text, { manual: manual.length > 0 });

    // AI가 '로그인 화면·빈 화면'이라고 한 사진은 뺌 (직접 올린 사진은 모두 남김)
    const keep = images.map((_, i) => i).filter(i => !ai || ai.shots[i]?.keep !== false);
    const loginOnly = !manual.length && images.length > 0 && keep.length === 0;
    const kept = manual.length ? [] : keep.map(i => cap.shots[i]);

    // 가이드 저장 (제외 앱은 사진을 저장하지 않음)
    const hasGuide = !off && (images.length > 0);
    if (hasGuide) {
      const gd = { appId: ap.id, updatedAt: now, status: ai ? "ok" : "no-ai", loginOnly };
      if (cap?.shots?.length) gd.shots = kept.map(src => ({ src }));   // 로그인 화면뿐이면 빈 목록 (예전 로그인 사진도 지움)
      if (ai) { gd.oneLine = ai.oneLine; gd.steps = keep.map(i => ai.shots[i]?.step || ""); }
      await gRef.set(gd, { merge: true });                      // merge: 직접 올린 사진(manualShots)은 그대로 둠
    }
    // 앱 문서: 가이드 날짜 + (자동 소개를 켠 앱이면) 소개 바꾸기
    const upd = { guideStatus: off ? "off" : loginOnly ? "login" : hasGuide ? "ok" : "none" };
    if (loginOnly || usedSession) upd.needsLogin = true;      // 로그인이 필요한 앱이라고 기억 (로그인 기록 만들 때 목록에 나옴)
    if (hasGuide) upd.guideAt = now;
    if (ai) {
      upd.autoFp = fp;                                          // AI까지 성공했을 때만 '처리함'으로 기록 → 실패하면 내일 다시
      if (ap.autoDesc !== false) {
        Object.assign(upd, { description: ai.description, features: ai.features, descBy: "ai", descAt: now });
        if (ap.description && ap.descBy !== "ai" && !ap.descManual) upd.descManual = ap.description;   // 직접 썼던 소개는 보관
      }
    }
    await db.doc(`apps/${ap.id}`).update(upd);
    stat.updated++;
    console.log(`${tag(ap.id)} ${off ? "가이드 제외 · " : ""}${manual.length ? `직접 올린 사진 ${manual.length}장` : loginOnly ? (usedSession ? "로그인 기록이 만료된 듯(다시 기록 필요)" : "로그인 필요(로그인 기록을 만들면 자동 촬영)") : hasGuide ? `${usedSession ? "로그인해서 " : ""}사진 ${kept.length}장${kept.length < images.length ? ` (로그인 화면 ${images.length - kept.length}장 뺌)` : ""}` : "사진 없음"}${ai ? " · AI 글 완료" : KEY ? " · AI 실패(내일 다시)" : ""}`);
    await sleep(1500);                                          // 무료 사용량 한도를 넘지 않게 천천히
  } catch (e) {
    stat.failed++;
    console.log(`${tag(ap.id)} 실패: ${clean(e)}`);
  }
}

// ── 4. 지운 앱의 가이드 정리 + 실행 기록 ─────────────────────
if (!ONLY) {
  const ids = new Set(apps.map(a => a.id));
  for (const d of (await db.collection("guides").get()).docs) if (!ids.has(d.id)) { await d.ref.delete(); console.log(`${tag(d.id)} 지운 앱의 가이드 정리`); }
}
await db.doc("config/guidesRun").set({ at: now, ...stat, noAi: !KEY, force: FORCE, only: !!ONLY });
await browser.close();
console.log(`끝: 살펴봄 ${stat.checked} · 새로 만듦 ${stat.updated} · 그대로 ${stat.skipped} · 실패 ${stat.failed}`);
