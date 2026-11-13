// Firebase 연결 모듈 (인증 + Firestore + App Check + AI 사진 인식)
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import {
  initializeFirestore, memoryLocalCache, collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app-check.js";
import { getAI, getGenerativeModel, GoogleAIBackend } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-ai.js";
import { firebaseConfig, OWNER_EMAIL, APP_CHECK_SITE_KEY, APP_CHECK_PROVIDER, GEMINI_MODELS } from "./firebase-config.js";

let app, auth, db, ai = null;

export async function init() {
  app = initializeApp(firebaseConfig);
  // App Check: 이 사이트에서 보낸 요청만 AI 기능을 쓸 수 있게 함 (키가 있을 때만)
  if (APP_CHECK_SITE_KEY) {
    try {
      const provider = APP_CHECK_PROVIDER === "enterprise"
        ? new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY)
        : new ReCaptchaV3Provider(APP_CHECK_SITE_KEY);
      initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
      ai = getAI(app, { backend: new GoogleAIBackend() });
    } catch (e) { console.error("App Check", e); ai = null; }
  }
  auth = getAuth(app);
  auth.languageCode = "ko";
  // 메모리 캐시만 사용: 브라우저에 장부 데이터를 남기지 않음
  db = initializeFirestore(app, { localCache: memoryLocalCache() });
  try { await getRedirectResult(auth); } catch (e) { console.warn(e); }
}

export function onUser(cb) { return onAuthStateChanged(auth, cb); }

export async function login(remember) {
  await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account", login_hint: OWNER_EMAIL });
  try {
    await signInWithPopup(auth, p);
  } catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) {
      return signInWithRedirect(auth, p);
    }
    throw e;
  }
}

export function logout() { return signOut(auth); }
export function currentEmail() { return (auth.currentUser && auth.currentUser.email || "").toLowerCase(); }
export function isVerified() { return !!(auth.currentUser && auth.currentUser.emailVerified); }

export function watch(col, next, err) {
  return onSnapshot(collection(db, col), s => {
    const m = {};
    s.forEach(d => { m[d.id] = d.data(); });
    next(m, s.metadata.fromCache);
  }, err);
}

export function put(col, id, data) { return setDoc(doc(db, col, id), data); }
export function del(col, id) { return deleteDoc(doc(db, col, id)); }

// 백업 복원: 400건씩 나눠 일괄 저장
export async function restoreAll(payload) {
  const items = [];
  for (const col of ["accounts", "days", "ledger"]) {
    for (const [id, data] of Object.entries(payload[col] || {})) items.push([col, id, data]);
  }
  for (let i = 0; i < items.length; i += 400) {
    const b = writeBatch(db);
    items.slice(i, i + 400).forEach(([c, id, d]) => b.set(doc(db, c, id), d));
    await b.commit();
  }
  return items.length;
}

/* ---------- 마감 화면 사진 인식 ---------- */
export function aiReady() { return !!ai; }

const PROMPT = `이 이미지는 한국 약국 관리 프로그램(예: PMIT3000)의 '약국통계' 마감 화면입니다.
화면에 보이는 숫자를 그대로 읽어서 아래 JSON 형식으로만 답하세요. 설명 문장은 쓰지 마세요.
- 숫자는 쉼표 없는 정수로 씁니다 (예: 1,326,710 → 1326710).
- 화면에 없거나, 잘려서 보이지 않거나, 확실하지 않은 값은 null로 씁니다. 절대 추측하거나 계산해서 채우지 마세요.
- 날짜는 YYYY-MM-DD 형식입니다.

{
  "dateFrom": "조회기간 시작 날짜",
  "dateTo": "조회기간 끝 날짜",
  "rx_total": "'처방조제통계' 표에서 '총 계' 행의 '수납금액' 열 값",
  "rx_card": "'처방조제통계' 표에서 '카드승인' 행의 '수납금액' 열 값",
  "rx_cash": "'처방조제통계' 표에서 '현금결제' 행의 '수납금액' 열 값",
  "rx_cash_receipt": "'처방조제통계' 표에서 '현금영수증' 행의 '수납금액' 열 값",
  "otc_total": "'약품판매통계' 표에서 '총 계' 행의 '입금액' 열 값",
  "otc_card": "'약품판매통계' 표에서 '카드승인' 행의 '입금액' 열 값",
  "otc_cash": "'약품판매통계' 표에서 '현금결제' 행의 '입금액' 열 값",
  "otc_cash_receipt": "'약품판매통계' 표에서 '현금영수증' 행의 '입금액' 열 값",
  "otc_credit": "'약품판매통계' 표에서 '총 계' 행의 '외상금액' 열 값",
  "customer_credit": "오른쪽 아래 '고객 외상장' 값",
  "rx_sales": "오른쪽 아래 '조제매출금액' 값",
  "otc_sales": "오른쪽 아래 '판매매출금액' 값"
}`;

export async function readClosingImage(base64, mimeType) {
  if (!ai) throw Object.assign(new Error("AI 미설정"), { code: "not-configured" });
  let lastErr = null;
  const tried = [];
  for (const name of GEMINI_MODELS) {
    try {
      const model = getGenerativeModel(ai, { model: name, generationConfig: { responseMimeType: "application/json" } }, { timeout: 90000 });
      let r;
      for (let attempt = 0; ; attempt++) {
        try { r = await model.generateContent([PROMPT, { inlineData: { data: base64, mimeType } }]); break; }
        catch (e2) {
          // 서버 혼잡(503/500/시간 초과)이면 같은 모델로 한 번 더, 그래도 안 되면 다음 모델로
          if (attempt === 0 && /\b50[034]\b|UNAVAILABLE|Deadline|overloaded|timed? ?out/i.test(String(e2 && e2.message))) { await new Promise(res => setTimeout(res, 1500)); continue; }
          throw e2;
        }
      }
      const txt = r.response.text().replace(/^```(?:json)?\s*|\s*```$/g, "");
      return { data: JSON.parse(txt), model: name };
    } catch (e) {
      lastErr = e;
      const msg = String(e && (e.message || e));
      tried.push(name + ": " + msg.slice(0, 160));
      // 모델이 없거나(404) 이 모델의 무료 한도가 없거나 찼으면(429) 다음 모델로
      if (/\b404\b|not found|NOT_FOUND|is not supported|no longer available|\b429\b|RESOURCE_EXHAUSTED|quota|\b50[034]\b|UNAVAILABLE|Deadline|overloaded|timed? ?out/i.test(msg)) continue;
      throw e;
    }
  }
  const err = lastErr || new Error("사용 가능한 모델이 없습니다");
  try { err.tried = tried; } catch (_) {}
  throw err;
}
