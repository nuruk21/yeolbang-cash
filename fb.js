// Firebase 연결 모듈 (인증 + Firestore)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, memoryLocalCache, collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";

let auth, db;

export async function init() {
  const app = initializeApp(firebaseConfig);
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
