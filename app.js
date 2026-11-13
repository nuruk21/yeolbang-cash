// 열방약국 현금정산 — 앱 본체
import * as fb from "./fb.js";
import { OWNER_EMAIL, IDLE_LOGOUT_MINUTES } from "./firebase-config.js";

/* ---------- 상수 ---------- */
const DENOMS = [50000, 10000, 5000, 1000, 500, 100, 50, 10];
const OUT_CATS = ['은행 입금', '현금 환불', '소모품·비품 구입', '택배·배송비', '거스름돈 교환(출금)', '개인 인출', '기타 지출'];
const IN_CATS = ['거스름돈 보충', '동전 교환(입금)', '기타 입금'];
const METHODS = { cash: '현금', card: '카드', transfer: '계좌이체' };
const KINDS = { personal: '개인 외상', facility: '요양원·기관' };
const COLS = ['days', 'accounts', 'ledger'];

/* ---------- 상태 ---------- */
const S = {
  phase: 'boot', // boot | login | denied | app
  email: '', loginErr: '',
  days: {}, accounts: {}, ledger: {},
  view: 'today', date: todayStr(), month: todayStr().slice(0, 7),
  selAcc: null, accMonth: todayStr().slice(0, 7), accAll: false, accFilter: 'all',
  lf: { acc: '', type: 'charge', amount: '', method: 'cash', memo: '' },
  af: { date: todayStr(), type: 'charge', amount: '', method: 'cash', memo: '' },
  loaded: false, slow: false, err: null, needRender: false, unsubs: []
};
const dirty = new Set(), timers = {}, queues = {};

