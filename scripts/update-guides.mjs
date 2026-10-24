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
import admin from "firebase-admin";
import { chromium, devices } from "playwright";
import sharp from "sharp";

const GUIDE_EXCLUDE = ["업무관리지원", "네모냥이"];        // index.html 의 GUIDE_EXCLUDE 와 같게
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash"];
const REFERER = "https://aznail1980-ctrl.github.io/";       // 키 사용처를 이 사이트로 제한해 둔 경우 통과용
const FORCE = process.env.FORCE === "true";                 // 바뀐 게 없어도 전부 새로 만들기
const ONLY = (process.env.ONLY_APP || "").trim();           // 한 앱만 (앱 ID 또는 이름 일부)
const MAX_SHOTS = 3;
const SHOT_WIDTH = 540;                                     // 저장하는 사진 폭(px)
const SHOT_MAX_BYTES = 150_000;                             // 장당 이보다 크면 더 줄임 (문서 하나 1MB 제한)

const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
const excluded = ap => ap.noGuide === true || GUIDE_EXCLUDE.some(n => norm(ap.name).includes(norm(n)));
const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 24);
const tag = id => `[${String(id).slice(0, 4)}]`;
// 오류 문구에 들어 있는 주소는 가림
const clean = e => String(e?.message || e).split("\n")[0].replace(/https?:\/\/\S+/g, "[주소]").replace(/[\w-]+(\.[\w-]+)+\.(app|dev|com|net|io|kr)\b/g, "[주소]").slice(0, 160);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
const ctx = await browser.newContext({ ...devices["Pixel 7"], locale: "ko-KR", timezoneId: "Asia/Seoul" });

// ── 1. 화면 찍기 ─────────────────────────────────────────
async function capture(url) {
  const page = await ctx.newPage();
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
async function writeWithAI(ap, images, pageText) {
  if (!KEY) return null;
  const n = images.length;
  const prompt =
    `당신은 작은 앱스토어 'KS 앱스토어'의 안내 담당이에요. ${n ? `첨부한 앱 화면 사진 ${n}장(순서대로 1~${n}번)과 ` : ""}아래 정보를 보고 JSON 하나로만 답하세요.\n` +
    `- description: 앱 소개 두 문장, 합쳐서 90자 안팎. 친구에게 슬쩍 추천하듯 다정하고 재치 있게. 첫 문장은 무엇을 하는 앱인지, 둘째 문장은 언제 쓰면 좋은지. 과장이나 없는 기능은 쓰지 마세요.\n` +
    `- features: 이 앱으로 할 수 있는 일 3~5개, 각각 12자 이내.\n` +
    `- oneLine: 가이드 맨 위에 둘 한 줄 요약, 30자 이내.\n` +
    (n ? `- steps: 사진마다 한 줄씩, 정확히 ${n}개. 각 35자 이내. 그 화면에서 무엇을 보고 무엇을 누르면 되는지 쉬운 말로. 사진에 안 보이는 건 쓰지 마세요. 로그인 화면이면 "가입하거나 로그인해서 시작해요"처럼 그대로 안내하세요.\n` : `- steps: 빈 배열.\n`) +
    `이모지와 마크다운은 쓰지 마세요.\n` +
    `{"description":"","features":[],"oneLine":"","steps":[]}\n\n` +
    `[앱 이름] ${ap.name || ""}\n[카테고리] ${ap.category || "기타"}\n[종류] ${ap.apkUrl ? "안드로이드 앱(APK)" : "웹앱"}\n` +
    `[관리자 메모] ${ap.aiMemo || "(없음)"}\n[지금 소개] ${ap.description || "(없음)"}\n[화면 글자 일부] ${pageText || "(없음)"}`;
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
          steps: (Array.isArray(j.steps) ? j.steps : []).map(s => tidy(s, 70)).slice(0, n),
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
    let cap = null;
    if (ap.url && !ap.apkUrl) {
      try { cap = await capture(ap.url); }
      catch (e) { console.log(`${tag(ap.id)} 화면을 못 찍었어요: ${clean(e)}`); }
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
    const ai = await writeWithAI(ap, images, cap?.text);

    // 가이드 저장 (제외 앱은 사진을 저장하지 않음)
    const hasGuide = !off && (images.length > 0);
    if (hasGuide) {
      const gd = { appId: ap.id, updatedAt: now, status: ai ? "ok" : "no-ai" };
      if (cap?.shots?.length) gd.shots = cap.shots.map(src => ({ src }));
      if (ai) { gd.oneLine = ai.oneLine; gd.steps = ai.steps; }
      await gRef.set(gd, { merge: true });                      // merge: 직접 올린 사진(manualShots)은 그대로 둠
    }
    // 앱 문서: 가이드 날짜 + (자동 소개를 켠 앱이면) 소개 바꾸기
    const upd = { guideStatus: off ? "off" : hasGuide ? "ok" : "none" };
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
    console.log(`${tag(ap.id)} ${off ? "가이드 제외 · " : ""}${hasGuide ? `사진 ${images.length}장` : "사진 없음"}${ai ? " · AI 글 완료" : KEY ? " · AI 실패(내일 다시)" : ""}`);
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
