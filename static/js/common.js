// =====================================================
// 여러 페이지가 같이 쓰는 화면 도우미 (접수팀·진료팀·약국팀·관리자)
// api.js 다음, 페이지 js보다 먼저 불러온다.
// =====================================================

const byId = (id) => document.getElementById(id);

// 사람이 입력한 문자열을 innerHTML에 넣기 전에 반드시 거친다
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sexLabel(sex) {
    return sex === 'F' ? '여' : '남';
}

// 나이 = 방문연도 − 출생연도
function calcAge(visitDate, birthYear) {
    return Number(visitDate.slice(0, 4)) - birthYear;
}

// "여 · 1990년생 (36세) · 현지 이름" - 목록·상세 머리말에 쓰는 환자 요약 (escape 전 문자열)
function patientMeta(visit) {
    const p = visit.patient;
    const parts = [
        sexLabel(p.sex),
        `${p.birth_year}년생 (${calcAge(visit.visit_date, p.birth_year)}세)`,
    ];
    if (p.name_local) parts.push(p.name_local);
    return parts.join(' · ');
}

// "FM · 김의사" - 의사 표시 (escape된 HTML 반환)
function doctorLabel(name, deptCode) {
    return deptCode ? `${escapeHtml(deptCode)} · ${escapeHtml(name)}` : escapeHtml(name);
}

// 화면 아래 잠깐 뜨는 알림 - 페이지에 <div class="toast" id="toast">가 있어야 한다
let toastTimer = null;
function showToast(message, isError = false) {
    const el = byId('toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// 이 기기 날짜 "2026-10-15" (약국 통계 기본 날짜·유통기한 비교, 관리자 입고일 기본값)
function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 유통기한을 모르는 약에 import_drugs가 넣는 임시 날짜 - 화면에는 날짜 대신 '미확인'으로 보인다
const PLACEHOLDER_EXPIRY = '2099-12-31';

// 유통기한 글자 "2028-10-29" / 임시 날짜면 "미확인" (escape 전 문자열)
function expiryText(date) {
    return date === PLACEHOLDER_EXPIRY ? '미확인' : date;
}

// 서버 시각(ISO) → "2026-10-15 14:35" (이 기기 시간대)
function dateTimeLabel(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