/* ---------- 유틸 ---------- */
function pad(n) { return String(n).padStart(2, '0') }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); const t = new Date(y, m - 1, d + n); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) }
function addMonths(ym, n) { const [y, m] = ym.split('-').map(Number); const t = new Date(y, m - 1 + n, 1); return t.getFullYear() + '-' + pad(t.getMonth() + 1) }
function korDate(s) { const [y, m, d] = s.split('-').map(Number); const w = '일월화수목금토'[new Date(y, m - 1, d).getDay()]; return `${y}년 ${m}월 ${d}일 (${w})` }
function shortDate(s) { const [y, m, d] = s.split('-').map(Number); const w = '일월화수목금토'[new Date(y, m - 1, d).getDay()]; return `${m}/${d} (${w})` }
function korMonth(ym) { const [y, m] = ym.split('-').map(Number); return `${y}년 ${m}월` }
function won(n) { if (n == null || isNaN(n)) return '–'; return Math.round(n).toLocaleString('ko-KR') + '원' }
function sgn(n) { if (n == null) return '–'; return (n > 0 ? '+' : '') + won(n) }
function fmt(n) { return (n == null || n === '') ? '' : Number(n).toLocaleString('ko-KR') }
function parseAmt(v) {
  if (v == null) return null;
  let s = String(v).replace(/[,\s원₩]/g, '');
  if (s === '') return null;
  s = s.replace(/[+\-]+$/, '');
  if (!/^[+\-]?\d+([+\-]\d+)*$/.test(s)) { const n = parseInt(s.replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n }
  let t = 0; s.replace(/([+\-]?)(\d+)/g, (m, g, d) => { t += (g === '-' ? -1 : 1) * Number(d) }); return t;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function genId() { const a = new Uint8Array(6); crypto.getRandomValues(a); return Date.now().toString(36) + Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, 8) }
function clone(o) { return JSON.parse(JSON.stringify(o)) }
function sum(a, f) { return a.reduce((x, e) => x + (Number(f ? f(e) : e) || 0), 0) }
function cls(n) { return n == null ? '' : n === 0 ? 'zero' : n > 0 ? 'pos' : 'neg' }
function toast(m) { const t = document.getElementById('toast'); t.innerHTML = `<div>${esc(m)}</div>`; clearTimeout(toast.t); toast.t = setTimeout(() => t.innerHTML = '', 2600) }

/* ---------- 계산 ---------- */
function blankDay(d) { return { date: d, opening: null, sales: {}, cardTerminal: null, moves: [], count: {}, memo: '', closed: false } }
function countTotal(day) { const c = day && day.count || {}; const any = DENOMS.some(k => c[k] != null && c[k] !== ''); return any ? DENOMS.reduce((a, k) => a + k * (Number(c[k]) || 0), 0) : null }
function prevClosing(date) {
  const keys = Object.keys(S.days).filter(k => k < date).sort().reverse();
  for (const k of keys) { const t = countTotal(S.days[k]); if (t != null) return { date: k, actual: t } }
  return null;
}
function ledgerList() { return Object.entries(S.ledger).map(([id, e]) => ({ id, ...e })) }
function ledgerOn(date) { return ledgerList().filter(e => e.date === date) }
function calc(date) {
  const day = S.days[date] || blankDay(date), s = day.sales || {}, v = k => Number(s[k]) || 0;
  const prev = prevClosing(date);
  const openingAuto = day.opening == null;
  const opening = openingAuto ? (prev ? prev.actual : 0) : Number(day.opening);
  const cashSales = v('rxCash') + v('otcCash'), cardSales = v('rxCard') + v('otcCard'), trSales = v('rxTransfer') + v('otcTransfer');
  const led = ledgerOn(date);
  const credCharge = sum(led.filter(e => e.type === 'charge'), e => e.amount);
  const pay = m => sum(led.filter(e => e.type === 'payment' && e.method === m), e => e.amount);
  const credCash = pay('cash'), credCard = pay('card'), credTr = pay('transfer');
  const mv = day.moves || [];
  const movesIn = sum(mv.filter(m => m.dir === 'in'), m => m.amount), movesOut = sum(mv.filter(m => m.dir === 'out'), m => m.amount);
  const expected = opening + cashSales + credCash + movesIn - movesOut;
  const actual = countTotal(day);
  const diff = actual == null ? null : actual - expected;
  const cardAll = cardSales + credCard;
  return { day, prev, opening, openingAuto, cashSales, cardSales, trSales, credCharge, credCash, credCard, credTr, movesIn, movesOut, expected, actual, diff, cardAll, totalSales: cashSales + cardSales + trSales + credCharge, led };
}
function accBalance(id, upto) { return sum(ledgerList().filter(e => e.accountId === id && (!upto || e.date < upto)), e => e.type === 'charge' ? e.amount : -e.amount) }
function totalReceivable() { return sum(Object.keys(S.accounts), id => accBalance(id)) }

/* ---------- 저장 (Firestore) ---------- */
function setDoc(col, id, data) {
  if (data == null) delete S[col][id]; else S[col][id] = data;
  const p = col + '/' + id; dirty.add(p);
  clearTimeout(timers[p]); delete timers[p];
  enqueue(p, data);
}
function setDocLater(col, id, data, ms = 700) {
  S[col][id] = data;
  const p = col + '/' + id; dirty.add(p);
  clearTimeout(timers[p]);
  timers[p] = setTimeout(() => { delete timers[p]; enqueue(p, S[col][id] ?? null) }, ms);
  syncStatus();
}
function flushAll() { for (const p of Object.keys(timers)) { clearTimeout(timers[p]); delete timers[p]; const [c, id] = p.split('/'); enqueue(p, S[c][id] ?? null) } }
function enqueue(p, data) { const q = queues[p] || (queues[p] = { running: false, has: false, next: null }); q.next = data; q.has = true; if (!q.running) pump(p); syncStatus() }
async function pump(p) {
  const q = queues[p]; q.running = true;
  const [col, id] = p.split('/');
  while (q.has) {
    const d = q.next; q.has = false;
    try { if (d == null) await fb.del(col, id); else await fb.put(col, id, d); S.err = null; }
    catch (e) {
      console.error(e);
      S.err = e && e.code === 'permission-denied' ? 'denied' : 'write';
      renderBanner();
    }
  }
  q.running = false;
  if (!timers[p]) dirty.delete(p);
  syncStatus();
}
function busy() { return Object.keys(timers).length > 0 || Object.values(queues).some(q => q.running) }
function syncStatus() {
  const el = document.getElementById('sync');
  if (S.phase !== 'app') { el.classList.add('hidden'); return }
  el.classList.remove('hidden');
  if (busy()) { el.className = 'sync busy'; el.innerHTML = '<i></i><span>저장 중…</span>' }
  else { el.className = 'sync'; el.innerHTML = '<i></i><span>저장됨</span>' }
}
window.addEventListener('beforeunload', e => { flushAll(); if (busy()) { e.preventDefault(); e.returnValue = '' } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll() });

/* ---------- 로그인 ---------- */
async function boot() {
  renderAll();
  try { await fb.init() } catch (e) { console.error(e); S.phase = 'login'; S.loginErr = 'Firebase 설정(firebase-config.js)을 확인해 주세요.'; renderAll(); return }
  fb.onUser(async u => {
    S.unsubs.forEach(f => f()); S.unsubs = [];
    if (!u) { S.phase = 'login'; S.loaded = false; COLS.forEach(c => S[c] = {}); renderAll(); return }
    S.email = fb.currentEmail();
    if (S.email !== OWNER_EMAIL.toLowerCase() || !fb.isVerified()) { S.phase = 'denied'; renderAll(); return }
    S.phase = 'app'; renderAll(); subscribe();
  });
}
function subscribe() {
  const got = {};
  const timer = setTimeout(() => { if (!COLS.every(n => got[n])) { S.slow = true; renderBanner() } }, 10000);
  for (const name of COLS) {
    S.unsubs.push(fb.watch(name, (m, fromCache) => {
      for (const p of dirty) { const [n, id] = p.split('/'); if (n !== name) continue; if (id in S[name]) m[id] = S[name][id]; else delete m[id] }
      S[name] = m; got[name] = true;
      if (COLS.every(n => got[n])) { clearTimeout(timer); if (S.slow) { S.slow = false; renderBanner() } const first = !S.loaded; S.loaded = true; first ? render() : requestRender() }
    }, err => {
      console.error(err); clearTimeout(timer);
      S.err = err && err.code === 'permission-denied' ? 'readdenied' : 'read';
      got[name] = true; S.loaded = true; renderBanner(); requestRender();
    }));
  }
}
async function doLogout() {
  flushAll();
  const wait = Date.now();
  while (busy() && Date.now() - wait < 4000) await new Promise(r => setTimeout(r, 150));
  await fb.logout();
  location.replace(location.pathname); // 메모리의 데이터까지 지움
}
// 미사용 시 자동 로그아웃
let lastAct = Date.now();
['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(ev => addEventListener(ev, () => { lastAct = Date.now() }, { passive: true }));
setInterval(() => { if (S.phase === 'app' && Date.now() - lastAct > IDLE_LOGOUT_MINUTES * 60000) doLogout() }, 20000);

function renderGate() {
  const inApp = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent);
  if (S.phase === 'boot') return '<div class="loading">불러오는 중…</div>';
  if (S.phase === 'denied') return `<div class="gate"><div class="lock">!</div><h1>접근할 수 없는 계정입니다</h1>
    <p><b>${esc(S.email)}</b> 계정에는 권한이 없습니다.<br>열방약국 관리자 Gmail 계정으로 다시 로그인하세요.</p>
    <button class="gbtn" data-act="logout">다른 계정으로 로그인</button></div>`;
  return `<div class="gate"><div class="lock">+</div><h1>열방약국 현금정산</h1>
    <p>관리자 Gmail 계정으로만 들어갈 수 있습니다.</p>
    ${inApp ? '<p class="err" style="margin-bottom:14px">카카오톡·네이버 앱 안의 브라우저에서는 구글 로그인이 막힙니다. 오른쪽 위 메뉴에서 <b>다른 브라우저로 열기</b>(크롬·사파리)를 눌러 주세요.</p>' : ''}
    <button class="gbtn" data-act="login"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.7 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>Google 계정으로 로그인</button>
    <label><input type="checkbox" id="remember"> 이 기기에서 로그인 유지 (개인 휴대폰에서만)</label>
    ${S.loginErr ? `<div class="err">${esc(S.loginErr)}</div>` : ''}
    <div class="small">공용 PC에서는 체크하지 마세요. 브라우저를 닫거나 ${IDLE_LOGOUT_MINUTES}분 동안 쓰지 않으면 자동으로 로그아웃됩니다.</div></div>`;
}
async function doLogin() {
  S.loginErr = '';
  const r = document.getElementById('remember');
  try { await fb.login(r && r.checked) }
  catch (e) {
    const c = e && e.code;
    if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return;
    S.loginErr = c === 'auth/unauthorized-domain' ? '이 주소가 Firebase 인증 허용 도메인에 등록되지 않았습니다.' : '로그인하지 못했습니다. (' + (c || '오류') + ')';
    renderAll();
  }
}

/* ---------- 렌더 ---------- */
function renderAll() {
  const app = S.phase === 'app';
  document.getElementById('nav').classList.toggle('hidden', !app);
  const who = document.getElementById('who');
  who.classList.toggle('hidden', !app);
  who.innerHTML = app ? `<span>${esc(S.email)}</span><button class="btn" data-act="logout">로그아웃</button>` : '';
  syncStatus(); renderBanner();
  if (!app) { document.getElementById('view').innerHTML = renderGate(); return }
  render();
}
function renderBanner() {
  const b = [];
  if (S.phase === 'app') {
    if (S.slow) b.push('서버 응답이 늦어지고 있습니다. 인터넷 연결을 확인하세요. 보이는 내용이 최신이 아닐 수 있습니다.');
    if (S.err === 'denied') b.push('저장이 거부되었습니다. 입력값을 확인하거나 다시 로그인해 주세요.');
    if (S.err === 'write') b.push('일부 내용을 저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 입력해 주세요.');
    if (S.err === 'readdenied') b.push('데이터 읽기가 거부되었습니다. firestore.rules의 이메일 주소가 로그인한 계정과 같은지 확인하세요.');
    if (S.err === 'read') b.push('데이터를 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
  }
  document.getElementById('banner').innerHTML = b.map(t => `<div class="bn">${esc(t)}</div>`).join('');
}
function route() {
  const h = (location.hash || '').slice(1);
  S.view = ['today', 'accounts', 'history', 'settings'].includes(h) ? h : 'today';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === S.view));
}
window.addEventListener('hashchange', () => { closeModal(); if (S.phase === 'app') render() });
function editing() { const a = document.activeElement; return a && document.getElementById('view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) }
function requestRender() { if (editing()) S.needRender = true; else render() }
document.addEventListener('focusout', () => setTimeout(() => { if (S.needRender && !editing()) { S.needRender = false; render() } }, 60));
function render() {
  if (S.phase !== 'app') return;
  route();
  const v = document.getElementById('view');
  if (!S.loaded) { v.innerHTML = '<div class="loading">장부를 불러오는 중…</div>'; return }
  v.innerHTML = S.view === 'accounts' ? renderAccounts() : S.view === 'history' ? renderHistory() : S.view === 'settings' ? renderSettings() : renderToday();
  updateDerived();
  syncStatus();
}

/* ---------- 일일 정산 ---------- */
function renderToday() {
  const d = S.date, c = calc(d), day = c.day, s = day.sales || {};
  const lock = day.closed, dis = lock ? 'disabled' : '';
  const ai = (f, val, ph = '0') => `<input class="amt" data-f="${f}" value="${fmt(val)}" placeholder="${ph}" inputmode="tel" autocomplete="off" ${dis}>`;
  const accOpts = Object.entries(S.accounts).sort((a, b) => a[1].name.localeCompare(b[1].name, 'ko'));
  if (S.lf.acc && !S.accounts[S.lf.acc]) S.lf.acc = '';
  const isToday = d === todayStr();
  return `
  <div class="daybar">
    <button class="btn icon" data-act="day-prev" aria-label="이전 날">◀</button>
    <h1>${korDate(d)}</h1>
    <button class="btn icon" data-act="day-next" aria-label="다음 날">▶</button>
    <input type="date" class="txt" style="width:auto" data-act="day-pick" value="${d}">
    ${isToday ? '' : '<button class="btn sm" data-act="day-today">오늘로</button>'}
    ${day.closed ? '<span class="badge ok">마감 완료</span>' : '<span class="badge">작성 중</span>'}
  </div>
  <div class="grid2">
  <div>
    <section class="card">
      <h2><span class="step">1</span>아침 시재 (금고 시작 금액)</h2>
      <p class="hint">비워 두면 전날 퇴근 때 센 금액이 그대로 이월됩니다. 아침에 다시 세어 보고 다르면 직접 입력하세요.</p>
      <div class="opening">
        ${ai('opening', day.opening, c.prev ? fmt(c.prev.actual) : '0')}
        <div class="lbl">${c.openingAuto ? (c.prev ? `전일(${shortDate(c.prev.date)}) 마감 실사액 <b>${won(c.prev.actual)}</b> 이월 적용 중` : '이전 마감 기록이 없습니다. 시작 금액을 입력하세요.') : `직접 입력 · <a href="#" data-act="opening-auto">이월 금액으로 되돌리기</a>`}</div>
      </div>
    </section>

    <section class="card">
      <h2><span class="step">2</span>오늘 매출</h2>
      ${!lock && fb.aiReady() ? `<div class="photobar"><button class="btn pri" data-act="photo">📷 마감 화면 사진으로 자동 입력</button><span class="lbl">사진을 고르거나, 마감 화면을 캡처한 뒤 이 페이지에서 <b>Ctrl+V</b></span><input type="file" id="photoFile" accept="image/*" hidden></div>` : ''}
      <p class="hint">약국 프로그램·카드단말기의 일 마감 금액을 옮겨 적으세요. <b>12000+3500</b>처럼 더하기로 입력해도 됩니다. 외상으로 처리한 금액과 외상·요양원 수금액은 여기에 넣지 말고 ③에 기록하세요.</p>
      <div class="salewrap"><table class="sales">
        <thead><tr><th></th><th>현금</th><th>카드</th><th>계좌이체</th><th>합계</th></tr></thead>
        <tbody>
          <tr><td>조제 본인부담</td><td>${ai('sales.rxCash', s.rxCash)}</td><td>${ai('sales.rxCard', s.rxCard)}</td><td>${ai('sales.rxTransfer', s.rxTransfer)}</td><td class="n" id="d-rx"></td></tr>
          <tr><td>일반약·건기식</td><td>${ai('sales.otcCash', s.otcCash)}</td><td>${ai('sales.otcCard', s.otcCard)}</td><td>${ai('sales.otcTransfer', s.otcTransfer)}</td><td class="n" id="d-otc"></td></tr>
        </tbody>
        <tfoot><tr><td>합계</td><td class="n" id="d-cash"></td><td class="n" id="d-card"></td><td class="n" id="d-tr"></td><td class="n" id="d-all"></td></tr></tfoot>
      </table></div>
      <div class="cardchk">
        <span class="lbl">카드단말기 일 합계(선택)</span>
        ${ai('cardTerminal', day.cardTerminal, '단말기 금액')}
        <span id="d-cardchk"></span>
      </div>
    </section>

    <section class="card">
      <h2><span class="step">3</span>외상 · 요양원 (오늘 발생/수금)</h2>
      <p class="hint">물건을 먼저 가져간 경우 <b>외상 발생</b>, 나중에 돈을 받으면 <b>수금</b>(현금·카드·계좌이체)으로 기록하세요. 현금 수금만 금고 금액에 더해집니다.</p>
      <div class="list">
        ${c.led.length ? c.led.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(e => {
          const a = S.accounts[e.accountId];
          return `<div class="li lg"><div><b>${esc(a ? a.name : '(삭제된 거래처)')}</b> <span class="badge ${e.type === 'charge' ? 'warn' : 'blue'}">${e.type === 'charge' ? (a && a.kind === 'facility' ? '납품(후결제)' : '외상 발생') : '수금 · ' + METHODS[e.method]}</span> ${e.memo ? `<span class="muted">· ${esc(e.memo)}</span>` : ''}</div>
          <div class="num"><b>${won(e.amount)}</b></div>
          ${lock ? '<span></span>' : `<button class="x" data-act="led-del" data-id="${esc(e.id)}" title="삭제">×</button>`}</div>`
        }).join('') : '<div class="empty">오늘 기록된 외상·수금이 없습니다.</div>'}
      </div>
      ${lock ? '' : `
      <div class="addform">
        <select data-lf="acc">
          <option value="">거래처 선택</option>
          ${accOpts.map(([id, a]) => `<option value="${esc(id)}" ${S.lf.acc === id ? 'selected' : ''}>${esc(a.name)} (${KINDS[a.kind] || ''})</option>`).join('')}
          <option value="__new">+ 새 거래처 등록…</option>
        </select>
        <div class="seg">
          <button data-act="lf-type" data-v="charge" class="${S.lf.type === 'charge' ? 'on' : ''}">외상 발생</button>
          <button data-act="lf-type" data-v="payment" class="${S.lf.type === 'payment' ? 'on' : ''}">수금</button>
        </div>
        <input class="amt" data-lf="amount" placeholder="금액" inputmode="tel" value="${esc(S.lf.amount)}">
        <select data-lf="method" ${S.lf.type === 'charge' ? 'disabled' : ''}>
          ${Object.entries(METHODS).map(([k, v]) => `<option value="${k}" ${S.lf.method === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <input class="txt" data-lf="memo" placeholder="품목·메모" value="${esc(S.lf.memo)}">
        <button class="btn pri" data-act="lf-add">추가</button>
      </div>`}
    </section>

    <section class="card">
      <h2><span class="step">4</span>현금 입출금 (매출 외)</h2>
      <p class="hint">금고에서 나간 돈(은행 입금, 환불, 소모품 구입 등)과 매출이 아닌 이유로 들어온 돈(거스름돈 보충 등)을 적으세요.</p>
      <div class="list">
        ${(day.moves || []).length ? (day.moves || []).map(m => `
          <div class="li mv">
            <span class="${m.dir === 'in' ? 'tag-in' : 'tag-out'}">${m.dir === 'in' ? '＋ 입금' : '－ 출금'}</span>
            <select data-mv="${esc(m.id)}" data-mf="cat" ${dis}>${(m.dir === 'in' ? IN_CATS : OUT_CATS).map(x => `<option ${m.cat === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
            <input class="amt" data-mv="${esc(m.id)}" data-mf="amount" value="${fmt(m.amount)}" placeholder="0" inputmode="tel" ${dis}>
            <input class="txt memo" data-mv="${esc(m.id)}" data-mf="memo" value="${esc(m.memo)}" placeholder="메모" ${dis}>
            ${lock ? '<span></span>' : `<button class="x" data-act="mv-del" data-id="${esc(m.id)}" title="삭제">×</button>`}
          </div>`).join('') : '<div class="empty">기록 없음</div>'}
      </div>
      ${lock ? '' : `<div class="row" style="margin-top:12px">
        <button class="btn" data-act="mv-add" data-dir="out">－ 현금 출금·지출 추가</button>
        <button class="btn" data-act="mv-add" data-dir="in">＋ 현금 입금 추가</button>
      </div>`}
    </section>

    <section class="card">
      <h2><span class="step">5</span>퇴근 전 금고 현금 세기</h2>
      <p class="hint">권종별 개수(장·개)를 입력하면 합계가 자동으로 계산됩니다.</p>
      <div class="denoms">
        ${DENOMS.map(k => `<div class="dn ${k < 1000 ? 'coin' : ''}"><span class="face">${k.toLocaleString('ko-KR')}원</span>
          <input class="cnt" data-f="count.${k}" value="${day.count && day.count[k] != null ? esc(day.count[k]) : ''}" placeholder="0" inputmode="numeric" ${dis}>
          <span class="sub num" id="d-c${k}"></span></div>`).join('')}
      </div>
      <div class="cnttotal"><span>실제 금고 현금</span><span class="big num" id="d-ctot"></span></div>
    </section>

    <section class="card">
      <h2>메모</h2>
      <textarea data-f="memo" rows="2" maxlength="2000" placeholder="과부족 사유, 특이사항 등" ${dis}>${esc(day.memo)}</textarea>
    </section>
  </div>
  <aside class="side" id="d-sum">${summaryHTML(c)}</aside>
  </div>`;
}
function summaryHTML(c) {
  const day = c.day;
  let v;
  if (c.actual == null) v = `<div class="verdict none"><div class="t">금고 현금을 세면 결과가 표시됩니다</div><div class="big">–</div></div>`;
  else if (c.diff === 0) v = `<div class="verdict ok"><div class="t">금고 현금이 정확히 맞습니다</div><div class="big">일치 ✓</div></div>`;
  else if (c.diff < 0) v = `<div class="verdict short"><div class="t">현금이 부족합니다</div><div class="big">${won(c.diff)}</div></div>`;
  else v = `<div class="verdict over"><div class="t">현금이 남습니다</div><div class="big">+${won(c.diff)}</div></div>`;
  return `<div class="sum">
    <div class="hd">금고 대조</div>
    <div class="ln"><span>아침 시재</span><span class="num">${won(c.opening)}</span></div>
    <div class="ln"><span>＋ 현금 매출</span><span class="num">${won(c.cashSales)}</span></div>
    <div class="ln"><span>＋ 외상 현금 수금</span><span class="num">${won(c.credCash)}</span></div>
    <div class="ln"><span>＋ 기타 현금 입금</span><span class="num">${won(c.movesIn)}</span></div>
    <div class="ln minus"><span>－ 현금 출금·지출</span><span class="num">${c.movesOut ? '-' + won(c.movesOut) : won(0)}</span></div>
    <div class="tot"><span>있어야 할 현금</span><span class="big num">${won(c.expected)}</span></div>
    <div class="ln" style="padding-top:8px"><span>실제 센 현금</span><span class="num"><b>${won(c.actual)}</b></span></div>
    ${v}
    <div class="foot">
      <div><span>오늘 총매출</span><b class="num">${won(c.totalSales)}</b></div>
      <div><span>　현금 / 카드 / 이체</span><span class="num">${fmt(c.cashSales)} / ${fmt(c.cardSales)} / ${fmt(c.trSales)}</span></div>
      <div><span>　외상 발생</span><span class="num">${won(c.credCharge)}</span></div>
      <div><span>외상 수금 (카드·이체)</span><span class="num">${won(c.credCard + c.credTr)}</span></div>
      <div style="margin-top:6px"><span>전체 외상 미수 잔액</span><b class="num">${won(totalReceivable())}</b></div>
    </div>
    <div style="padding:0 12px 12px">
      ${day.closed ? `<div class="closebar"><button class="btn" data-act="reopen">마감 해제 (수정하기)</button></div>` : `<div class="closebar"><button class="btn pri" data-act="close">오늘 정산 마감</button></div>`}
    </div>
  </div>`;
}
function updateDerived() {
  if (S.view !== 'today') return;
  const c = calc(S.date), s = c.day.sales || {}, v = k => Number(s[k]) || 0, set = (id, h) => { const e = document.getElementById(id); if (e) e.innerHTML = h };
  set('d-rx', won(v('rxCash') + v('rxCard') + v('rxTransfer')));
  set('d-otc', won(v('otcCash') + v('otcCard') + v('otcTransfer')));
  set('d-cash', won(c.cashSales)); set('d-card', won(c.cardSales)); set('d-tr', won(c.trSales));
  set('d-all', won(c.cashSales + c.cardSales + c.trSales));
  const ct = c.day.cardTerminal;
  if (ct == null) set('d-cardchk', `<span class="lbl">카드 매출+카드 수금 = ${won(c.cardAll)}</span>`);
  else { const df = ct - c.cardAll; set('d-cardchk', df === 0 ? `<span class="badge ok">카드 일치 ✓</span>` : `<span class="badge bad">카드 차이 ${sgn(df)}</span> <span class="lbl">(입력 합계 ${won(c.cardAll)})</span>`) }
  const cnt = c.day.count || {};
  DENOMS.forEach(k => set('d-c' + k, cnt[k] ? won(k * (Number(cnt[k]) || 0)) : ''));
  set('d-ctot', won(c.actual));
  set('d-sum', summaryHTML(c));
}
function editDay(mut, { now = false, full = false } = {}) {
  const d = S.date; const day = clone(S.days[d] || blankDay(d)); mut(day); day.date = d; day.updatedAt = Date.now();
  if (day.closed == null) day.closed = false;
  if (now) setDoc('days', d, day); else setDocLater('days', d, day);
  full ? render() : updateDerived();
}

/* ---------- 외상·요양원 ---------- */
function renderAccounts() {
  const all = Object.entries(S.accounts).map(([id, a]) => ({ id, ...a, bal: accBalance(id) }))
    .filter(a => S.accFilter === 'all' || a.kind === S.accFilter)
    .sort((a, b) => (b.bal > 0) - (a.bal > 0) || a.name.localeCompare(b.name, 'ko'));
  if (S.selAcc && !S.accounts[S.selAcc]) S.selAcc = null;
  if (!S.selAcc && all.length && window.innerWidth > 860) S.selAcc = all[0].id;
  return `<div class="acc">
    <div class="card acclist">
      <div class="row" style="justify-content:space-between"><h2 class="mt0">거래처</h2><button class="btn sm pri" data-act="acc-new">+ 새 거래처</button></div>
      <div class="chips">${[['all', '전체'], ['personal', '개인 외상'], ['facility', '요양원·기관']].map(([k, v]) => `<button data-act="acc-filter" data-v="${k}" class="${S.accFilter === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="lbl" style="margin-bottom:6px">전체 미수 잔액 <b class="num" style="color:var(--ink)">${won(totalReceivable())}</b></div>
      ${all.length ? all.map(a => `<div class="item ${S.selAcc === a.id ? 'on' : ''}" data-act="acc-sel" data-id="${esc(a.id)}">
        <div><div class="nm">${esc(a.name)}</div><div class="kd">${KINDS[a.kind] || ''}${a.phone ? ' · ' + esc(a.phone) : ''}</div></div>
        <div class="bal num ${a.bal ? '' : 'zero'}">${a.bal ? won(a.bal) : '0원'}</div></div>`).join('') : '<div class="empty">등록된 거래처가 없습니다. “+ 새 거래처”로 외상 고객이나 요양원을 등록하세요.</div>'}
    </div>
    <div>${S.selAcc ? renderAccDetail(S.selAcc) : '<div class="card empty">왼쪽에서 거래처를 선택하세요.</div>'}</div>
  </div>`;
}
function accPeriod() { if (S.accAll) return { from: null, to: null, label: '전체 기간' }; return { from: S.accMonth + '-01', to: addMonths(S.accMonth, 1) + '-01', label: korMonth(S.accMonth) } }
function accRows(id) {
  const p = accPeriod();
  const ents = ledgerList().filter(e => e.accountId === id && (!p.from || (e.date >= p.from && e.date < p.to))).sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  const carry = p.from ? accBalance(id, p.from) : 0;
  let run = carry;
  const rows = ents.map(e => { run += e.type === 'charge' ? e.amount : -e.amount; return { ...e, run } });
  return { p, carry, rows, charge: sum(ents.filter(e => e.type === 'charge'), e => e.amount), paid: sum(ents.filter(e => e.type === 'payment'), e => e.amount), end: run };
}
function renderAccDetail(id) {
  const a = S.accounts[id], bal = accBalance(id), r = accRows(id);
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div><h2 class="mt0" style="font-size:19px">${esc(a.name)} <span class="badge ${a.kind === 'facility' ? 'blue' : ''}">${KINDS[a.kind] || ''}</span></h2>
        <div class="lbl">${[a.phone, a.memo].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div></div>
      <div style="text-align:right"><div class="lbl">현재 미수 잔액</div><div class="num" style="font-size:24px;font-weight:700;color:${bal > 0 ? 'var(--red)' : 'var(--green-ink)'}">${won(bal)}</div></div>
    </div>
    <div class="row" style="margin:14px 0 10px">
      <button class="btn icon" data-act="am-prev" ${S.accAll ? 'disabled' : ''}>◀</button>
      <b style="min-width:110px;text-align:center">${r.p.label}</b>
      <button class="btn icon" data-act="am-next" ${S.accAll ? 'disabled' : ''}>▶</button>
      <label class="lbl row" style="gap:4px"><input type="checkbox" data-act="am-all" ${S.accAll ? 'checked' : ''}> 전체 기간</label>
      <span class="fx"></span>
      <button class="btn sm" data-act="stmt-copy">명세 복사</button>
      <button class="btn sm" data-act="stmt-csv">엑셀(CSV) 저장</button>
      <button class="btn sm" data-act="acc-edit">거래처 수정</button>
    </div>
    <table class="stmt">
      <thead><tr><th>날짜</th><th>구분</th><th>내용</th><th class="n">외상·납품</th><th class="n">수금</th><th class="n">잔액</th><th></th></tr></thead>
      <tbody>
        ${r.p.from ? `<tr class="carry"><td colspan="5">이전 이월 잔액</td><td class="n">${won(r.carry)}</td><td></td></tr>` : ''}
        ${r.rows.map(e => `<tr><td>${shortDate(e.date)}</td><td>${e.type === 'charge' ? '<span class="badge warn">외상</span>' : `<span class="badge blue">수금·${METHODS[e.method]}</span>`}</td>
          <td>${esc(e.memo)}</td><td class="n">${e.type === 'charge' ? won(e.amount) : ''}</td><td class="n">${e.type === 'payment' ? won(e.amount) : ''}</td><td class="n">${won(e.run)}</td>
          <td>${S.days[e.date] && S.days[e.date].closed ? '' : `<button class="x" data-act="led-del" data-id="${esc(e.id)}" title="삭제">×</button>`}</td></tr>`).join('')}
        ${r.rows.length ? '' : '<tr><td colspan="7" class="empty">이 기간 거래가 없습니다.</td></tr>'}
      </tbody>
      <tfoot><tr><td colspan="3"><b>기간 합계</b></td><td class="n"><b>${won(r.charge)}</b></td><td class="n"><b>${won(r.paid)}</b></td><td class="n"><b>${won(r.end)}</b></td><td></td></tr></tfoot>
    </table>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--line)">
      <div class="lbl" style="margin-bottom:6px">거래 추가</div>
      <div class="addform" style="grid-template-columns:150px auto 130px 110px 1fr auto">
        <input type="date" class="txt" data-af="date" value="${esc(S.af.date)}">
        <div class="seg">
          <button data-act="af-type" data-v="charge" class="${S.af.type === 'charge' ? 'on' : ''}">외상·납품</button>
          <button data-act="af-type" data-v="payment" class="${S.af.type === 'payment' ? 'on' : ''}">수금</button>
        </div>
        <input class="amt" data-af="amount" placeholder="금액" inputmode="tel" value="${esc(S.af.amount)}">
        <select data-af="method" ${S.af.type === 'charge' ? 'disabled' : ''}>${Object.entries(METHODS).map(([k, v]) => `<option value="${k}" ${S.af.method === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input class="txt" data-af="memo" placeholder="품목·메모" value="${esc(S.af.memo)}">
        <button class="btn pri" data-act="af-add">추가</button>
      </div>
      <p class="hint" style="margin-top:8px">여기서 현금 수금을 추가하면 그 날짜의 일일 정산 금고 금액에도 자동으로 더해집니다. 카드 수금은 금고 금액에 영향을 주지 않습니다.</p>
    </div>
  </div>`;
}
function stmtText(id) {
  const a = S.accounts[id], r = accRows(id);
  const L = [`[열방약국] ${a.name} 거래 내역 (${r.p.label})`, ''];
  if (r.p.from) L.push(`이전 이월 잔액: ${won(r.carry)}`);
  r.rows.forEach(e => L.push(`${e.date}  ${e.type === 'charge' ? '외상·납품' : '수금(' + METHODS[e.method] + ')'}  ${won(e.amount)}${e.memo ? '  ' + e.memo : ''}`));
  L.push('', `기간 외상·납품 합계: ${won(r.charge)}`, `기간 수금 합계: ${won(r.paid)}`, `미수 잔액: ${won(r.end)}`);
  return L.join('\n');
}
function csv(rows) { return '﻿' + rows.map(r => r.map(x => { let s = String(x ?? ''); if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }).join(',')).join('\r\n') }
function saveFile(name, data, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('복사했습니다. 문자나 카톡에 붙여넣기 하세요') } catch (e) { showModal(`<h3>아래 내용을 복사하세요</h3><textarea class="txt" rows="12" style="width:100%">${esc(t)}</textarea><div class="acts"><button class="btn pri" data-m="close">닫기</button></div>`) } }

/* ---------- 월별 기록 ---------- */
function monthDates(ym) {
  const set = new Set();
  Object.keys(S.days).forEach(k => { if (k.startsWith(ym)) set.add(k) });
  ledgerList().forEach(e => { if (e.date && e.date.startsWith(ym)) set.add(e.date) });
  return [...set].sort();
}
function monthRows(ym) { return monthDates(ym).map(d => ({ d, c: calc(d) })) }
function renderHistory() {
  const ym = S.month, rows = monthRows(ym);
  const T = k => sum(rows, r => r.c[k]);
  const diffs = rows.filter(r => r.c.diff != null);
  const unclosed = rows.filter(r => !(S.days[r.d] && S.days[r.d].closed) && r.d <= todayStr()).length;
  return `
  <div class="daybar">
    <button class="btn icon" data-act="m-prev">◀</button><h1>${korMonth(ym)}</h1><button class="btn icon" data-act="m-next">▶</button>
    <span class="fx"></span>
    <button class="btn sm" data-act="m-copy">표 복사</button>
    <button class="btn sm" data-act="m-csv">엑셀(CSV) 저장</button>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="k">월 총매출 (외상 포함)</div><div class="v num">${won(T('totalSales'))}</div></div>
    <div class="kpi"><div class="k">현금 매출</div><div class="v num">${won(T('cashSales'))}</div></div>
    <div class="kpi"><div class="k">카드 매출</div><div class="v num">${won(T('cardSales'))}</div></div>
    <div class="kpi"><div class="k">외상 발생 / 수금</div><div class="v num" style="font-size:16px">${won(T('credCharge'))} / ${won(T('credCash') + T('credCard') + T('credTr'))}</div></div>
    <div class="kpi"><div class="k">과부족 누계 (${diffs.length}일)</div><div class="v num ${cls(sum(diffs, r => r.c.diff))}">${diffs.length ? sgn(sum(diffs, r => r.c.diff)) : '–'}</div></div>
    <div class="kpi"><div class="k">마감 안 된 날</div><div class="v">${unclosed}일</div></div>
  </div>
  <div class="card hist">
    <table>
      <thead><tr><th>날짜</th><th>아침 시재</th><th>현금 매출</th><th>카드 매출</th><th>이체 매출</th><th>외상 발생</th><th>외상 현금수금</th><th>기타 입출금</th><th>있어야 할 현금</th><th>실제 현금</th><th>과부족</th><th>상태</th></tr></thead>
      <tbody>${rows.length ? rows.map(({ d, c }) => `<tr data-act="goto" data-d="${d}">
        <td>${shortDate(d)}</td><td>${fmt(c.opening)}</td><td>${fmt(c.cashSales)}</td><td>${fmt(c.cardSales)}</td><td>${fmt(c.trSales)}</td>
        <td>${fmt(c.credCharge)}</td><td>${fmt(c.credCash)}</td><td>${fmt(c.movesIn - c.movesOut)}</td><td>${fmt(c.expected)}</td>
        <td>${c.actual == null ? '–' : fmt(c.actual)}</td><td class="${cls(c.diff)}">${c.diff == null ? '–' : c.diff === 0 ? '일치' : sgn(c.diff)}</td>
        <td>${S.days[d] && S.days[d].closed ? '<span class="badge ok">마감</span>' : '<span class="badge">미마감</span>'}</td></tr>`).join('')
        : '<tr><td colspan="12" class="empty" style="text-align:left">이 달의 기록이 없습니다.</td></tr>'}</tbody>
      ${rows.length ? `<tfoot><tr><td>합계</td><td></td><td>${fmt(T('cashSales'))}</td><td>${fmt(T('cardSales'))}</td><td>${fmt(T('trSales'))}</td><td>${fmt(T('credCharge'))}</td><td>${fmt(T('credCash'))}</td><td>${fmt(T('movesIn') - T('movesOut'))}</td><td></td><td></td><td class="${cls(sum(diffs, r => r.c.diff))}">${diffs.length ? sgn(sum(diffs, r => r.c.diff)) : ''}</td><td></td></tr></tfoot>` : ''}
    </table>
    <p class="hint" style="margin:10px 0 0">날짜를 누르면 그날 정산 화면으로 이동합니다.</p>
  </div>`;
}
function monthTable(ym) {
  const h = ['날짜', '아침시재', '현금매출', '카드매출', '이체매출', '외상발생', '외상현금수금', '외상카드·이체수금', '기타입금', '현금출금·지출', '있어야할현금', '실제현금', '과부족', '마감', '메모'];
  return [h, ...monthRows(ym).map(({ d, c }) => [d, c.opening, c.cashSales, c.cardSales, c.trSales, c.credCharge, c.credCash, c.credCard + c.credTr, c.movesIn, c.movesOut, c.expected, c.actual ?? '', c.diff ?? '', S.days[d] && S.days[d].closed ? '마감' : '', (S.days[d] && S.days[d].memo) || ''])];
}

/* ---------- 백업 ---------- */
function renderSettings() {
  const n = COLS.map(c => Object.keys(S[c]).length);
  return `<div style="max-width:720px">
    <section class="card">
      <h2>데이터 백업</h2>
      <p class="hint">장부 전체(일일 정산 ${n[0]}일, 거래처 ${n[1]}곳, 외상·수금 ${n[2]}건)를 파일 하나로 내려받습니다. 한 달에 한 번 이상 받아서 개인 PC나 USB에 보관하세요.</p>
      <button class="btn pri" data-act="backup">전체 백업 파일 받기 (.json)</button>
    </section>
    <section class="card">
      <h2>백업 복원</h2>
      <p class="hint">백업 파일의 내용을 다시 저장합니다. 같은 날짜·같은 거래 기록은 백업 파일 내용으로 덮어씁니다. 지금 있는 다른 기록은 지워지지 않습니다.</p>
      <input type="file" id="restoreFile" accept=".json,application/json">
    </section>
    <section class="card">
      <h2>계정</h2>
      <p class="hint">로그인: <b>${esc(S.email)}</b> · ${IDLE_LOGOUT_MINUTES}분 동안 사용하지 않으면 자동으로 로그아웃됩니다.</p>
      <button class="btn" data-act="logout">로그아웃</button>
    </section>
  </div>`;
}
function validBackup(j) {
  if (!j || typeof j !== 'object' || j.app !== 'yeolbang-cash') return false;
  return COLS.every(c => j[c] == null || (typeof j[c] === 'object' && !Array.isArray(j[c])));
}

/* ---------- 모달 ---------- */
function showModal(html, onSubmit) {
  const m = document.getElementById('modal');
  m.innerHTML = `<div class="bg"><div class="box" role="dialog">${html}</div></div>`;
  m.onclick = e => { const b = e.target.closest('[data-m]'); if (e.target.classList.contains('bg') || (b && b.dataset.m === 'close')) { closeModal(); return } if (b && onSubmit) onSubmit(b.dataset.m, m) };
  const f = m.querySelector('input,textarea'); if (f) f.focus();
}
function closeModal() { const m = document.getElementById('modal'); m.innerHTML = ''; m.onclick = null; if (S.needRender && !editing()) { S.needRender = false; render() } }
function confirmBox(msg, ok, fn) { showModal(`<h3>${esc(msg)}</h3><div class="acts"><button class="btn" data-m="close">취소</button><button class="btn pri" data-m="ok">${esc(ok)}</button></div>`, k => { if (k === 'ok') { closeModal(); fn() } }) }
function accountModal(id, after) {
  const a = id ? S.accounts[id] : { name: '', kind: 'facility', phone: '', memo: '' };
  const hasLed = id && ledgerList().some(e => e.accountId === id);
  showModal(`<h3>${id ? '거래처 수정' : '새 거래처 등록'}</h3>
    <div class="fld"><label>이름</label><input class="txt" id="m-name" maxlength="60" value="${esc(a.name)}" placeholder="예: ○○요양원, 홍길동"></div>
    <div class="fld"><label>구분</label><select id="m-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${a.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="fld"><label>연락처</label><input class="txt" id="m-phone" maxlength="40" value="${esc(a.phone)}"></div>
    <div class="fld"><label>메모</label><input class="txt" id="m-memo" maxlength="300" value="${esc(a.memo)}" placeholder="결제일, 담당자 등"></div>
    <p class="lbl" id="m-err" style="color:var(--red)"></p>
    <div class="acts">${id ? `<button class="btn dang left" data-m="del">삭제</button>` : ''}<button class="btn" data-m="close">취소</button><button class="btn pri" data-m="save">저장</button></div>`,
    (k, m) => {
      if (k === 'del') {
        if (hasLed) { m.querySelector('#m-err').textContent = '거래 내역이 있는 거래처는 삭제할 수 없습니다.'; return }
        closeModal(); setDoc('accounts', id, null); S.selAcc = null; render(); return;
      }
      if (k !== 'save') return;
      const name = m.querySelector('#m-name').value.trim();
      if (!name) { m.querySelector('#m-err').textContent = '이름을 입력하세요.'; return }
      const nid = id || genId();
      const base = id ? clone(S.accounts[id]) : { createdAt: Date.now() };
      setDoc('accounts', nid, { createdAt: base.createdAt || Date.now(), name, kind: m.querySelector('#m-kind').value, phone: m.querySelector('#m-phone').value.trim(), memo: m.querySelector('#m-memo').value.trim(), updatedAt: Date.now() });
      closeModal(); if (after) after(nid); render();
    });
}
function addLedger(f, date) {
  const amt = parseAmt(f.amount);
  if (!f.acc || !S.accounts[f.acc]) { toast('거래처를 선택하세요'); return false }
  if (!amt || amt <= 0) { toast('금액을 입력하세요'); return false }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('날짜를 확인하세요'); return false }
  if (S.days[date] && S.days[date].closed) { toast(`${shortDate(date)}은 마감된 날입니다. 마감 해제 후 추가하세요`); return false }
  setDoc('ledger', genId(), { date, accountId: f.acc, type: f.type, amount: amt, method: f.type === 'payment' ? f.method : null, memo: (f.memo || '').trim().slice(0, 500), createdAt: Date.now() });
  return true;
}

/* ---------- 이벤트 ---------- */
const view = document.getElementById('view');
view.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.f) {
    const f = t.dataset.f;
    editDay(day => {
      if (f === 'memo') day.memo = t.value.slice(0, 2000);
      else if (f === 'opening') day.opening = parseAmt(t.value);
      else if (f === 'cardTerminal') day.cardTerminal = parseAmt(t.value);
      else if (f.startsWith('sales.')) { day.sales = day.sales || {}; day.sales[f.slice(6)] = parseAmt(t.value) }
      else if (f.startsWith('count.')) { day.count = day.count || {}; const n = t.value.replace(/[^\d]/g, '').slice(0, 6); day.count[f.slice(6)] = n === '' ? null : Number(n) }
    });
  } else if (t.dataset.mv) {
    const id = t.dataset.mv, k = t.dataset.mf;
    editDay(day => { const m = (day.moves || []).find(x => x.id === id); if (!m) return; if (k === 'amount') m.amount = parseAmt(t.value) || 0; else m[k] = t.value.slice(0, 200) });
  } else if (t.dataset.lf) {
    if (t.dataset.lf === 'acc' && t.value === '__new') { t.value = S.lf.acc; accountModal(null, id => { S.lf.acc = id }); return }
    S.lf[t.dataset.lf] = t.value;
  } else if (t.dataset.af) { S.af[t.dataset.af] = t.value }
});
view.addEventListener('change', e => {
  const t = e.target;
  if (t.classList.contains('amt')) { const n = parseAmt(t.value); t.value = n == null ? '' : fmt(n); if (t.dataset.f === 'opening' && n == null) render() }
  if (t.dataset.act === 'day-pick' && t.value) { flushAll(); S.date = t.value; render() }
  if (t.dataset.act === 'am-all') { S.accAll = t.checked; render() }
  if (t.id === 'photoFile' && t.files[0]) { processImage(t.files[0]); t.value = ''; return }
  if (t.id === 'restoreFile' && t.files[0]) {
    const file = t.files[0];
    file.text().then(txt => {
      let j; try { j = JSON.parse(txt) } catch (er) { toast('백업 파일을 읽을 수 없습니다'); return }
      if (!validBackup(j)) { toast('열방약국 현금정산 백업 파일이 아닙니다'); return }
      const cnt = COLS.reduce((a, c) => a + Object.keys(j[c] || {}).length, 0);
      confirmBox(`백업 파일(${j.exportedAt ? j.exportedAt.slice(0, 10) : ''}, ${cnt}건)을 복원할까요?`, '복원', async () => {
        try { const n = await fb.restoreAll(j); toast(`${n}건을 복원했습니다`) }
        catch (er) { console.error(er); toast('복원 중 오류가 발생했습니다. 일부만 저장되었을 수 있습니다') }
      });
    });
    t.value = '';
  }
});
view.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return; const t = e.target;
  if (t.dataset.lf) { e.preventDefault(); view.querySelector('[data-act="lf-add"]').click() }
  if (t.dataset.af) { e.preventDefault(); view.querySelector('[data-act="af-add"]').click() }
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (b.tagName === 'A') e.preventDefault();
  switch (a) {
    case 'photo': { const f = document.getElementById('photoFile'); if (f) f.click(); break }
    case 'login': doLogin(); break;
    case 'logout': doLogout(); break;
    case 'day-prev': flushAll(); S.date = addDays(S.date, -1); render(); break;
    case 'day-next': flushAll(); S.date = addDays(S.date, 1); render(); break;
    case 'day-today': flushAll(); S.date = todayStr(); render(); break;
    case 'opening-auto': editDay(d => { d.opening = null }, { now: true, full: true }); break;
    case 'lf-type': S.lf.type = b.dataset.v; render(); break;
    case 'lf-add': if (addLedger(S.lf, S.date)) { S.lf.amount = ''; S.lf.memo = ''; render(); toast('기록했습니다') } break;
    case 'led-del': {
      const e2 = S.ledger[b.dataset.id]; if (!e2) break; const an = S.accounts[e2.accountId];
      confirmBox(`${an ? an.name : ''} ${won(e2.amount)} 기록을 삭제할까요?`, '삭제', () => { setDoc('ledger', b.dataset.id, null); render() }); break
    }
    case 'mv-add': {
      const dir = b.dataset.dir; editDay(d => { d.moves = d.moves || []; d.moves.push({ id: genId(), dir, cat: dir === 'in' ? IN_CATS[0] : OUT_CATS[0], amount: 0, memo: '' }) }, { now: true, full: true });
      const ins = view.querySelectorAll('.mv input.amt'); if (ins.length) ins[ins.length - 1].focus(); break
    }
    case 'mv-del': editDay(d => { d.moves = (d.moves || []).filter(m => m.id !== b.dataset.id) }, { now: true, full: true }); break;
    case 'close': {
      const c = calc(S.date);
      const go = () => { editDay(d => { d.closed = true; d.closedAt = new Date().toISOString(); if (d.opening == null) d.opening = c.opening }, { now: true, full: true }); toast('오늘 정산을 마감했습니다') };
      if (c.actual == null) confirmBox('금고 현금을 아직 세지 않았습니다. 그래도 마감할까요?', '마감', go);
      else if (c.diff !== 0) confirmBox(`과부족 ${sgn(c.diff)}이 있습니다. 메모에 사유를 적었나요? 이대로 마감할까요?`, '마감', go);
      else go(); break
    }
    case 'reopen': editDay(d => { d.closed = false }, { now: true, full: true }); break;
    case 'acc-new': accountModal(null, id => { S.selAcc = id }); break;
    case 'acc-edit': accountModal(S.selAcc); break;
    case 'acc-sel': S.selAcc = b.dataset.id; render(); break;
    case 'acc-filter': S.accFilter = b.dataset.v; render(); break;
    case 'am-prev': S.accMonth = addMonths(S.accMonth, -1); render(); break;
    case 'am-next': S.accMonth = addMonths(S.accMonth, 1); render(); break;
    case 'af-type': S.af.type = b.dataset.v; render(); break;
    case 'af-add': if (addLedger({ ...S.af, acc: S.selAcc }, S.af.date || todayStr())) { S.af.amount = ''; S.af.memo = ''; render(); toast('기록했습니다') } break;
    case 'stmt-copy': copyText(stmtText(S.selAcc)); break;
    case 'stmt-csv': {
      const id = S.selAcc, r = accRows(id), n = S.accounts[id].name;
      const rows = [['날짜', '구분', '결제수단', '내용', '외상·납품', '수금', '잔액']];
      if (r.p.from) rows.push(['', '이전 이월', '', '', '', '', r.carry]);
      r.rows.forEach(e => rows.push([e.date, e.type === 'charge' ? '외상·납품' : '수금', e.method ? METHODS[e.method] : '', e.memo, e.type === 'charge' ? e.amount : '', e.type === 'payment' ? e.amount : '', e.run]));
      rows.push(['합계', '', '', '', r.charge, r.paid, r.end]);
      saveFile(`열방약국_${n.replace(/[\\/:*?"<>|]/g, '_')}_${S.accAll ? '전체' : S.accMonth}.csv`, csv(rows)); break
    }
    case 'm-prev': S.month = addMonths(S.month, -1); render(); break;
    case 'm-next': S.month = addMonths(S.month, 1); render(); break;
    case 'm-copy': copyText(monthTable(S.month).map(r => r.join('\t')).join('\n')); break;
    case 'm-csv': saveFile(`열방약국_현금정산_${S.month}.csv`, csv(monthTable(S.month))); break;
    case 'goto': flushAll(); S.date = b.dataset.d; location.hash = '#today'; break;
    case 'backup': {
      const j = { app: 'yeolbang-cash', version: 1, exportedAt: new Date().toISOString(), days: S.days, accounts: S.accounts, ledger: S.ledger };
      saveFile(`열방약국_현금정산_백업_${todayStr()}.json`, JSON.stringify(j, null, 1), 'application/json'); break
    }
  }
});

/* ---------- 마감 화면 사진 → 자동 입력 ---------- */
function num(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^\d\-]/g, '')); return isNaN(n) || String(v).replace(/[^\d]/g, '') === '' ? null : n }
function interpret(r) {
  const warns = [];
  const part = (label, total, card, cash, receipt, credit) => {
    let cashAmt = null, how = '';
    if (cash != null) {
      if (total != null && card != null && receipt && card + cash + credit === total) { cashAmt = cash; how = `현금결제 ${fmt(cash)} (현금영수증 금액은 현금결제에 이미 포함)` }
      else { cashAmt = cash + (receipt || 0); how = receipt ? `현금결제 ${fmt(cash)} + 현금영수증 ${fmt(receipt)}` : `현금결제 ${fmt(cash)}` }
    } else if (total != null && card != null) {
      cashAmt = total - card - credit;
      how = `총계 ${fmt(total)} − 카드 ${fmt(card)}${credit ? ` − 외상 ${fmt(credit)}` : ''} (계산값)`;
      warns.push(`${label} 현금은 '현금결제' 줄이 화면에 보이지 않아 총계에서 계산한 값입니다. 표를 아래로 내려 확인하세요.`);
    } else warns.push(`${label} 현금 금액을 읽지 못했습니다. 직접 입력하세요.`);
    if (card == null) warns.push(`${label} 카드 금액을 읽지 못했습니다. 직접 입력하세요.`);
    if (total != null && card != null && cashAmt != null) {
      const diff = total - card - cashAmt - credit;
      if (diff !== 0) warns.push(`${label}: 총계 ${fmt(total)}원과 카드+현금 합계가 ${sgn(diff)} 차이 납니다. 계좌이체·외상 등이 있는지 확인하세요.`);
    }
    return { cash: cashAmt, card, how, total };
  };
  const rx = part('조제', num(r.rx_total), num(r.rx_card), num(r.rx_cash), num(r.rx_cash_receipt), 0);
  const otcCredit = num(r.otc_credit) || 0;
  const otc = part('일반약', num(r.otc_total), num(r.otc_card), num(r.otc_cash), num(r.otc_cash_receipt), otcCredit);
  if (otcCredit > 0) warns.push(`일반약 외상 ${won(otcCredit)}이 있습니다. ③ 외상·요양원에 거래처별로 기록하세요.`);
  const cc = num(r.customer_credit); if (cc) warns.push(`고객 외상장 ${won(cc)}이 있습니다. ③ 외상·요양원 기록과 맞는지 확인하세요.`);
  const okDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let date = null;
  if (okDate(r.dateFrom) && okDate(r.dateTo)) { if (r.dateFrom === r.dateTo) date = r.dateTo; else warns.push(`조회기간이 ${r.dateFrom} ~ ${r.dateTo}로 하루가 아닙니다. 하루치 화면인지 확인하세요.`) }
  else if (okDate(r.dateTo)) date = r.dateTo;
  return { rx, otc, date, warns };
}
async function imageToBase64(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url });
    const sc = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  } finally { URL.revokeObjectURL(url) }
}
let aiBusy = false;
async function processImage(file) {
  if (aiBusy) return;
  if (!file || !/^image\//.test(file.type)) { toast('이미지 파일만 올릴 수 있습니다'); return }
  if (file.size > 15 * 1024 * 1024) { toast('사진이 너무 큽니다 (15MB 이하)'); return }
  aiBusy = true;
  showModal(`<h3>마감 화면을 읽는 중…</h3><p class="lbl">보통 10~30초 걸립니다. 서버가 바쁘면 다른 AI 모델로 자동으로 다시 시도하니 1분 정도 기다려 주세요.</p>`);
  try {
    const b64 = await imageToBase64(file);
    const { data } = await fb.readClosingImage(b64, 'image/jpeg');
    showAiResult(interpret(data || {}));
  } catch (e) {
    console.error(e);
    const m = String(e && (e.code || '') + ' ' + (e.message || ''));
    let msg = '사진을 읽지 못했습니다. 잠시 후 다시 시도하거나 직접 입력하세요.';
    if (/not-configured/.test(m)) msg = 'AI 사진 인식 설정(App Check 키)이 아직 되어 있지 않습니다.';
    else if (/app.?check|appCheck|401|403|PERMISSION|unauthenticated/i.test(m)) msg = 'AI 보안 확인(App Check)에 실패했습니다. Firebase 설정을 확인하거나 페이지를 새로고침한 뒤 다시 시도하세요.';
    else if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(m)) msg = 'AI 사용 한도에 걸렸습니다. 1~2분 뒤 다시 시도하세요. 계속되면 아래 오류 내용을 캡처해서 보내 주세요.';
    else if (/JSON|Unexpected token/i.test(m)) msg = '화면 내용을 알아보지 못했습니다. 통계 화면 전체가 선명하게 나오도록 다시 찍어 주세요.';
    const detail = (e && e.tried && e.tried.length ? e.tried.join('\n') : m).slice(0, 900);
    showModal(`<h3>읽기 실패</h3><p class="lbl">${esc(msg)}</p><details style="margin-top:8px"><summary class="lbl" style="cursor:pointer">오류 자세히 보기</summary><pre style="white-space:pre-wrap;font-size:11.5px;background:#f4f1ea;padding:8px;border-radius:8px;max-height:220px;overflow:auto">${esc(detail)}</pre></details><div class="acts"><button class="btn pri" data-m="close">닫기</button></div>`);
  } finally { aiBusy = false }
}
function showAiResult(res) {
  const target = res.date || S.date;
  const diffDate = res.date && res.date !== S.date;
  const cur = S.days[target] && S.days[target].sales || {};
  const hasOld = ['rxCash', 'rxCard', 'otcCash', 'otcCard'].some(k => cur[k] != null);
  const inp = (id, v) => `<input class="amt txt" id="${id}" value="${fmt(v)}" inputmode="tel" style="text-align:right">`;
  showModal(`<h3>마감 화면에서 읽은 금액</h3>
    <p class="lbl" style="margin:-4px 0 10px">화면 날짜: <b>${res.date ? korDate(res.date) : '읽지 못함'}</b>${diffDate ? ` <span class="badge warn">지금 보는 날짜(${shortDate(S.date)})와 다름</span>` : ''}</p>
    <table class="stmt" style="margin-bottom:8px">
      <thead><tr><th></th><th class="n">현금</th><th class="n">카드</th></tr></thead>
      <tbody>
        <tr><td style="white-space:nowrap">조제 본인부담</td><td>${inp('ai-rxCash', res.rx.cash)}</td><td>${inp('ai-rxCard', res.rx.card)}</td></tr>
        <tr><td style="white-space:nowrap">일반약·건기식</td><td>${inp('ai-otcCash', res.otc.cash)}</td><td>${inp('ai-otcCard', res.otc.card)}</td></tr>
      </tbody>
    </table>
    <div class="lbl" style="font-size:12.5px">${res.rx.how ? `조제 현금 = ${esc(res.rx.how)}<br>` : ''}${res.otc.how ? `일반약 현금 = ${esc(res.otc.how)}` : ''}</div>
    ${res.warns.length ? `<div class="bn" style="margin-top:10px">${res.warns.map(w => '⚠️ ' + esc(w)).join('<br>')}</div>` : `<div class="bn" style="margin-top:10px;background:var(--green-soft);color:var(--green-ink)">✓ 총계와 카드·현금 합계가 맞습니다.</div>`}
    <p class="lbl" style="margin-top:10px">AI가 읽은 값이니 화면과 한 번 대조한 뒤 적용하세요.${hasOld ? ' 이미 입력된 조제·일반약 현금/카드 금액은 덮어씁니다.' : ''}</p>
    <div class="acts">${diffDate ? `<button class="btn left" data-m="apply-cur">${shortDate(S.date)}에 입력</button>` : ''}<button class="btn" data-m="close">취소</button><button class="btn pri" data-m="apply">${shortDate(target)}에 입력</button></div>`,
    (k, m) => {
      if (k !== 'apply' && k !== 'apply-cur') return;
      const d = k === 'apply' ? target : S.date;
      if (S.days[d] && S.days[d].closed) { toast(`${shortDate(d)}은 마감된 날입니다. 마감 해제 후 입력하세요`); return }
      const g = id => parseAmt(m.querySelector('#' + id).value);
      const vals = { rxCash: g('ai-rxCash'), rxCard: g('ai-rxCard'), otcCash: g('ai-otcCash'), otcCard: g('ai-otcCard') };
      closeModal(); flushAll();
      S.date = d; if (location.hash !== '#today') location.hash = '#today';
      editDay(day => { day.sales = day.sales || {}; Object.assign(day.sales, vals) }, { now: true, full: true });
      toast(`${shortDate(d)} 매출을 입력했습니다`);
    });
}
document.addEventListener('paste', e => {
  if (S.phase !== 'app' || S.view !== 'today' || !fb.aiReady()) return;
  const it = [...((e.clipboardData && e.clipboardData.items) || [])].find(i => i.type && i.type.startsWith('image/'));
  if (!it) return;
  e.preventDefault(); processImage(it.getAsFile());
});

boot();
