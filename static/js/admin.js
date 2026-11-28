// =====================================================
// 관리자 페이지
//   1. 미션 선택 (진행중 미션 먼저) - 통계·미션 재고 탭에서만 보인다
//   2. 탭 (통계 | 미션 재고 | 창고 재고 | 약품 | 설정)
//   3. 통계 탭 - 요약, 진료과별 환자 수, 약 분류별·진료과별 사용량, 다음 미션 준비표, 엑셀 다운로드
//   4. 약품 탭 - 약품·분류·세부 분류 추가·수정·삭제, 검색
//   5. 창고 재고 탭 - 입고 배치 추가·수정·삭제, 잔량 보정·이력 (보정·이력 모달은 미션 재고와 공용)
//   6. 미션 재고 탭 - 배분 추가, 배분량 수정, 현장 잔량 보정, 정산(한 줄 / 한꺼번에), 삭제
//   7. 설정 탭 - 현장 시간대 (서버 기준 오늘·지금 시각, 이 기기 시계 비교)
// escapeHtml, showToast, byId는 common.js
// =====================================================

const TAB_KEY = 'admin_tab';            // 마지막으로 본 탭 (localStorage)
const MISSION_KEY = 'admin_mission';    // 마지막으로 고른 미션 id (localStorage)
const TABS = ['stats', 'mission-stock', 'warehouse', 'drugs', 'settings'];
const MISSION_TABS = ['stats', 'mission-stock'];   // 미션을 골라서 보는 탭

// 탭이 열리거나 미션이 바뀔 때 부르는 함수 - 단계마다 채운다 { 탭: (mission) => {...} }
const TAB_LOADERS = {};

// ----- 상태 -----
let missions = [];              // 미션 목록 (서버 응답 그대로)
let currentMission = null;      // 고른 미션
let activeTab = 'stats';
let isBusy = false;             // 저장 요청 중이면 중복 클릭을 막음


// =====================================================
// 1. 미션 선택
// =====================================================

// "2026.09.12 – 10.31" (해가 바뀌면 끝 날짜에도 연도)
function missionPeriodLabel(m) {
    const [sy, sm, sd] = m.start_date.split('-');
    const [ey, em, ed] = m.end_date.split('-');
    return `${sy}.${sm}.${sd} – ${sy === ey ? '' : `${ey}.`}${em}.${ed}`;
}

function missionChipHtml(m) {
    const active = currentMission && currentMission.id === m.id ? ' active' : '';
    return `
        <button type="button" class="mission-chip${active}" role="radio" aria-checked="${Boolean(active)}" data-mission-id="${m.id}">
            <span class="mission-chip-top">
                <span class="mission-chip-name">${escapeHtml(m.country)}</span>
                ${m.is_active ? '<span class="doctor-tag">진행중</span>' : ''}
            </span>
            <span class="mission-chip-date">${missionPeriodLabel(m)}</span>
        </button>`;
}

function renderMissionChips() {
    byId('mission-chips').innerHTML = missions.length === 0
        ? '<p class="empty-text">미션이 없습니다. Django admin(/admin/)에서 미션을 먼저 만드세요.</p>'
        : missions.map(missionChipHtml).join('');
}

function selectMission(id) {
    currentMission = missions.find((m) => m.id === id) || null;
    if (currentMission) localStorage.setItem(MISSION_KEY, String(currentMission.id));
    renderMissionChips();
    loadActiveTab();
}

async function loadMissions() {
    const data = await apiFetch('/manage/missions/?page_size=500');
    missions = data.results;
    // 지난번에 고른 미션 → 없으면 첫 번째(진행중 미션이 맨 앞)
    const savedId = Number(localStorage.getItem(MISSION_KEY));
    currentMission = missions.find((m) => m.id === savedId) || missions[0] || null;
    renderMissionChips();
}

byId('mission-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.mission-chip');
    if (chip) selectMission(Number(chip.dataset.missionId));
});


// =====================================================
// 2. 탭
// =====================================================

function loadActiveTab() {
    const loader = TAB_LOADERS[activeTab];
    if (!loader) return;
    if (MISSION_TABS.includes(activeTab) && !currentMission) return;
    loader(currentMission);
}

function showTab(tab) {
    activeTab = TABS.includes(tab) ? tab : 'stats';
    localStorage.setItem(TAB_KEY, activeTab);
    byId('main-tabs').querySelectorAll('.tab-button').forEach((btn) => {
        const on = btn.dataset.tab === activeTab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', String(on));
    });
    TABS.forEach((t) => { byId(`tab-${t}`).hidden = t !== activeTab; });
    byId('mission-bar').hidden = !MISSION_TABS.includes(activeTab);
    loadActiveTab();
}

byId('main-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-button');
    if (btn) showTab(btn.dataset.tab);
});


// =====================================================
// 3. 통계 탭
// =====================================================

const AGE_SEX_COLUMNS = [['소아', 'M'], ['소아', 'F'], ['성인', 'M'], ['성인', 'F']];

let statsData = null;           // { visit, drug } - 고른 미션의 통계 (서버 응답 그대로)
let statsRequestSeq = 0;        // 미션을 빨리 바꿀 때 늦게 온 예전 응답을 버리기 위한 번호
let categoryLevel = 'cat1';     // 분류별 사용량: 'cat1'(분류) | 'cat2'(세부 분류)

function statTileHtml(label, value, unit) {
    return `
        <div class="stat-tile">
            <span class="stat-tile-label">${label}</span>
            <span class="stat-tile-value">${value}<small>${unit}</small></span>
        </div>`;
}

function emptyRowHtml(text) {
    return `<p class="empty-text">${text}</p>`;
}

function renderStatsSummary(visit) {
    const count = (age) => visit.by_age_sex.filter((x) => x.age_group === age).reduce((sum, x) => sum + x.count, 0);
    byId('admin-stats-summary').innerHTML = [
        statTileHtml('전체 방문', visit.total_visits, '건'),
        statTileHtml('실제 환자', visit.total_patients, '명'),
        statTileHtml('소아 (19세 이하)', count('소아'), '명'),
        statTileHtml('성인 (20세 이상)', count('성인'), '명'),
    ].join('');
}

// 진료과 × (소아/성인 × 성별) 표 + 맨 아래 전체(방문 기준) - 환자 통계와 날짜별(하루치)이 같이 쓴다
function renderVisitStatsTable(visit) {
    byId('visit-stats-table').innerHTML = deptAgeSexTableHtml(visit.rows, visit.by_age_sex);
}

function deptAgeSexTableHtml(rows, byAgeSex) {
    if (rows.length === 0) return emptyRowHtml('진료 완료된 환자가 없습니다.');
    const table = new Map();   // 진료과 → { '소아M': 3, ... }
    rows.forEach((r) => {
        if (!table.has(r.department)) table.set(r.department, {});
        table.get(r.department)[r.age_group + r.sex] = r.count;
    });
    const cells = (counts) => {
        const values = AGE_SEX_COLUMNS.map(([a, s]) => counts[a + s] || 0);
        const total = values.reduce((sum, n) => sum + n, 0);
        return values.map((n) => `<td class="stats-qty">${n}</td>`).join('') + `<td class="stats-qty">${total}</td>`;
    };
    const totals = {};
    byAgeSex.forEach((x) => { totals[x.age_group + x.sex] = x.count; });

    return `
        <table class="stats-table">
            <thead><tr>
                <th>진료과</th>
                ${AGE_SEX_COLUMNS.map(([a, s]) => `<th class="stats-qty">${a} ${sexLabel(s)}</th>`).join('')}
                <th class="stats-qty">합계</th>
            </tr></thead>
            <tbody>
                ${[...table].map(([dept, counts]) => `<tr><td>${escapeHtml(dept)}</td>${cells(counts)}</tr>`).join('')}
                <tr class="is-total"><td>전체 (방문 기준)</td>${cells(totals)}</tr>
            </tbody>
        </table>`;
}

function renderCategoryStats() {
    byId('category-tabs').querySelectorAll('.tab-button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.level === categoryLevel);
    });
    if (!statsData) return;
    const rows = categoryLevel === 'cat1' ? statsData.drug.by_cat1 : statsData.drug.by_cat2;
    byId('category-stats-table').innerHTML = rows.length === 0
        ? emptyRowHtml('아직 수령 처리된 약이 없습니다.')
        : `<table class="stats-table">
               <thead><tr><th>${categoryLevel === 'cat1' ? '분류' : '세부 분류'}</th>
                   <th class="stats-qty">사용량</th><th class="stats-qty">약 종수</th></tr></thead>
               <tbody>${rows.map((r) => `
                   <tr><td>${escapeHtml(r.name)}</td>
                       <td class="stats-qty">${r.total_quantity}</td><td class="stats-qty">${r.drug_kinds}</td></tr>`).join('')}
               </tbody>
           </table>`;
}

// 진료과마다 펼치면 그 과에서 쓴 약 목록 (<details>)
function renderDepartmentStats(drug) {
    if (drug.by_department.length === 0) {
        byId('department-stats').innerHTML = emptyRowHtml('아직 수령 처리된 약이 없습니다.');
        return;
    }
    byId('department-stats').innerHTML = drug.by_department.map((d) => {
        const drugs = drug.department_drugs.filter((x) => x.department === d.name);
        return `
            <details class="dept-row">
                <summary>
                    <span class="dept-name">${escapeHtml(d.name)}</span>
                    <span class="dept-numbers">사용량 <strong>${d.total_quantity}</strong> · 약 ${d.drug_kinds}종 · 환자 ${d.patients}명</span>
                </summary>
                <table class="stats-table">
                    <tbody>${drugs.map((x) => `
                        <tr><td>${escapeHtml(x.drug_name)}</td><td class="stats-qty">${x.total_quantity}</td></tr>`).join('')}
                    </tbody>
                </table>
            </details>`;
    }).join('');
}

function renderPrepTable(drug) {
    byId('prep-days').textContent = `진료한 날 ${drug.days_worked}일`;
    if (drug.prep.length === 0) {
        byId('prep-table').innerHTML = emptyRowHtml('이 미션에 배분된 재고가 없습니다.');
        return;
    }
    byId('prep-table').innerHTML = `
        <table class="stats-table">
            <thead><tr>
                <th>분류</th><th>약</th>
                <th class="stats-qty">챙겨 간 양</th><th class="stats-qty">쓴 양</th><th class="stats-qty">남은 양</th>
                <th class="stats-qty">기부량</th><th class="stats-qty">하루 평균</th>
            </tr></thead>
            <tbody>${drug.prep.map((r) => `
                <tr${r.allocated_qty > 0 && r.remaining_qty === 0 ? ' class="is-used-up"' : ''}>
                    <td>${escapeHtml(r.cat1_name)}</td><td>${escapeHtml(r.drug_name)}</td>
                    <td class="stats-qty">${r.allocated_qty}</td><td class="stats-qty">${r.used_qty}</td>
                    <td class="stats-qty">${r.remaining_qty}</td><td class="stats-qty">${r.donated_qty}</td>
                    <td class="stats-qty">${r.daily_avg}</td>
                </tr>`).join('')}
            </tbody>
        </table>`;
}

async function loadStats(mission) {
    const seq = ++statsRequestSeq;
    byId('stats-mission-label').textContent = `${mission.country} · ${missionPeriodLabel(mission)} 미션`;
    try {
        const [visit, drug] = await Promise.all([
            apiFetch(`/manage/visits/stats/?mission=${mission.id}`),
            apiFetch(`/manage/drug-stats/?mission=${mission.id}`),
        ]);
        if (seq !== statsRequestSeq) return;   // 그 사이 다른 미션을 골랐다
        statsData = { visit, drug };
        renderStatsSummary(visit);
        renderVisitStatsTable(visit);
        renderCategoryStats();
        renderDepartmentStats(drug);
        renderPrepTable(drug);
        renderDailyStats(visit.daily);
        renderDoctorStats(visit.doctors, visit.doctors_others);
    } catch (err) {
        if (seq !== statsRequestSeq) return;
        statsData = null;
        byId('admin-stats-summary').innerHTML = '';
        byId('visit-stats-table').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
        ['category-stats-table', 'department-stats', 'prep-table', 'daily-stats-table', 'daily-print-all', 'doctor-stats']
            .forEach((id) => { byId(id).innerHTML = ''; });
        byId('daily-day-summary').hidden = true;
    }
}

TAB_LOADERS.stats = loadStats;

// ----- 날짜별 환자 수 -----

const DAILY_COLUMNS = [
    ['registered', '등록'], ['done', '진료 완료'], ['dispensed', '약 수령'],
    ['child', '소아'], ['adult', '성인'], ['male', '남'], ['female', '여'],
];

let dailyData = null;    // { rows: [{date, registered, ..., by_department, by_age_sex}], total } - 서버 응답 그대로

// 전체 날짜 요약표 - 날짜마다 등록·진료 완료·약 수령·소아·성인·남·여, 맨 아래 합계
function dailyOverviewHtml(daily) {
    const cells = (row) => DAILY_COLUMNS.map(([key]) => `<td class="stats-qty">${row[key]}</td>`).join('');
    return `
        <table class="stats-table">
            <thead><tr>
                <th>날짜</th>${DAILY_COLUMNS.map(([, label]) => `<th class="stats-qty">${label}</th>`).join('')}
            </tr></thead>
            <tbody>
                ${daily.rows.map((r) => `<tr><td class="nowrap">${escapeHtml(r.date)}</td>${cells(r)}</tr>`).join('')}
                <tr class="is-total"><td>합계 (${daily.rows.length}일)</td>${cells(daily.total)}</tr>
            </tbody>
        </table>`;
}

const DAILY_ALL = 'all';    // 날짜 드롭다운의 '전체 기간'

function renderDailyStats(daily) {
    dailyData = daily;
    const select = byId('daily-date');
    // 고르던 날짜가 이 미션에도 있으면 그대로, 아니면 가장 최근 진료 날짜(진료가 없으면 가장 최근 날짜)
    const latestDone = [...daily.rows].reverse().find((r) => r.done > 0) || daily.rows[daily.rows.length - 1];
    const keep = select.value === DAILY_ALL || daily.rows.some((r) => r.date === select.value)
        ? select.value
        : (latestDone ? latestDone.date : DAILY_ALL);
    select.innerHTML = [...daily.rows].reverse().map((r) =>
        `<option value="${escapeHtml(r.date)}"${r.date === keep ? ' selected' : ''}>${escapeHtml(r.date)} · 진료 ${r.done}명</option>`,
    ).join('') + `<option value="${DAILY_ALL}"${keep === DAILY_ALL ? ' selected' : ''}>전체 기간</option>`;

    // 인쇄용: 전체 요약 + 진료가 있던 날마다 진료과 표
    byId('daily-print-all').innerHTML = daily.rows.length === 0 ? '' : dailyOverviewHtml(daily) + daily.rows
        .filter((r) => r.done > 0)
        .map((r) => `<h3 class="daily-print-date">${escapeHtml(r.date)} · 진료 ${r.done}명</h3>
                     ${deptAgeSexTableHtml(r.by_department, r.by_age_sex)}`)
        .join('');
    renderDailyView();
}

// 드롭다운에서 고른 날짜 - 그날 숫자 4칸 + 진료과 × 소아/성인 × 성별 표.
// '전체 기간'이면 전체 숫자 + 전체 진료과 표(환자 통계와 같음) + 날짜마다 등록·진료 완료·약 수령 요약표
function renderDailyView() {
    const summary = byId('daily-day-summary');
    if (!dailyData || dailyData.rows.length === 0) {
        summary.hidden = true;
        byId('daily-stats-table').innerHTML = emptyRowHtml('아직 등록된 환자가 없습니다.');
        return;
    }
    const isAll = byId('daily-date').value === DAILY_ALL;
    const day = isAll ? dailyData.total : dailyData.rows.find((r) => r.date === byId('daily-date').value);
    if (!day) return;
    summary.hidden = false;
    summary.innerHTML = [
        statTileHtml('등록', day.registered, '명'),
        statTileHtml('진료 완료', day.done, '명'),
        statTileHtml('약 수령', day.dispensed, '명'),
        statTileHtml('소아 / 성인', `${day.child} / ${day.adult}`, '명'),
    ].join('');
    byId('daily-stats-table').innerHTML = isAll
        ? deptAgeSexTableHtml(statsData.visit.rows, statsData.visit.by_age_sex)
          + `<h3 class="daily-sub-title">날짜마다 한눈에</h3>${dailyOverviewHtml(dailyData)}`
        : deptAgeSexTableHtml(day.by_department, day.by_age_sex);
}

byId('daily-date').addEventListener('change', renderDailyView);

// ----- 의사별 진료 수 (펼치면 진료과별) -----

// others: 진료팀이 아닌 계정(관리자 테스트 등)이 쓴 처방 - 의사별에서 빼고 건수만 알려준다
function renderDoctorStats(doctors, others) {
    const note = others && others.prescriptions > 0
        ? `<p class="modal-note doctor-others-note">진료팀이 아닌 계정(${escapeHtml(others.names.join(', '))})이 쓴 처방
               ${others.prescriptions}건(환자 ${others.patients}명)은 의사별에 넣지 않았습니다. 환자 통계에는 들어갑니다.</p>`
        : '';
    if (doctors.length === 0) {
        byId('doctor-stats').innerHTML = emptyRowHtml('이 미션에 진료팀 의사가 없습니다.') + note;
        return;
    }
    byId('doctor-stats').innerHTML = note + doctors.map((d) => `
        <details class="dept-row">
            <summary>
                <span class="dept-name">${doctorLabel(d.name, d.department_code)}</span>
                <span class="dept-numbers">환자 <strong>${d.patients}</strong>명 · 처방 ${d.prescriptions}건 · 소아 ${d.child} · 성인 ${d.adult}</span>
            </summary>
            ${d.departments.length === 0
                ? emptyRowHtml('진료 완료된 환자가 없습니다.')
                : `<table class="stats-table"><tbody>${d.departments.map((x) => `
                       <tr><td>${escapeHtml(x.name)}</td><td class="stats-qty">${x.count}명</td></tr>`).join('')}
                   </tbody></table>`}
        </details>`).join('');
}

// ----- 통계 종류 드롭다운 (마지막으로 본 것 기억) -----

const STATS_TAB_KEY = 'admin_stats_tab';
const STATS_TABS = ['patients', 'daily', 'doctors', 'drugs', 'prep'];

function showStatsTab(tab) {
    const active = STATS_TABS.includes(tab) ? tab : 'patients';
    localStorage.setItem(STATS_TAB_KEY, active);
    byId('stats-view').value = active;
    document.querySelectorAll('[data-stats-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.statsPanel !== active;
    });
}

byId('stats-view').addEventListener('change', () => showStatsTab(byId('stats-view').value));
showStatsTab(loadSaved(STATS_TAB_KEY));

// ----- PDF로 저장 (브라우저 인쇄 → 'PDF로 저장') -----
// 인쇄할 때는 작은 탭과 상관없이 통계 전부를 찍는다(admin.css의 @media print). 펼치는 줄도 전부 펼친다.

let printOpened = [];   // 인쇄하려고 펼친 <details> - 끝나면 다시 접는다

byId('stats-print-btn').addEventListener('click', () => {
    if (!currentMission || !statsData) {
        showToast('통계를 불러온 뒤에 저장할 수 있습니다.', true);
        return;
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    byId('stats-print-head').innerHTML = `
        <h1>${escapeHtml(currentMission.country)} 미션 통계</h1>
        <p>${missionPeriodLabel(currentMission)} · 출력 ${todayStr()} ${pad(now.getHours())}:${pad(now.getMinutes())}</p>`;
    window.print();
});

window.addEventListener('beforeprint', () => {
    printOpened = [...byId('tab-stats').querySelectorAll('details:not([open])')];
    printOpened.forEach((d) => { d.open = true; });
});

window.addEventListener('afterprint', () => {
    printOpened.forEach((d) => { d.open = false; });
    printOpened = [];
});

byId('category-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-button');
    if (!btn) return;
    categoryLevel = btn.dataset.level;
    renderCategoryStats();
});

byId('stats-export-btn').addEventListener('click', async () => {
    if (!currentMission) return;
    const btn = byId('stats-export-btn');
    btn.disabled = true;
    btn.textContent = '만드는 중…';
    try {
        await apiDownload(`/manage/mission-stocks/export/?mission=${currentMission.id}`, `mission_${currentMission.id}_stats.xlsx`);
    } catch (err) {
        showToast(err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = '엑셀 다운로드';
    }
});


// =====================================================
// 공용 - 삭제 확인 모달
// =====================================================

// "OO을(를) 삭제합니다" 확인 후 DELETE. 쓰이고 있어서 못 지우면 서버 메시지를 토스트로.
function confirmDelete({ title, name, path, onDone }) {
    openModal({
        title,
        bodyHtml: `<p class="modal-note">${escapeHtml(name)}을(를) 삭제합니다. 되돌릴 수 없어요.</p>`,
        confirmLabel: '삭제',
        onConfirm: () => {
            (async () => {
                try {
                    await apiFetch(path, { method: 'DELETE' });
                    showToast(`${name}을(를) 삭제했습니다.`);
                    onDone();
                } catch (err) {
                    showToast(err.message, true);
                }
            })();
        },
    });
}


// =====================================================
// 4. 약품 탭 - 약품 / 분류(cat1) / 세부 분류(cat2)
// =====================================================

let cat1List = [];              // 분류 [{id, name, uses_dosage_schedule}]
let cat2List = [];              // 세부 분류 [{id, name}]
let drugList = [];              // 지금 검색 조건의 약품
let drugTree = [];              // 약품이 있는 분류 → 세부 분류 (약품 필터 선택지, 개수 포함)
let drugRequestSeq = 0;         // 검색어를 빨리 바꿀 때 늦게 온 예전 응답을 버리기 위한 번호
let drugSearchTimer = null;

function optionsHtml(list, selectedId, emptyLabel) {
    const empty = emptyLabel === null ? '' : `<option value="">${emptyLabel}</option>`;
    return empty + list.map((x) =>
        `<option value="${x.id}"${String(x.id) === String(selectedId) ? ' selected' : ''}>${escapeHtml(x.name)}</option>`,
    ).join('');
}

// ----- 분류 -----

function categoryRowHtml(c, level) {
    const sub = level === 'cat1'
        ? (c.uses_dosage_schedule ? '처방: 복용스케줄(1회량·횟수·일수)' : '처방: 수량 직접 입력')
        : '';
    return `
        <div class="admin-row" data-level="${level}" data-id="${c.id}">
            <span class="admin-row-main">
                <span class="admin-row-title">${escapeHtml(c.name)}</span>
                ${sub ? `<span class="admin-row-sub">${sub}</span>` : ''}
            </span>
            <span class="admin-row-actions">
                <button type="button" class="btn-secondary btn-small" data-action="edit">수정</button>
                <button type="button" class="row-delete" data-action="delete">삭제</button>
            </span>
        </div>`;
}

function renderCategories() {
    byId('cat1-list').innerHTML = cat1List.length === 0
        ? emptyRowHtml('분류가 없습니다.')
        : cat1List.map((c) => categoryRowHtml(c, 'cat1')).join('');
    byId('cat2-list').innerHTML = cat2List.length === 0
        ? emptyRowHtml('세부 분류가 없습니다.')
        : cat2List.map((c) => categoryRowHtml(c, 'cat2')).join('');
}

// ----- 약품 필터 (분류 → 세부 분류) -----
// 약품이 있는 분류만 개수와 함께 보이고, 분류를 고르면 세부 분류는 그 분류 안의 것만 (진료팀 처방 화면과 같은 방식)

async function loadDrugTree() {
    try {
        drugTree = await apiFetch('/manage/drugs/category-tree/');
    } catch (err) {
        console.error(err);
        return;
    }
    renderDrugFilters();
}

function renderDrugFilters() {
    const option = (c, selected) =>
        `<option value="${c.id}"${String(c.id) === String(selected) ? ' selected' : ''}>${escapeHtml(c.name)} (${c.count})</option>`;

    const cat1Select = byId('drug-filter-cat1');
    const cat1Value = drugTree.some((c) => String(c.id) === cat1Select.value) ? cat1Select.value : '';
    cat1Select.innerHTML = '<option value="">분류 전체</option>' + drugTree.map((c) => option(c, cat1Value)).join('');

    // 분류를 골랐으면 그 분류의 세부 분류, 전체면 모든 분류의 세부 분류를 이름별로 합친다
    const chosen = drugTree.find((c) => String(c.id) === cat1Value);
    let list = chosen ? chosen.cat2 : [];
    if (!chosen) {
        const merged = new Map();
        drugTree.forEach((c) => c.cat2.forEach((x) => {
            const prev = merged.get(x.id);
            merged.set(x.id, { ...x, count: (prev ? prev.count : 0) + x.count });
        }));
        list = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }
    const cat2Select = byId('drug-filter-cat2');
    const cat2Value = list.some((x) => String(x.id) === cat2Select.value) ? cat2Select.value : '';
    cat2Select.innerHTML = '<option value="">세부 분류 전체</option>' + list.map((x) => option(x, cat2Value)).join('');
}

async function loadCategories() {
    const [c1, c2] = await Promise.all([
        apiFetch('/manage/drug-categories1/?page_size=500'),
        apiFetch('/manage/drug-categories2/?page_size=500'),
    ]);
    cat1List = c1.results;
    cat2List = c2.results;
    renderCategories();
}

function openCategoryModal(level, category = null) {
    const label = level === 'cat1' ? '분류' : '세부 분류';
    const schedule = level === 'cat1'
        ? `<div class="toggle-row">
               <label class="toggle"><input type="checkbox" id="cm-schedule"${category && category.uses_dosage_schedule ? ' checked' : ''}>
               <span>처방할 때 복용스케줄(1회량·횟수·일수)로 입력</span></label>
           </div>
           <p class="modal-note">끄면 진료팀이 수량을 직접 입력합니다 (외용약·주사제처럼).</p>`
        : '';
    openModal({
        title: category ? `${label} 수정` : `${label} 추가`,
        bodyHtml: `
            <label class="field-label" for="cm-name">${label} 이름 *</label>
            <input class="field-input" type="text" id="cm-name" maxlength="50" value="${escapeHtml(category ? category.name : '')}">
            ${schedule}
            <p class="error-message" id="cm-error"></p>`,
        confirmLabel: category ? '저장' : '추가',
        onConfirm: () => { saveCategory(level, category); return false; },
    });
    byId('cm-name').focus();
}

async function saveCategory(level, category) {
    if (isBusy) return;
    const errorEl = byId('cm-error');
    const name = byId('cm-name').value.trim();
    if (!name) {
        errorEl.textContent = '이름을 입력해주세요.';
        return;
    }
    const body = { name };
    if (level === 'cat1') body.uses_dosage_schedule = byId('cm-schedule').checked;

    const base = level === 'cat1' ? '/manage/drug-categories1/' : '/manage/drug-categories2/';
    isBusy = true;
    try {
        await apiFetch(category ? `${base}${category.id}/` : base, {
            method: category ? 'PATCH' : 'POST',
            body: JSON.stringify(body),
        });
    } catch (err) {
        // 이름이 겹치면 서버가 name 필드 오류를 준다
        errorEl.textContent = err.message.startsWith('name:') ? '같은 이름이 이미 있습니다.' : err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    showToast(category ? '저장했습니다.' : `${name}을(를) 추가했습니다.`);
    await loadCategories();
    loadDrugTree();
    loadDrugs();    // 약품 목록의 분류 이름도 바뀌었을 수 있다
}

['cat1-list', 'cat2-list'].forEach((listId) => {
    byId(listId).addEventListener('click', (e) => {
        const row = e.target.closest('.admin-row');
        const action = e.target.dataset.action;
        if (!row || !action) return;
        const level = row.dataset.level;
        const list = level === 'cat1' ? cat1List : cat2List;
        const category = list.find((c) => c.id === Number(row.dataset.id));
        if (!category) return;
        if (action === 'edit') openCategoryModal(level, category);
        if (action === 'delete') {
            const base = level === 'cat1' ? '/manage/drug-categories1/' : '/manage/drug-categories2/';
            confirmDelete({
                title: level === 'cat1' ? '분류 삭제' : '세부 분류 삭제',
                name: category.name,
                path: `${base}${category.id}/`,
                onDone: loadCategories,
            });
        }
    });
});

document.querySelectorAll('[data-add-category]').forEach((btn) => {
    btn.addEventListener('click', () => openCategoryModal(btn.dataset.addCategory));
});

// ----- 약품 -----

function drugRowHtml(d) {
    const sub = [d.ingredient, d.usage].filter(Boolean).join(' · ');
    return `
        <div class="admin-row" data-id="${d.id}">
            <span class="admin-row-main">
                <span class="admin-row-title">${escapeHtml(d.name)}</span>
                ${sub ? `<span class="admin-row-sub">${escapeHtml(sub)}</span>` : ''}
            </span>
            <span class="admin-row-tags">
                <span class="doctor-tag waiting">${escapeHtml(d.cat1_name)}</span>
                <span class="doctor-tag waiting">${escapeHtml(d.cat2_name)}</span>
                ${d.mfds_item_seq ? '<span class="doctor-tag" title="식약처 허가 품목에 연결됨">식약처</span>' : ''}
            </span>
            <span class="admin-row-actions">
                <button type="button" class="btn-secondary btn-small" data-action="edit">수정</button>
                <button type="button" class="row-delete" data-action="delete">삭제</button>
            </span>
        </div>`;
}

async function loadDrugs() {
    const seq = ++drugRequestSeq;
    const params = new URLSearchParams({ page_size: '500' });
    const search = byId('drug-search').value.trim();
    if (search) params.set('search', search);
    if (byId('drug-filter-cat1').value) params.set('cat1', byId('drug-filter-cat1').value);
    if (byId('drug-filter-cat2').value) params.set('cat2', byId('drug-filter-cat2').value);
    try {
        const data = await apiFetch(`/manage/drugs/?${params}`);
        if (seq !== drugRequestSeq) return;
        drugList = data.results;
        byId('drug-count').textContent = `${data.count}종`;
        byId('drug-list').innerHTML = drugList.length === 0
            ? emptyRowHtml(search || params.has('cat1') || params.has('cat2') ? '조건에 맞는 약품이 없습니다.' : '등록된 약품이 없습니다.')
            : drugList.map(drugRowHtml).join('');
    } catch (err) {
        if (seq !== drugRequestSeq) return;
        byId('drug-list').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
}

function openDrugModal(drug = null) {
    if (cat1List.length === 0 || cat2List.length === 0) {
        showToast('아래 분류 카드에서 분류와 세부 분류를 먼저 추가해주세요.', true);
        return;
    }
    const value = (field) => escapeHtml(drug ? drug[field] : '');
    openModal({
        title: drug ? '약품 수정' : '약품 추가',
        bodyHtml: `
            <label class="field-label" for="dm-name">약품명 *</label>
            <input class="field-input" type="text" id="dm-name" maxlength="100" value="${value('name')}">
            <div class="lookup-row">
                <button type="button" class="btn-secondary btn-small" id="dm-lookup-btn">약 정보 찾기 (식약처)</button>
                <span class="lookup-status" id="dm-lookup-status">${drug && drug.mfds_item_seq ? '식약처 품목에 연결된 약입니다' : ''}</span>
            </div>
            <div class="lookup-panel" id="dm-lookup" hidden></div>
            <label class="field-label" for="dm-ingredient">성분</label>
            <input class="field-input" type="text" id="dm-ingredient" maxlength="200" value="${value('ingredient')}">
            <label class="field-label" for="dm-usage">용법</label>
            <input class="field-input" type="text" id="dm-usage" maxlength="200" placeholder="예: 식후 30분" value="${value('usage')}">
            <div class="form-grid">
                <div>
                    <label class="field-label" for="dm-cat1">분류 *</label>
                    <select class="field-input" id="dm-cat1">${optionsHtml(cat1List, drug ? drug.cat1 : '', '선택')}</select>
                </div>
                <div>
                    <label class="field-label" for="dm-cat2">세부 분류 *</label>
                    <select class="field-input" id="dm-cat2">${optionsHtml(cat2List, drug ? drug.cat2 : '', '선택')}</select>
                </div>
            </div>
            <p class="error-message" id="dm-error"></p>`,
        confirmLabel: drug ? '저장' : '추가',
        onConfirm: () => { saveDrug(drug); return false; },
        wide: true,
    });
    mfdsLink = null;
    setupDrugLookup();
    byId('dm-name').focus();
}

async function saveDrug(drug) {
    if (isBusy) return;
    const errorEl = byId('dm-error');
    const body = {
        name: byId('dm-name').value.trim(),
        ingredient: byId('dm-ingredient').value.trim(),
        usage: byId('dm-usage').value.trim(),
        cat1: Number(byId('dm-cat1').value),
        cat2: Number(byId('dm-cat2').value),
    };
    if (!body.name) { errorEl.textContent = '약품명을 입력해주세요.'; return; }
    if (!body.cat1 || !body.cat2) { errorEl.textContent = '분류와 세부 분류를 골라주세요.'; return; }
    if (mfdsLink) {     // [약 정보 찾기]에서 고른 식약처 품목 (안 골랐으면 기존 연결 그대로)
        body.mfds_item_seq = mfdsLink.item_seq;
        body.ingredient_codes = mfdsLink.codes;
    }

    isBusy = true;
    try {
        await apiFetch(drug ? `/manage/drugs/${drug.id}/` : '/manage/drugs/', {
            method: drug ? 'PATCH' : 'POST',
            body: JSON.stringify(body),
        });
    } catch (err) {
        errorEl.textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    showToast(drug ? '저장했습니다.' : `${body.name}을(를) 추가했습니다.`);
    loadDrugTree();     // 분류별 개수가 바뀌었을 수 있다
    loadDrugs();
}

byId('drug-list').addEventListener('click', (e) => {
    const row = e.target.closest('.admin-row');
    const action = e.target.dataset.action;
    if (!row || !action) return;
    const drug = drugList.find((d) => d.id === Number(row.dataset.id));
    if (!drug) return;
    if (action === 'edit') openDrugModal(drug);
    if (action === 'delete') {
        confirmDelete({
            title: '약품 삭제', name: drug.name, path: `/manage/drugs/${drug.id}/`,
            onDone: () => { loadDrugTree(); loadDrugs(); },
        });
    }
});

byId('drug-add-btn').addEventListener('click', () => openDrugModal());

// ----- 약 정보 찾기 (식약처 의약품 제품 허가정보) -----
// 준비할 때(인터넷 되는 곳)만 쓰는 기능. 서버가 식약처 API를 대신 부른다(인증키는 서버에만 있다).
// 고른 품목의 성분·용법·세부 분류를 모달 칸에 넣어 주고, 저장은 사람이 [저장]으로 한다.

let drugInfoEnabled = null;     // 서버에 인증키가 있는지 - 처음 한 번 묻는다
let mfdsLink = null;            // 이 모달에서 고른 식약처 품목 {item_seq, codes} - 저장할 때 같이 보낸다
let lookupResults = [];         // 마지막 찾기 결과 ([다른 품목 고르기]로 돌아갈 때)
let lookupDetail = null;        // 고른 품목의 상세 + 맞는 세부 분류

// 서버에 식약처 인증키가 있는지 - 한 번만 묻는다
async function ensureDrugInfoStatus() {
    if (drugInfoEnabled === null) {
        try {
            drugInfoEnabled = (await apiFetch('/manage/drug-info/')).enabled;
        } catch {
            drugInfoEnabled = false;
        }
    }
    return drugInfoEnabled;
}

async function setupDrugLookup() {
    const btn = byId('dm-lookup-btn');
    btn.addEventListener('click', openLookupPanel);
    byId('dm-lookup').addEventListener('click', onLookupClick);
    await ensureDrugInfoStatus();
    if (!drugInfoEnabled && byId('dm-lookup-btn') === btn) {
        btn.disabled = true;
        byId('dm-lookup-status').textContent = '식약처 API 인증키가 없어 쓸 수 없습니다 (config/local_settings.py)';
    }
}

function openLookupPanel() {
    const panel = byId('dm-lookup');
    panel.hidden = false;
    panel.innerHTML = `
        <div class="lookup-search">
            <input class="field-input" type="search" id="dl-q" placeholder="식약처에서 찾을 약 이름 (예: 세라진)"
                   value="${escapeHtml(byId('dm-name').value.trim())}">
            <button type="button" class="btn-primary btn-inline" data-lookup="search">찾기</button>
        </div>
        <div id="dl-body"></div>`;
    byId('dl-q').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); searchDrugInfo(); }
    });
    if (byId('dl-q').value.length >= 2) searchDrugInfo();
    else byId('dl-q').focus();
}

async function searchDrugInfo() {
    const query = byId('dl-q').value.trim();
    const bodyEl = byId('dl-body');
    if (query.length < 2) {
        bodyEl.innerHTML = '<p class="error-message">약 이름을 두 글자 이상 입력해 주세요.</p>';
        return;
    }
    bodyEl.innerHTML = '<p class="modal-note">식약처에서 찾는 중…</p>';
    try {
        lookupResults = (await apiFetch(`/manage/drug-info/search/?q=${encodeURIComponent(query)}`)).results;
    } catch (err) {
        bodyEl.innerHTML = `<p class="error-message">${escapeHtml(err.message)}</p>`;
        return;
    }
    renderLookupResults();
}

function renderLookupResults() {
    const bodyEl = byId('dl-body');
    if (!bodyEl) return;
    if (lookupResults.length === 0) {
        bodyEl.innerHTML = '<p class="modal-note">찾은 품목이 없습니다. 이름을 줄이거나 성분(영문)으로 찾아 보세요.</p>';
        return;
    }
    bodyEl.innerHTML = `
        <p class="modal-note">${lookupResults.length}개 찾음 - 맞는 품목을 고르세요.</p>
        <div class="lookup-list">${lookupResults.map((r, i) => `
            <button type="button" class="lookup-item" data-lookup="pick" data-index="${i}">
                <span class="lookup-item-name">${escapeHtml(r.short_name)}
                    ${r.canceled ? '<span class="doctor-tag unassigned">허가 취소</span>' : ''}</span>
                <span class="lookup-item-meta">${escapeHtml([r.company, r.kind, r.product_type].filter(Boolean).join(' · '))}</span>
                <span class="lookup-item-meta">${escapeHtml(r.ingredient)}</span>
            </button>`).join('')}
        </div>`;
}

// 식약처 분류(예: '해열.진통.소염제')와 이름이 같은 세부 분류 - 띄어쓰기·점·쉼표는 무시하고 비교
function matchCat2(productType) {
    const key = (name) => name.replace(/[\s.,·]/g, '');
    return productType ? cat2List.find((c) => key(c.name) === key(productType)) || null : null;
}

async function pickDrugInfo(index) {
    const picked = lookupResults[index];
    const bodyEl = byId('dl-body');
    bodyEl.innerHTML = '<p class="modal-note">상세 정보를 불러오는 중…</p>';
    let detail;
    try {
        detail = await apiFetch(`/manage/drug-info/${encodeURIComponent(picked.item_seq)}/`);
    } catch (err) {
        bodyEl.innerHTML = `<p class="error-message">${escapeHtml(err.message)}</p>`;
        return;
    }
    lookupDetail = { ...detail, product_type: picked.product_type, cat2: matchCat2(picked.product_type) };
    renderLookupDetail();
}

function lookupFieldHtml(label, valueText, action, note = '') {
    return `
        <div class="lookup-field">
            <span class="lookup-field-label">${label}</span>
            <span class="lookup-field-value">${valueText ? escapeHtml(valueText) : '<span class="lookup-empty">식약처 정보 없음</span>'}
                ${note ? `<span class="lookup-note">${note}</span>` : ''}</span>
            ${valueText && action ? `<button type="button" class="btn-secondary btn-small" data-lookup="${action}">넣기</button>` : '<span></span>'}
        </div>`;
}

function renderLookupDetail() {
    const d = lookupDetail;
    const reference = [
        ['효능효과', d.efficacy], ['용법용량 (전문)', d.usage_full], ['포장단위', d.pack_unit],
        ['저장방법', d.storage], ['유효기간', d.valid_term], ['성상', d.chart],
    ].filter(([, text]) => text);
    byId('dl-body').innerHTML = `
        <div class="lookup-picked">
            <strong>${escapeHtml(d.name)}</strong>
            <span class="lookup-item-meta">${escapeHtml([d.company, d.kind].filter(Boolean).join(' · '))}</span>
        </div>
        ${lookupFieldHtml('약품명', d.short_name, 'name')}
        ${lookupFieldHtml('성분', d.ingredient, 'ingredient',
            d.ingredient_note ? `${escapeHtml(d.ingredient_note)}${d.material_kr ? ` (식약처 원료: ${escapeHtml(d.material_kr)})` : ''}` : '')}
        ${lookupFieldHtml('용법', d.usage, 'usage', d.usage_truncated ? '200자가 넘어 앞부분만 넣습니다. 현장용으로 줄여 주세요.' : '')}
        ${lookupFieldHtml('세부 분류', d.cat2 ? d.cat2.name : '', 'cat2',
            d.cat2 ? '' : `식약처 분류 '${escapeHtml(d.product_type || '없음')}'와 같은 이름의 세부 분류가 없습니다. 직접 골라 주세요.`)}
        <div class="lookup-actions">
            <button type="button" class="btn-secondary btn-small" data-lookup="back">다른 품목 고르기</button>
            <button type="button" class="btn-primary btn-inline" data-lookup="all">성분·용법·세부 분류 모두 넣기</button>
        </div>
        ${reference.length === 0 ? '' : `
            <details class="import-details">
                <summary>참고 (저장되지 않음)</summary>
                ${reference.map(([label, text]) => `
                    <p class="lookup-ref-label">${label}</p>
                    <p class="lookup-ref-text">${escapeHtml(text)}</p>`).join('')}
            </details>`}`;
}

// 고른 품목의 값을 모달 칸에 넣는다 - 넣은 뒤 [저장]해야 반영된다
function applyLookup(fields) {
    const d = lookupDetail;
    const done = [];
    if (fields.includes('name') && d.short_name) { byId('dm-name').value = d.short_name; done.push('약품명'); }
    if (fields.includes('ingredient') && d.ingredient) { byId('dm-ingredient').value = d.ingredient; done.push('성분'); }
    if (fields.includes('usage') && d.usage) { byId('dm-usage').value = d.usage; done.push('용법'); }
    if (fields.includes('cat2') && d.cat2) { byId('dm-cat2').value = String(d.cat2.id); done.push('세부 분류'); }
    if (done.length === 0) return;
    mfdsLink = { item_seq: d.item_seq, codes: d.ingredient_codes.join(',') };
    byId('dm-lookup-status').textContent = `${done.join('·')} 넣음 - [저장]해야 반영됩니다`;
}

// ----- 식약처에서 한꺼번에 찾기 -----
// 식약처에 아직 연결 안 된 약(약속처방 세트 제외)을 하나씩 찾아 약마다 후보를 보여주고, 체크한 것만 채운다.
// 이름이 맞는 품목(맞음·아마 맞음)은 미리 체크된다. 기본은 빈 성분·용법만 채우고, 약품명은 바꾸지 않는다.

const MATCH_LABELS = { exact: '맞음', likely: '아마 맞음', multiple: '후보 여러 개', none: '못 찾음' };
let bulkRows = [];          // [{drug, status, candidates, choice(후보 위치 또는 -1), checked}]
let bulkRunning = false;    // 찾기·채우기가 도는 중인지 (모달을 닫으면 멈춘다)

function bulkModalOpen() {
    return byId('modal-overlay').classList.contains('open') && Boolean(byId('bulk-rows'));
}

async function openBulkModal() {
    if (!(await ensureDrugInfoStatus())) {
        showToast('식약처 API 인증키가 없어 쓸 수 없습니다. (config/local_settings.py)', true);
        return;
    }
    let drugs;
    try {
        drugs = (await apiFetch('/manage/drugs/?page_size=500')).results;
    } catch (err) {
        showToast(err.message, true);
        return;
    }
    const targets = drugs.filter((d) => !d.mfds_item_seq && !d.cat1_name.startsWith('약속처방'));
    bulkRows = targets.map((d) => ({ drug: d, status: 'waiting', candidates: [], choice: -1, checked: false }));
    openModal({
        title: '식약처에서 한꺼번에 찾기',
        bodyHtml: `
            <p class="modal-note">식약처에 아직 연결 안 된 약 ${targets.length}개를 이름으로 찾습니다 (약속처방 세트는 빼고).
                이름이 맞는 품목은 미리 체크됩니다. 확인하고 [체크한 약 채우기]를 누르세요. 인터넷이 필요합니다.</p>
            <div class="toggle-row">
                <label class="toggle"><input type="checkbox" id="bulk-overwrite"><span>성분·용법이 있어도 식약처 것으로 바꾸기</span></label>
                <label class="toggle"><input type="checkbox" id="bulk-cat2"><span>세부 분류도 식약처 분류에 맞추기</span></label>
            </div>
            <p class="bulk-progress" id="bulk-progress"></p>
            <div class="bulk-rows" id="bulk-rows"></div>
            <p class="error-message" id="bulk-error"></p>`,
        confirmLabel: '체크한 약 채우기',
        onConfirm: () => { applyBulk(); return false; },
        wide: true,
    });
    byId('bulk-rows').addEventListener('change', onBulkChange);
    renderBulkRows();
    runBulkSearch();
}

function bulkRowHtml(row, i) {
    const tag = row.status === 'waiting'
        ? '<span class="doctor-tag waiting">찾는 중</span>'
        : `<span class="doctor-tag${row.status === 'exact' || row.status === 'likely' ? '' : ' waiting'}">${MATCH_LABELS[row.status] || row.status}</span>`;
    const picked = row.candidates[row.choice];
    const select = row.candidates.length === 0 ? '' : `
        <select class="field-input bulk-choice" data-index="${i}" aria-label="${escapeHtml(row.drug.name)} 식약처 품목">
            <option value="-1">고르세요 (${row.candidates.length}개)</option>
            ${row.candidates.map((c, j) => `<option value="${j}"${j === row.choice ? ' selected' : ''}>
                ${escapeHtml(`${c.short_name} · ${c.company}${c.canceled ? ' · 허가 취소' : ''}`)}</option>`).join('')}
        </select>`;
    return `
        <div class="bulk-row${row.checked ? ' is-checked' : ''}">
            <input type="checkbox" class="bulk-check" data-index="${i}"${row.checked ? ' checked' : ''}
                   ${picked ? '' : ' disabled'} aria-label="${escapeHtml(row.drug.name)} 채우기">
            <span class="bulk-name">
                <strong>${escapeHtml(row.drug.name)}</strong> ${tag}
                <span class="lookup-item-meta">${escapeHtml(row.drug.ingredient || '성분 없음')}${row.drug.usage ? '' : ' · 용법 없음'}</span>
            </span>
            <span class="bulk-pick">${select}
                ${picked ? `<span class="lookup-item-meta">${escapeHtml([picked.kind, picked.product_type, picked.ingredient].filter(Boolean).join(' · '))}</span>` : ''}
            </span>
        </div>`;
}

function renderBulkRows() {
    if (!bulkModalOpen()) return;
    byId('bulk-rows').innerHTML = bulkRows.length === 0
        ? emptyRowHtml('식약처에 연결 안 된 약이 없습니다.')
        : bulkRows.map(bulkRowHtml).join('');
    const checked = bulkRows.filter((r) => r.checked).length;
    byId('modal-confirm').textContent = `체크한 약 채우기 (${checked}개)`;
}

async function runBulkSearch() {
    bulkRunning = true;
    for (let i = 0; i < bulkRows.length; i += 1) {
        if (!bulkModalOpen()) break;    // 모달을 닫으면 멈춘다
        byId('bulk-progress').textContent = `찾는 중… ${i + 1} / ${bulkRows.length}`;
        const row = bulkRows[i];
        try {
            const result = await apiFetch(`/manage/drug-info/match/?drug=${row.drug.id}`);
            row.status = result.status;
            row.candidates = result.candidates;
            row.choice = result.best === null ? -1 : result.best;
            row.checked = result.best !== null;
        } catch (err) {
            byId('bulk-progress').textContent = `찾기를 멈췄습니다: ${err.message}`;
            bulkRunning = false;
            renderBulkRows();
            return;
        }
        renderBulkRows();
    }
    bulkRunning = false;
    if (bulkModalOpen()) {
        const count = (s) => bulkRows.filter((r) => r.status === s).length;
        byId('bulk-progress').textContent = `다 찾았습니다 - 맞음 ${count('exact')} · 아마 맞음 ${count('likely')} · `
            + `후보 여러 개 ${count('multiple')} · 못 찾음 ${count('none')}. 후보 여러 개는 직접 골라 체크하세요.`;
    }
}

function onBulkChange(e) {
    const i = Number(e.target.dataset.index);
    const row = bulkRows[i];
    if (!row) return;
    if (e.target.classList.contains('bulk-choice')) {
        row.choice = Number(e.target.value);
        row.checked = row.choice >= 0;     // 품목을 고르면 체크, '고르세요'로 돌리면 해제
    } else if (e.target.classList.contains('bulk-check')) {
        row.checked = e.target.checked;
    }
    renderBulkRows();
}

// 체크한 약마다 상세를 불러 채운다 - 기본은 빈 칸만, 약품명은 그대로
async function applyBulk() {
    if (bulkRunning || isBusy) {
        byId('bulk-error').textContent = '아직 찾는 중입니다. 다 찾은 뒤에 눌러 주세요.';
        return;
    }
    const rows = bulkRows.filter((r) => r.checked && r.candidates[r.choice]);
    if (rows.length === 0) {
        byId('bulk-error').textContent = '채울 약을 체크해 주세요.';
        return;
    }
    const overwrite = byId('bulk-overwrite').checked;
    const withCat2 = byId('bulk-cat2').checked;
    isBusy = true;
    bulkRunning = true;
    const failed = [];
    let done = 0;
    for (const row of rows) {
        byId('bulk-progress').textContent = `채우는 중… ${done + failed.length + 1} / ${rows.length}`;
        const picked = row.candidates[row.choice];
        try {
            const d = await apiFetch(`/manage/drug-info/${encodeURIComponent(picked.item_seq)}/`);
            const body = { mfds_item_seq: d.item_seq, ingredient_codes: d.ingredient_codes.join(',') };
            if (d.ingredient && (overwrite || !row.drug.ingredient)) body.ingredient = d.ingredient;
            if (d.usage && (overwrite || !row.drug.usage)) body.usage = d.usage;
            const cat2 = withCat2 ? matchCat2(picked.product_type) : null;
            if (cat2 && cat2.id !== row.drug.cat2) body.cat2 = cat2.id;
            await apiFetch(`/manage/drugs/${row.drug.id}/`, { method: 'PATCH', body: JSON.stringify(body) });
            done += 1;
        } catch (err) {
            failed.push(`${row.drug.name}(${err.message})`);
        }
    }
    isBusy = false;
    bulkRunning = false;
    loadDrugTree();
    loadDrugs();
    if (failed.length > 0) {
        byId('bulk-progress').textContent = `${done}개를 채웠습니다.`;
        byId('bulk-error').textContent = `실패 ${failed.length}개: ${failed.join(', ')}`;
        return;
    }
    closeModal();
    showToast(`식약처 정보로 ${done}개를 채웠습니다. 복합제는 성분 분량을, 긴 용법은 현장용으로 다듬어 주세요.`);
}

byId('drug-mfds-bulk-btn').addEventListener('click', openBulkModal);

function onLookupClick(e) {
    const btn = e.target.closest('[data-lookup]');
    if (!btn) return;
    const action = btn.dataset.lookup;
    if (action === 'search') searchDrugInfo();
    else if (action === 'pick') pickDrugInfo(Number(btn.dataset.index));
    else if (action === 'back') renderLookupResults();
    else if (action === 'all') applyLookup(['ingredient', 'usage', 'cat2']);
    else applyLookup([action]);
}

// ----- 약품 엑셀 내려받기 / 올리기 -----
// 내려받은 파일(표준 양식)을 고쳐서 올리거나, 옛 '약품 리스트' 엑셀을 그대로 올린다.
// 올리면 먼저 미리보기(DB 그대로) → [가져오기]. 오류가 하나라도 있으면 가져오기를 막는다.

byId('drug-export-btn').addEventListener('click', async () => {
    const btn = byId('drug-export-btn');
    btn.disabled = true;
    btn.textContent = '만드는 중…';
    try {
        await apiDownload('/manage/drugs/export/', `drugs_${todayStr()}.xlsx`);
    } catch (err) {
        showToast(err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = '엑셀 내려받기';
    }
});

let importFile = null;      // 고른 엑셀 파일 - 미리보기 뒤 [가져오기]에서 같은 파일을 다시 보낸다
let importMfds = false;     // 식약처에서 빈 성분·용법 채우기를 골랐는지 - [가져오기]에서도 같게

async function openImportModal() {
    importFile = null;
    importMfds = false;
    await ensureDrugInfoStatus();
    openModal({
        title: '약품 엑셀 올리기',
        bodyHtml: `
            <p class="modal-note">[엑셀 내려받기]로 받은 파일이나 약품 리스트 엑셀(.xlsx)을 고르세요.
                먼저 미리보기가 나오고, 확인한 뒤 가져옵니다.</p>
            <label class="field-label" for="im-file">엑셀 파일 *</label>
            <input class="field-input" type="file" id="im-file" accept=".xlsx">
            ${drugInfoEnabled ? `
                <div class="toggle-row">
                    <label class="toggle"><input type="checkbox" id="im-mfds">
                        <span>식약처에서 비어 있는 성분·용법 채우기</span></label>
                </div>
                <p class="modal-note">인터넷이 필요하고, 약이 많으면 1~2분 걸립니다. 이름이 딱 맞는 품목만 채우고,
                    후보가 여럿인 약은 [식약처에서 한꺼번에 찾기]에서 고르세요. 약품명·세부 분류는 바꾸지 않습니다.</p>` : ''}
            <p class="error-message" id="im-error"></p>`,
        confirmLabel: '미리보기',
        onConfirm: () => { previewImport(); return false; },
    });
}

function importResultHtml(result) {
    const summary = result.summary.length === 0
        ? '<p class="modal-note">바뀌는 것이 없습니다. (이미 다 들어 있는 파일)</p>'
        : `<ul class="import-summary">${result.summary.map(([label, count]) =>
            `<li><span>${escapeHtml(label)}</span><strong>${count}</strong></li>`).join('')}</ul>`;
    const errors = result.errors.length === 0 ? '' : `
        <p class="error-message">오류 ${result.errors.length}개 - 고친 뒤 다시 올려 주세요. 하나라도 있으면 아무것도 들어가지 않습니다.</p>
        <ul class="import-lines is-error">${result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
    const lines = result.lines.length === 0 ? '' : `
        <details class="import-details"${result.errors.length === 0 && result.lines.length <= 30 ? ' open' : ''}>
            <summary>자세히 (${result.lines.length}줄)</summary>
            <ul class="import-lines">${result.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
        </details>`;
    const format = result.format === 'legacy' ? '<p class="modal-note">약품 리스트 양식으로 읽었습니다.</p>' : '';
    return format + summary + errors + lines;
}

async function previewImport() {
    if (isBusy) return;
    const errorEl = byId('im-error');
    const file = byId('im-file').files[0];
    if (!file) { errorEl.textContent = '엑셀 파일을 골라주세요.'; return; }

    importMfds = Boolean(byId('im-mfds') && byId('im-mfds').checked);
    const form = new FormData();
    form.append('file', file);
    if (importMfds) form.append('mfds', '1');
    isBusy = true;
    errorEl.textContent = importMfds ? '읽고 식약처에서 찾는 중… (1~2분 걸릴 수 있어요)' : '읽는 중…';
    let result;
    try {
        result = await apiUpload('/manage/drugs/import/', form);
    } catch (err) {
        errorEl.textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    importFile = file;
    const canImport = result.errors.length === 0 && result.summary.length > 0;
    openModal({
        title: `미리보기 · ${file.name}`,
        bodyHtml: `${importResultHtml(result)}
            <p class="modal-note">아직 아무것도 바뀌지 않았습니다.${canImport ? ' [가져오기]를 누르면 들어갑니다.' : ''}</p>
            <p class="error-message" id="im-error"></p>`,
        confirmLabel: canImport ? '가져오기' : '닫기',
        onConfirm: () => {
            if (!canImport) return true;
            commitImport();
            return false;
        },
        wide: true,
    });
}

async function commitImport() {
    if (isBusy || !importFile) return;
    const form = new FormData();
    form.append('file', importFile);
    form.append('commit', '1');
    if (importMfds) form.append('mfds', '1');   // 미리보기에서 찾은 결과는 서버가 10분 기억해서 다시 오래 걸리지 않는다
    isBusy = true;
    let result;
    try {
        result = await apiUpload('/manage/drugs/import/', form);
    } catch (err) {
        byId('im-error').textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    importFile = null;
    showToast(`가져왔습니다: ${result.summary.map(([label, count]) => `${label} ${count}`).join(', ')}`);
    loadDrugTree();
    loadDrugs();    // 창고 재고 탭은 열 때마다 새로 받으므로 따로 할 것 없음
}

byId('drug-import-btn').addEventListener('click', openImportModal);
byId('drug-search').addEventListener('input', () => {
    clearTimeout(drugSearchTimer);
    drugSearchTimer = setTimeout(loadDrugs, 300);   // 글자마다 요청하지 않게 잠깐 기다린다
});
byId('drug-filter-cat1').addEventListener('change', () => {
    renderDrugFilters();    // 세부 분류 선택지를 그 분류 것만으로 (고른 세부 분류가 없으면 전체로)
    loadDrugs();
});
byId('drug-filter-cat2').addEventListener('change', loadDrugs);

TAB_LOADERS.drugs = async () => {
    try {
        await loadCategories();
    } catch (err) {
        byId('cat1-list').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
    await loadDrugTree();   // 필터 선택지를 먼저 채우고 약품을 불러온다
    loadDrugs();
};


// =====================================================
// 공용 - 잔량 보정 모달 · 보정 이력 모달 (창고 배치, 미션 재고)
// =====================================================

// 실제로 세어 본 수량으로 덮어쓴다. 사유는 필수이고 이력에 남는다.
function openAdjustModal({ title, name, current, path, onDone }) {
    openModal({
        title,
        bodyHtml: `
            <p class="modal-note">${escapeHtml(name)}</p>
            <p class="adjust-current">지금 잔량 <strong>${current}</strong></p>
            <label class="field-label" for="adj-qty">실제로 센 잔량 *</label>
            <input class="field-input" type="number" id="adj-qty" min="0" inputmode="numeric" value="${current}">
            <label class="field-label" for="adj-reason">사유 *</label>
            <input class="field-input" type="text" id="adj-reason" maxlength="200" placeholder="예: 파손 2개, 실사 결과">
            <p class="error-message" id="adj-error"></p>`,
        confirmLabel: '보정하기',
        onConfirm: () => { saveAdjustment(current, path, onDone); return false; },
    });
    byId('adj-qty').select();
}

async function saveAdjustment(current, path, onDone) {
    if (isBusy) return;
    const errorEl = byId('adj-error');
    const raw = byId('adj-qty').value.trim();
    const qty = Number(raw);
    const reason = byId('adj-reason').value.trim();
    if (raw === '' || !Number.isInteger(qty) || qty < 0) { errorEl.textContent = '0 이상의 정수를 입력해주세요.'; return; }
    if (qty === current) { errorEl.textContent = '지금 잔량과 같습니다. 바꿀 수량을 입력해주세요.'; return; }
    if (!reason) { errorEl.textContent = '사유를 입력해주세요.'; return; }

    isBusy = true;
    try {
        await apiFetch(path, { method: 'POST', body: JSON.stringify({ remaining_qty: qty, reason }) });
    } catch (err) {
        errorEl.textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    showToast(`잔량을 ${current} → ${qty}(으)로 보정했습니다.`);
    onDone();
}

// query: 'drugbatch=3' 또는 'mission_stock=7'
async function openHistoryModal(name, query) {
    let bodyHtml;
    try {
        const data = await apiFetch(`/manage/stock-adjustments/?${query}&page_size=200`);
        bodyHtml = data.results.length === 0
            ? '<p class="modal-note">아직 보정한 기록이 없습니다.</p>'
            : `<ul class="history-list">${data.results.map((h) => `
                   <li>
                       <span class="history-change">${h.before_qty} → ${h.after_qty}</span> · ${escapeHtml(h.reason)}
                       <span class="history-meta">${dateTimeLabel(h.adjusted_at)} · ${escapeHtml(h.adjusted_by_name || '알 수 없음')}</span>
                   </li>`).join('')}
               </ul>`;
    } catch (err) {
        bodyHtml = `<p class="error-message">${escapeHtml(err.message)}</p>`;
    }
    openModal({
        title: '보정 이력',
        bodyHtml: `<p class="modal-note">${escapeHtml(name)}</p>${bodyHtml}`,
        confirmLabel: '닫기',
        onConfirm: () => {},
        hideCancel: true,
    });
}


// =====================================================
// 공용 - 재고 표 (창고 재고·미션 재고): 위에 분류 칩, 아래에 세부 분류로 나눈 표
// =====================================================

const BATCH_CAT_KEY = 'admin_batch_cat';    // 창고 재고에서 고른 분류 칩 (localStorage)
const MS_CAT_KEY = 'admin_ms_cat';          // 미션 재고에서 고른 분류 칩 (localStorage)
const SHOW_INGREDIENT_KEY = 'admin_show_ingredient';   // [성분 보기] 켰는지 - 창고·미션 재고 공용 (localStorage)

function loadSaved(key) {
    return localStorage.getItem(key) || '';
}

// 칩 묶음 이름 - '약속처방 - OS'처럼 ' - '가 있으면 앞부분('약속처방')으로 묶는다
function catGroup(cat1Name) {
    return cat1Name.split(' - ')[0].trim();
}

function compareKo(a, b) {
    return String(a).localeCompare(String(b), 'ko');
}

// [전체 86] [경구 58] [외용 13] ... - rows는 다른 필터(검색·출처 등)를 거친 줄, 숫자도 그 기준
function catChipsHtml(rows, selected) {
    const counts = new Map();
    rows.forEach((r) => {
        const group = catGroup(r.cat1_name);
        counts.set(group, (counts.get(group) || 0) + 1);
    });
    // 고른 분류가 필터에 걸려 0개여도 칩은 남겨 둔다 (어디를 보고 있는지 알 수 있게)
    if (selected && !counts.has(selected)) counts.set(selected, 0);
    const chip = (value, label, count) => `
        <button type="button" class="cat-chip${value === selected ? ' active' : ''}" data-cat="${escapeHtml(value)}"
                aria-pressed="${value === selected}">
            ${escapeHtml(label)}<span class="cat-chip-count">${count}</span>
        </button>`;
    return chip('', '전체', rows.length)
        + [...counts].sort((a, b) => compareKo(a[0], b[0])).map(([group, count]) => chip(group, group, count)).join('');
}

// [성분 보기] - 켜면 약품명 아래에 성분을 작게 보여준다. 두 탭의 스위치가 같은 값을 쓴다
let showIngredient = loadSaved(SHOW_INGREDIENT_KEY) === '1';

function stockNameCellHtml(name, ingredient) {
    const detail = showIngredient && ingredient
        ? `<span class="stock-ingredient">${escapeHtml(ingredient)}</span>`
        : '';
    return `<td class="stock-name"><span class="stock-name-main">${escapeHtml(name)}</span>${detail}</td>`;
}

document.querySelectorAll('.show-ingredient').forEach((box) => {
    box.checked = showIngredient;
    box.addEventListener('change', () => {
        showIngredient = box.checked;
        localStorage.setItem(SHOW_INGREDIENT_KEY, showIngredient ? '1' : '');
        document.querySelectorAll('.show-ingredient').forEach((other) => { other.checked = showIngredient; });
        renderBatches();
        renderMissionStocks();
    });
});

// 유통기한 칸 - 임시 날짜는 '미확인', 지났으면 '지남' 표시 (기기 날짜 기준)
function expiryCellHtml(date) {
    if (date === PLACEHOLDER_EXPIRY) {
        return '<span class="expiry-tag is-unknown" title="임시 날짜 2099-12-31 - [수정]으로 실제 날짜를 넣으세요">미확인</span>';
    }
    const expired = date < todayStr() ? ' <span class="expiry-tag is-past">지남</span>' : '';
    return `<span class="nowrap">${escapeHtml(date)}</span>${expired}`;
}

// 세부 분류(전체 칩이면 '분류 › 세부 분류') 머리줄을 끼운 표. 같은 묶음 안은 약품명 → 유통기한 순
function stockTableHtml({ head, columns, rows, showCat1, rowHtml }) {
    const groupOf = (r) => (showCat1 ? `${r.cat1_name} › ${r.cat2_name}` : r.cat2_name);
    const sorted = [...rows].sort((a, b) => compareKo(a.cat1_name, b.cat1_name)
        || compareKo(a.cat2_name, b.cat2_name)
        || compareKo(a.drug_name, b.drug_name)
        || compareKo(a.expiry_date, b.expiry_date)
        || a.id - b.id);
    const counts = new Map();
    sorted.forEach((r) => counts.set(groupOf(r), (counts.get(groupOf(r)) || 0) + 1));

    let body = '';
    let current = null;
    sorted.forEach((r) => {
        const group = groupOf(r);
        if (group !== current) {
            current = group;
            body += `<tr class="stock-group-row"><th colspan="${columns}" scope="colgroup">
                         ${escapeHtml(group)} <span class="stock-group-count">${counts.get(group)}</span></th></tr>`;
        }
        body += rowHtml(r);
    });
    return `
        <div class="table-scroll">
            <table class="stats-table stock-table">
                <thead><tr>${head}</tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>`;
}


// =====================================================
// 5. 창고 재고 탭 - 입고 배치 (미션과 상관없는 창고 전체)
// =====================================================

const SOURCE_OPTIONS = [
    ['donation', '후원'], ['local', '현지'], ['purchase', '구매'], ['local_purchase', '현지구매'], ['etc', '기타'],
];

let batchList = [];             // 지금 검색어의 창고 배치 (출처·잔량·분류 필터는 화면에서)
let allDrugs = [];              // 입고 모달의 약품 선택지 (분류별로 묶음)
let batchRequestSeq = 0;
let batchSearchTimer = null;
let batchCat = loadSaved(BATCH_CAT_KEY);    // 고른 분류 칩 ('' = 전체)

// 창고 배치 한 줄 - 약품명 | 유통기한 | 출처 | 포장 | 창고 잔량 / 입고량 | 버튼
function batchRowHtml(b) {
    const source = b.source_detail ? `${b.source_display} (${b.source_detail})` : b.source_display;
    return `
        <tr data-id="${b.id}"${b.remaining_qty === 0 ? ' class="is-empty"' : ''}>
            ${stockNameCellHtml(b.drug_name, b.ingredient)}
            <td class="expiry-cell">
                <button type="button" class="expiry-edit" data-action="expiry" title="눌러서 유통기한 고치기">
                    ${expiryCellHtml(b.expiry_date)}
                </button>
            </td>
            <td>${escapeHtml(source)}</td>
            <td class="stock-muted">${b.unit_qty}${escapeHtml(b.unit_label)}</td>
            <td class="stats-qty stock-qty">${b.remaining_qty} <small>/ ${b.total_qty}</small></td>
            <td class="stock-actions">
                <button type="button" class="btn-secondary btn-small" data-action="edit">수정</button>
                <button type="button" class="btn-secondary btn-small" data-action="adjust">잔량 보정</button>
                <button type="button" class="row-link" data-action="history">이력</button>
                <button type="button" class="row-delete" data-action="delete">삭제</button>
            </td>
        </tr>`;
}

function renderBatches() {
    const source = byId('batch-filter-source').value;
    const stock = byId('batch-filter-stock').value;
    const filtered = batchList.filter((b) => (!source || b.source === source)
        && (stock !== 'left' || b.remaining_qty > 0)
        && (stock !== 'empty' || b.remaining_qty === 0)
        && (stock !== 'unknown' || b.expiry_date === PLACEHOLDER_EXPIRY));
    const rows = filtered.filter((b) => !batchCat || catGroup(b.cat1_name) === batchCat);

    byId('batch-cats').innerHTML = catChipsHtml(filtered, batchCat);
    byId('batch-count').textContent = `${rows.length}개`;
    byId('batch-list').innerHTML = rows.length === 0
        ? emptyRowHtml(batchList.length === 0 && !byId('batch-search').value.trim()
            ? '입고한 배치가 없습니다. [입고 추가]로 등록하세요.'
            : '조건에 맞는 배치가 없습니다.')
        : stockTableHtml({
            head: '<th>약품명</th><th>유통기한</th><th>출처</th><th>포장</th><th class="stats-qty">창고 / 입고</th><th></th>',
            columns: 6,
            rows,
            showCat1: !batchCat,
            rowHtml: batchRowHtml,
        });
}

async function loadBatches() {
    const seq = ++batchRequestSeq;
    const params = new URLSearchParams({ page_size: '500' });
    const search = byId('batch-search').value.trim();
    if (search) params.set('search', search);
    try {
        const data = await apiFetch(`/manage/drug-batches/?${params}`);
        if (seq !== batchRequestSeq) return;
        batchList = data.results;
        renderBatches();
    } catch (err) {
        if (seq !== batchRequestSeq) return;
        byId('batch-list').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
}

// 약품 선택지 - 분류별 <optgroup>
function drugOptionsHtml(selectedId) {
    const groups = new Map();
    allDrugs.forEach((d) => {
        if (!groups.has(d.cat1_name)) groups.set(d.cat1_name, []);
        groups.get(d.cat1_name).push(d);
    });
    return '<option value="">약품 선택</option>' + [...groups].map(([cat, drugs]) => `
        <optgroup label="${escapeHtml(cat)}">
            ${drugs.map((d) => `<option value="${d.id}"${d.id === selectedId ? ' selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
        </optgroup>`).join('');
}

async function openBatchModal(batch = null) {
    try {
        allDrugs = (await apiFetch('/manage/drugs/?page_size=500')).results;
    } catch (err) {
        showToast(err.message, true);
        return;
    }
    if (allDrugs.length === 0) {
        showToast('약품 탭에서 약품을 먼저 등록해주세요.', true);
        return;
    }
    const v = (field, fallback = '') => escapeHtml(batch ? batch[field] : fallback);
    const sourceOptions = SOURCE_OPTIONS.map(([value, label]) =>
        `<option value="${value}"${(batch ? batch.source : 'donation') === value ? ' selected' : ''}>${label}</option>`).join('');
    const totalNote = batch
        ? '<p class="modal-note">입고량을 바꾸면 창고 잔량도 같은 만큼 바뀝니다. 세어 본 수량이 다른 거라면 [잔량 보정]을 쓰세요.</p>'
        : '';

    openModal({
        title: batch ? '입고 배치 수정' : '입고 추가',
        bodyHtml: `
            <label class="field-label" for="bm-drug">약품 *</label>
            <select class="field-input" id="bm-drug">${drugOptionsHtml(batch ? batch.drug : null)}</select>
            <div class="form-grid">
                <div>
                    <label class="field-label" for="bm-source">출처 *</label>
                    <select class="field-input" id="bm-source">${sourceOptions}</select>
                </div>
                <div>
                    <label class="field-label" for="bm-source-detail">출처 상세</label>
                    <input class="field-input" type="text" id="bm-source-detail" maxlength="100" placeholder="예: OO교회" value="${v('source_detail')}">
                </div>
                <div>
                    <label class="field-label" for="bm-received">입고일 *</label>
                    <input class="field-input" type="date" id="bm-received" value="${v('received_date', todayStr())}">
                </div>
                <div>
                    <label class="field-label" for="bm-expiry">유통기한 *</label>
                    <input class="field-input" type="date" id="bm-expiry" value="${v('expiry_date')}">
                </div>
                <div>
                    <label class="field-label" for="bm-unit-qty">포장 단위 수량 *</label>
                    <input class="field-input" type="number" id="bm-unit-qty" min="1" inputmode="numeric" value="${v('unit_qty', '1')}">
                </div>
                <div>
                    <label class="field-label" for="bm-unit-label">단위 *</label>
                    <input class="field-input" type="text" id="bm-unit-label" maxlength="20" placeholder="정, 병, 튜브" value="${v('unit_label', '정')}">
                </div>
            </div>
            <label class="field-label" for="bm-total">입고량 *</label>
            <input class="field-input" type="number" id="bm-total" min="0" inputmode="numeric" value="${v('total_qty')}">
            ${totalNote}
            <p class="error-message" id="bm-error"></p>`,
        confirmLabel: batch ? '저장' : '입고',
        onConfirm: () => { saveBatch(batch); return false; },
    });
}

async function saveBatch(batch) {
    if (isBusy) return;
    const errorEl = byId('bm-error');
    const int = (id) => {
        const raw = byId(id).value.trim();
        return raw === '' ? NaN : Number(raw);
    };
    const body = {
        drug: Number(byId('bm-drug').value),
        source: byId('bm-source').value,
        source_detail: byId('bm-source-detail').value.trim(),
        received_date: byId('bm-received').value,
        expiry_date: byId('bm-expiry').value,
        unit_qty: int('bm-unit-qty'),
        unit_label: byId('bm-unit-label').value.trim(),
        total_qty: int('bm-total'),
    };
    if (!body.drug) { errorEl.textContent = '약품을 골라주세요.'; return; }
    if (!body.received_date || !body.expiry_date) { errorEl.textContent = '입고일과 유통기한을 입력해주세요.'; return; }
    if (!Number.isInteger(body.unit_qty) || body.unit_qty < 1 || !body.unit_label) {
        errorEl.textContent = '포장 단위 수량(1 이상)과 단위를 입력해주세요.';
        return;
    }
    if (!Number.isInteger(body.total_qty) || body.total_qty < 0) { errorEl.textContent = '입고량은 0 이상의 정수로 입력해주세요.'; return; }

    isBusy = true;
    try {
        await apiFetch(batch ? `/manage/drug-batches/${batch.id}/` : '/manage/drug-batches/', {
            method: batch ? 'PATCH' : 'POST',
            body: JSON.stringify(body),
        });
    } catch (err) {
        errorEl.textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    showToast(batch ? '저장했습니다.' : '입고를 등록했습니다.');
    loadBatches();
}

byId('batch-cats').addEventListener('click', (e) => {
    const chip = e.target.closest('.cat-chip');
    if (!chip) return;
    batchCat = chip.dataset.cat;
    localStorage.setItem(BATCH_CAT_KEY, batchCat);
    renderBatches();
});

byId('batch-list').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    // 버튼 안의 글자(예: '미확인' 태그)를 눌러도 버튼으로 본다
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!row || !action) return;
    const b = batchList.find((x) => x.id === Number(row.dataset.id));
    if (!b) return;
    const name = `${b.drug_name} · 유통기한 ${b.expiry_date} · ${b.source_display}`;
    if (action === 'expiry') openExpiryEditor(row, b);
    if (action === 'edit') openBatchModal(b);
    if (action === 'adjust') {
        openAdjustModal({
            title: '창고 잔량 보정', name, current: b.remaining_qty,
            path: `/manage/drug-batches/${b.id}/adjust/`, onDone: loadBatches,
        });
    }
    if (action === 'history') openHistoryModal(name, `drugbatch=${b.id}`);
    if (action === 'delete') {
        confirmDelete({ title: '입고 배치 삭제', name, path: `/manage/drug-batches/${b.id}/`, onDone: loadBatches });
    }
});

// ----- 유통기한 표에서 바로 고치기 -----
// 칸을 누르면 날짜 입력칸. Enter = 저장하고 다음 줄로, 다른 곳 누르기 = 저장, Esc = 취소.
// '유통기한 미확인만'을 켜고 Enter로 이어 가면 임시 날짜(import_drugs)를 차례로 채울 수 있다.

function openExpiryEditor(row, b) {
    const cell = row.querySelector('.expiry-cell');
    cell.innerHTML = `<input type="date" class="field-input expiry-input" aria-label="${escapeHtml(b.drug_name)} 유통기한"
                             value="${b.expiry_date === PLACEHOLDER_EXPIRY ? '' : escapeHtml(b.expiry_date)}">`;
    const input = cell.querySelector('input');
    let finished = false;   // Enter 뒤에 blur가 또 오므로 한 번만 처리

    const finish = (save, moveNext) => {
        if (finished) return;
        finished = true;
        if (save && input.value && input.value !== b.expiry_date) {
            saveExpiry(b, input.value, moveNext);
        } else {
            renderBatches();
            if (moveNext) openNextExpiry(b.id);
        }
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false, false); }
    });
    input.addEventListener('blur', () => finish(true, false));
    input.focus();
}

// 지금 보이는 표에서 id 다음 줄의 유통기한을 연다 (저장한 줄이 필터로 빠졌으면 그 자리의 다음 줄)
function openNextExpiry(afterId, orderBefore = null) {
    const order = orderBefore || [...byId('batch-list').querySelectorAll('tr[data-id]')].map((tr) => Number(tr.dataset.id));
    const index = order.indexOf(afterId);
    const visible = new Set([...byId('batch-list').querySelectorAll('tr[data-id]')].map((tr) => Number(tr.dataset.id)));
    const nextId = order.slice(index + 1).find((id) => visible.has(id));
    if (nextId === undefined) return;
    const row = byId('batch-list').querySelector(`tr[data-id="${nextId}"]`);
    const b = batchList.find((x) => x.id === nextId);
    if (row && b) openExpiryEditor(row, b);
}

async function saveExpiry(b, date, moveNext) {
    if (isBusy) {
        showToast('앞의 저장이 끝나지 않았습니다. 잠시 후 다시 입력해주세요.', true);
        renderBatches();
        return;
    }
    // 저장하면 표를 다시 그리므로, 다음 줄을 찾으려고 지금 순서를 먼저 기억한다
    const orderBefore = [...byId('batch-list').querySelectorAll('tr[data-id]')].map((tr) => Number(tr.dataset.id));
    isBusy = true;
    let updated;
    try {
        updated = await apiFetch(`/manage/drug-batches/${b.id}/`, { method: 'PATCH', body: JSON.stringify({ expiry_date: date }) });
    } catch (err) {
        showToast(err.message, true);
        renderBatches();
        return;
    } finally {
        isBusy = false;
    }
    batchList = batchList.map((x) => (x.id === b.id ? { ...x, ...updated } : x));
    renderBatches();
    showToast(`${b.drug_name} 유통기한 ${date}`);
    if (moveNext) openNextExpiry(b.id, orderBefore);
}

byId('batch-add-btn').addEventListener('click', () => openBatchModal());
byId('batch-search').addEventListener('input', () => {
    clearTimeout(batchSearchTimer);
    batchSearchTimer = setTimeout(loadBatches, 300);
});
byId('batch-filter-source').addEventListener('change', renderBatches);
byId('batch-filter-stock').addEventListener('change', renderBatches);

TAB_LOADERS.warehouse = loadBatches;


// =====================================================
// 6. 미션 재고 탭 - 고른 미션에 배분된 배치 (검색·필터는 화면에서)
// =====================================================

let msList = [];                // 고른 미션의 미션 재고 (서버 응답 그대로)
let msRequestSeq = 0;
let msCat = loadSaved(MS_CAT_KEY);  // 고른 분류 칩 ('' = 전체)

// 0 이상의 정수 입력값 (비었거나 이상하면 NaN)
function readCount(id) {
    const raw = byId(id).value.trim();
    const n = Number(raw);
    return raw !== '' && Number.isInteger(n) && n >= 0 ? n : NaN;
}

function msLabel(s) {
    return `${s.drug_name} · 유통기한 ${s.expiry_date} · ${s.source_display}`;
}

// 진행 중인 미션을 정산하면 약국이 그 배치를 더 못 쓴다 - 모달에 경고
function activeMissionWarning() {
    return currentMission && currentMission.is_active
        ? '<p class="error-message">아직 진행 중인 미션입니다. 정산한 배치는 약국에서 더 조제할 수 없어요.</p>'
        : '';
}

// 미션 재고 한 줄 - 약품명 | 유통기한 | 출처 | 사용 | 현장 잔량 / 배분량 | 버튼 (정산했으면 정산 내용 + [이력])
function msRowHtml(s) {
    const actions = s.is_settled
        ? `<span class="doctor-tag">정산 · 기부 ${s.donated_qty} · 반환 ${s.remaining_qty - s.donated_qty}</span>
           <button type="button" class="row-link" data-action="history">이력</button>`
        : `<button type="button" class="btn-secondary btn-small" data-action="allocate">배분량 수정</button>
           <button type="button" class="btn-secondary btn-small" data-action="adjust">잔량 보정</button>
           <button type="button" class="btn-secondary btn-small" data-action="settle">정산</button>
           <button type="button" class="row-link" data-action="history">이력</button>
           <button type="button" class="row-delete" data-action="delete">삭제</button>`;
    const state = s.is_settled ? ' class="is-settled"' : (s.remaining_qty === 0 ? ' class="is-empty"' : '');
    return `
        <tr data-id="${s.id}"${state}>
            ${stockNameCellHtml(s.drug_name, s.ingredient)}
            <td>${expiryCellHtml(s.expiry_date)}</td>
            <td>${escapeHtml(s.source_display)}</td>
            <td class="stats-qty stock-muted">${s.used_qty} <small>(${Math.round(s.consumption_rate * 100)}%)</small></td>
            <td class="stats-qty stock-qty">${s.remaining_qty} <small>/ ${s.allocated_qty}</small></td>
            <td class="stock-actions">${actions}</td>
        </tr>`;
}

function renderMissionStocks() {
    const keyword = byId('ms-search').value.trim().toLowerCase();
    const status = byId('ms-filter-status').value;
    const filtered = msList.filter((s) => (!keyword
            || s.drug_name.toLowerCase().includes(keyword)
            || (s.ingredient || '').toLowerCase().includes(keyword))
        && (!status || (status === 'settled') === s.is_settled));
    const rows = filtered.filter((s) => !msCat || catGroup(s.cat1_name) === msCat);

    const open = msList.filter((s) => !s.is_settled).length;
    byId('ms-summary').textContent =
        `배치 ${msList.length}개 · 정산 전 ${open}개 · 정산 완료 ${msList.length - open}개`;
    byId('ms-settle-bulk-btn').disabled = open === 0;
    byId('ms-cats').innerHTML = msList.length === 0 ? '' : catChipsHtml(filtered, msCat);
    byId('ms-list').innerHTML = rows.length === 0
        ? emptyRowHtml(msList.length === 0
            ? '이 미션에 배분된 재고가 없습니다. [배분 추가]로 창고에서 챙겨 갈 배치를 고르세요.'
            : '조건에 맞는 재고가 없습니다.')
        : stockTableHtml({
            head: '<th>약품명</th><th>유통기한</th><th>출처</th><th class="stats-qty">사용</th>'
                + '<th class="stats-qty">현장 / 배분</th><th></th>',
            columns: 6,
            rows,
            showCat1: !msCat,
            rowHtml: msRowHtml,
        });
}

async function loadMissionStocks(mission) {
    const seq = ++msRequestSeq;
    try {
        const data = await apiFetch(`/manage/mission-stocks/?mission=${mission.id}&page_size=500`);
        if (seq !== msRequestSeq) return;
        msList = data.results;
        renderMissionStocks();
    } catch (err) {
        if (seq !== msRequestSeq) return;
        byId('ms-list').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
}

function reloadMissionStocks() {
    if (currentMission) loadMissionStocks(currentMission);
}

// ----- 배분 추가 -----

async function openAllocateModal() {
    if (!currentMission) return;
    let batches;
    try {
        batches = (await apiFetch('/manage/drug-batches/?page_size=500')).results;
    } catch (err) {
        showToast(err.message, true);
        return;
    }
    // 창고에 남아 있고, 이 미션에 아직 배분하지 않은 배치만
    const taken = new Set(msList.map((s) => s.drugbatch));
    const choices = batches.filter((b) => b.remaining_qty > 0 && !taken.has(b.id));
    if (choices.length === 0) {
        showToast('배분할 수 있는 창고 배치가 없습니다. 창고 재고 탭에서 입고를 먼저 등록하세요.', true);
        return;
    }
    const options = choices.map((b) => `
        <option value="${b.id}" data-left="${b.remaining_qty}">
            ${escapeHtml(`${b.drug_name} · 유통기한 ${b.expiry_date} · ${b.source_display} · 창고 ${b.remaining_qty}`)}
        </option>`).join('');

    openModal({
        title: '배분 추가',
        bodyHtml: `
            <p class="modal-note">${escapeHtml(currentMission.country)} · ${missionPeriodLabel(currentMission)} 미션에 챙겨 갈 배치를 고르세요.
                배분한 만큼 창고에서 빠집니다.</p>
            <label class="field-label" for="al-batch">창고 배치 *</label>
            <select class="field-input" id="al-batch"><option value="">배치 선택</option>${options}</select>
            <label class="field-label" for="al-qty">배분량 *</label>
            <input class="field-input" type="number" id="al-qty" min="1" inputmode="numeric">
            <p class="modal-note" id="al-left"></p>
            <p class="error-message" id="al-error"></p>`,
        confirmLabel: '배분',
        onConfirm: () => { saveAllocation(); return false; },
        wide: true,
    });
    byId('al-batch').addEventListener('change', () => {
        const opt = byId('al-batch').selectedOptions[0];
        byId('al-left').textContent = opt && opt.dataset.left ? `창고 잔량 ${opt.dataset.left}` : '';
    });
}

async function saveAllocation() {
    if (isBusy || !currentMission) return;
    const errorEl = byId('al-error');
    const opt = byId('al-batch').selectedOptions[0];
    const qty = readCount('al-qty');
    if (!opt || !opt.value) { errorEl.textContent = '창고 배치를 골라주세요.'; return; }
    if (!(qty >= 1)) { errorEl.textContent = '배분량은 1 이상의 정수로 입력해주세요.'; return; }
    if (qty > Number(opt.dataset.left)) { errorEl.textContent = `창고 잔량(${opt.dataset.left})보다 많이 배분할 수 없습니다.`; return; }

    isBusy = true;
    try {
        await apiFetch('/manage/mission-stocks/', {
            method: 'POST',
            body: JSON.stringify({ drugbatch: Number(opt.value), mission: currentMission.id, allocated_qty: qty }),
        });
    } catch (err) {
        errorEl.textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    showToast(`${qty}만큼 배분했습니다.`);
    reloadMissionStocks();
}

// ----- 배분량 수정 -----

function openAllocationEditModal(s) {
    openModal({
        title: '배분량 수정',
        bodyHtml: `
            <p class="modal-note">${escapeHtml(msLabel(s))}</p>
            <p class="adjust-current">지금 배분량 <strong>${s.allocated_qty}</strong> · 현장 잔량 ${s.remaining_qty}</p>
            <label class="field-label" for="ae-qty">새 배분량 *</label>
            <input class="field-input" type="number" id="ae-qty" min="1" inputmode="numeric" value="${s.allocated_qty}">
            <p class="modal-note">늘리면 그만큼 창고에서 더 빠지고, 줄이면 현장 잔량에서 창고로 돌려줍니다.
                이미 쓴 양은 돌려줄 수 없어서 최대 ${s.remaining_qty}만큼 줄일 수 있어요.</p>
            <p class="error-message" id="ae-error"></p>`,
        confirmLabel: '저장',
        onConfirm: () => { saveAllocationEdit(s); return false; },
    });
    byId('ae-qty').select();
}

async function saveAllocationEdit(s) {
    if (isBusy) return;
    const errorEl = byId('ae-error');
    const qty = readCount('ae-qty');
    if (!(qty >= 1)) { errorEl.textContent = '배분량은 1 이상의 정수로 입력해주세요.'; return; }
    if (qty === s.allocated_qty) { errorEl.textContent = '지금 배분량과 같습니다.'; return; }
    if (s.allocated_qty - qty > s.remaining_qty) { errorEl.textContent = `현장 잔량(${s.remaining_qty})보다 많이 줄일 수 없습니다.`; return; }

    isBusy = true;
    try {
        await apiFetch(`/manage/mission-stocks/${s.id}/`, { method: 'PATCH', body: JSON.stringify({ allocated_qty: qty }) });
    } catch (err) {
        errorEl.textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    showToast(`배분량을 ${s.allocated_qty} → ${qty}(으)로 바꿨습니다.`);
    reloadMissionStocks();
}

// ----- 정산 (한 줄) -----

function openSettleModal(s) {
    openModal({
        title: '정산',
        bodyHtml: `
            <p class="modal-note">${escapeHtml(msLabel(s))}</p>
            ${activeMissionWarning()}
            <p class="adjust-current">현장 잔량 <strong>${s.remaining_qty}</strong></p>
            <label class="field-label" for="st-donated">현지에 기부한 양</label>
            <input class="field-input" type="number" id="st-donated" min="0" inputmode="numeric" value="0">
            <p class="modal-note" id="st-return">창고로 돌아갈 양 ${s.remaining_qty}</p>
            <p class="error-message" id="st-error"></p>`,
        confirmLabel: '정산하기',
        onConfirm: () => { saveSettle(s); return false; },
    });
    byId('st-donated').addEventListener('input', () => {
        const donated = readCount('st-donated');
        byId('st-return').textContent = Number.isNaN(donated) ? '' : `창고로 돌아갈 양 ${s.remaining_qty - donated}`;
    });
    byId('st-donated').select();
}

async function saveSettle(s) {
    if (isBusy) return;
    const errorEl = byId('st-error');
    const donated = readCount('st-donated');
    if (Number.isNaN(donated)) { errorEl.textContent = '기부량은 0 이상의 정수로 입력해주세요.'; return; }
    if (donated > s.remaining_qty) { errorEl.textContent = `현장 잔량(${s.remaining_qty})보다 많이 기부할 수 없습니다.`; return; }

    isBusy = true;
    let result;
    try {
        result = await apiFetch(`/manage/mission-stocks/${s.id}/settle/`, {
            method: 'POST', body: JSON.stringify({ donated_qty: donated }),
        });
    } catch (err) {
        errorEl.textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    showToast(`정산했습니다. 창고로 ${result.returned_qty} 돌려줬습니다.`);
    reloadMissionStocks();
}

// ----- 한꺼번에 정산 -----

function openBulkSettleModal() {
    const open = msList.filter((s) => !s.is_settled);
    if (open.length === 0) return;
    openModal({
        title: '한꺼번에 정산',
        bodyHtml: `
            <p class="modal-note">정산 전인 배치 ${open.length}개입니다. 현지에 기부한 양만 적으세요 (비워 두면 0).
                나머지는 창고로 돌아갑니다. 하나라도 틀리면 아무것도 정산되지 않아요.</p>
            ${activeMissionWarning()}
            <div class="table-scroll">
                <table class="stats-table bulk-settle-table">
                    <thead><tr><th>약</th><th>유통기한</th><th class="stats-qty">현장 잔량</th><th class="stats-qty">기부량</th></tr></thead>
                    <tbody>${open.map((s) => `
                        <tr>
                            <td>${escapeHtml(s.drug_name)}</td>
                            <td>${escapeHtml(s.expiry_date)}</td>
                            <td class="stats-qty">${s.remaining_qty}</td>
                            <td class="stats-qty"><input class="field-input bulk-donated" type="number" min="0" max="${s.remaining_qty}"
                                inputmode="numeric" placeholder="0" data-id="${s.id}"${s.remaining_qty === 0 ? ' disabled' : ''}
                                aria-label="${escapeHtml(s.drug_name)} 기부량"></td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <p class="error-message" id="bs-error"></p>`,
        confirmLabel: `정산하기 (${open.length}개)`,
        onConfirm: () => { saveBulkSettle(open); return false; },
        wide: true,
    });
}

async function saveBulkSettle(open) {
    if (isBusy) return;
    const errorEl = byId('bs-error');
    const items = [];
    for (const input of document.querySelectorAll('.bulk-donated')) {
        const s = open.find((x) => x.id === Number(input.dataset.id));
        const raw = input.value.trim();
        const donated = raw === '' ? 0 : Number(raw);
        if (!Number.isInteger(donated) || donated < 0 || donated > s.remaining_qty) {
            errorEl.textContent = `${s.drug_name}: 기부량은 0 ~ ${s.remaining_qty} 사이의 정수로 입력해주세요.`;
            input.focus();
            return;
        }
        items.push({ id: s.id, donated_qty: donated });
    }

    isBusy = true;
    let result;
    try {
        result = await apiFetch('/manage/mission-stocks/settle-bulk/', { method: 'POST', body: JSON.stringify({ items }) });
    } catch (err) {
        errorEl.textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    closeModal();
    showToast(`${result.settled}개를 정산했습니다. 창고로 ${result.returned_qty} 돌려줬습니다.`);
    reloadMissionStocks();
}

// ----- 줄 버튼 -----

byId('ms-cats').addEventListener('click', (e) => {
    const chip = e.target.closest('.cat-chip');
    if (!chip) return;
    msCat = chip.dataset.cat;
    localStorage.setItem(MS_CAT_KEY, msCat);
    renderMissionStocks();
});

byId('ms-list').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    const action = e.target.dataset.action;
    if (!row || !action) return;
    const s = msList.find((x) => x.id === Number(row.dataset.id));
    if (!s) return;
    if (action === 'allocate') openAllocationEditModal(s);
    if (action === 'adjust') {
        openAdjustModal({
            title: '현장 잔량 보정', name: msLabel(s), current: s.remaining_qty,
            path: `/manage/mission-stocks/${s.id}/adjust/`, onDone: reloadMissionStocks,
        });
    }
    if (action === 'settle') openSettleModal(s);
    if (action === 'history') openHistoryModal(msLabel(s), `mission_stock=${s.id}`);
    if (action === 'delete') {
        confirmDelete({
            title: '배분 삭제', name: msLabel(s), path: `/manage/mission-stocks/${s.id}/`, onDone: reloadMissionStocks,
        });
    }
});

byId('ms-add-btn').addEventListener('click', openAllocateModal);
byId('ms-settle-bulk-btn').addEventListener('click', openBulkSettleModal);
byId('ms-search').addEventListener('input', renderMissionStocks);
byId('ms-filter-status').addEventListener('change', renderMissionStocks);

TAB_LOADERS['mission-stock'] = loadMissionStocks;


// =====================================================
// 7. 설정 탭 - 현장 시간대
//    서버 기준 오늘·지금 시각과 이 기기 시계를 같이 보여줘 설정 실수를 바로 알아보게 한다.
// =====================================================

const TZ_CHOICES = [
    ['Asia/Seoul', '한국'],
    ['Asia/Phnom_Penh', '캄보디아'],
    ['Indian/Antananarivo', '마다가스카르'],
    ['Asia/Bangkok', '태국'],
    ['Asia/Ulaanbaatar', '몽골'],
];
const TZ_CUSTOM = 'custom';         // 선택지 밖의 시간대는 이름을 직접 입력
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

let siteConfig = null;              // 서버 응답 그대로

function tzLabel(name) {
    const choice = TZ_CHOICES.find(([value]) => value === name);
    return choice ? `${choice[1]} (${name})` : name;
}

// '+0700' → 'UTC+7', '+0530' → 'UTC+5:30'
function offsetLabel(offset) {
    const sign = offset[0];
    const hours = Number(offset.slice(1, 3));
    const minutes = offset.slice(3, 5);
    return `UTC${sign}${hours}${minutes === '00' ? '' : `:${minutes}`}`;
}

// 이 기기 시계를 서버(현장 시간대) 벽시계와 비교 - 차이(분), 기기 시각 글자
function compareDeviceClock(serverWall) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const deviceWall = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    // 둘 다 '시간대 없는 벽시계 시각'이라 같은 기준(Z)으로 읽어 빼면 된다
    const diffMinutes = Math.round((Date.parse(`${deviceWall}Z`) - Date.parse(`${serverWall}Z`)) / 60000);
    return { diffMinutes, label: `${deviceWall.slice(0, 10)} ${deviceWall.slice(11, 16)}` };
}

function renderSiteClock() {
    const c = siteConfig;
    const weekday = WEEKDAYS[new Date(`${c.server_today}T00:00:00Z`).getUTCDay()];
    const device = compareDeviceClock(c.server_wall);
    const same = Math.abs(device.diffMinutes) <= 2;
    const deviceNote = same
        ? '서버와 같음'
        : `서버와 ${Math.abs(device.diffMinutes) >= 60
            ? `${Math.round(Math.abs(device.diffMinutes) / 6) / 10}시간`
            : `${Math.abs(device.diffMinutes)}분`} 차이 - 이 기기의 날짜·시간대 설정을 확인하세요`;

    byId('tz-clock').innerHTML = `
        <div class="tz-clock-main">
            <span class="tz-clock-label">서버 기준 오늘</span>
            <span class="tz-clock-date">${escapeHtml(c.server_today)} <small>(${weekday})</small></span>
            <span class="tz-clock-time">${escapeHtml(c.server_time)}</span>
        </div>
        <dl class="tz-clock-rows">
            <div><dt>시간대</dt><dd>${escapeHtml(tzLabel(c.time_zone))} · ${offsetLabel(c.utc_offset)}${c.is_default ? ' <span class="doctor-tag waiting">기본값</span>' : ''}</dd></div>
            <div class="${same ? 'is-ok' : 'is-warn'}"><dt>이 기기 시각</dt><dd>${escapeHtml(device.label)} · ${escapeHtml(deviceNote)}</dd></div>
        </dl>`;

    byId('tz-updated').textContent = c.updated_at
        ? `마지막 변경: ${c.updated_by_name || '알 수 없음'} · ${c.updated_at}`
        : '아직 관리자 화면에서 고른 적이 없어 서버 기본 설정(local_settings.py)을 쓰고 있습니다.';
}

function renderTzSelect() {
    const current = siteConfig.time_zone;
    const known = TZ_CHOICES.some(([value]) => value === current);
    byId('tz-select').innerHTML = TZ_CHOICES.map(([value, label]) =>
        `<option value="${value}"${value === current ? ' selected' : ''}>${label} (${value})</option>`).join('')
        + `<option value="${TZ_CUSTOM}"${known ? '' : ' selected'}>기타 (직접 입력)</option>`;
    byId('tz-custom').value = known ? '' : current;
    byId('tz-custom-wrap').hidden = known;
}

async function loadSiteConfig() {
    byId('tz-error').textContent = '';
    try {
        siteConfig = await apiFetch('/manage/site-config/');
    } catch (err) {
        byId('tz-clock').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
        return;
    }
    renderSiteClock();
    renderTzSelect();
}

function chosenTimeZone() {
    const value = byId('tz-select').value;
    return value === TZ_CUSTOM ? byId('tz-custom').value.trim() : value;
}

function openTimeZoneConfirm() {
    if (!siteConfig || isBusy) return;
    const errorEl = byId('tz-error');
    errorEl.textContent = '';
    const name = chosenTimeZone();
    if (!name) { errorEl.textContent = '시간대 이름을 입력해주세요. (예: Asia/Phnom_Penh)'; return; }
    if (name === siteConfig.time_zone && !siteConfig.is_default) { errorEl.textContent = '지금 시간대와 같습니다.'; return; }

    const activeWarning = missions.some((m) => m.is_active)
        ? `<p class="error-message">진행 중인 미션이 있습니다. '오늘' 기준이 바뀌어 접수·진료·약국 목록이 달라질 수 있어요.
               현장 시간대가 정말 틀렸을 때만 바꾸세요.</p>`
        : '';
    openModal({
        title: '시간대 변경',
        bodyHtml: `
            <p class="adjust-current">${escapeHtml(tzLabel(siteConfig.time_zone))} → <strong>${escapeHtml(tzLabel(name))}</strong></p>
            <p class="modal-note">저장하면 모든 기기에 바로 적용됩니다. 이미 저장된 기록의 시각은 바뀌지 않아요.</p>
            ${activeWarning}`,
        confirmLabel: '바꾸기',
        onConfirm: () => { saveTimeZone(name); },
    });
}

async function saveTimeZone(name) {
    if (isBusy) return;
    isBusy = true;
    try {
        siteConfig = await apiFetch('/manage/site-config/', { method: 'PATCH', body: JSON.stringify({ time_zone: name }) });
    } catch (err) {
        byId('tz-error').textContent = err.message;
        return;
    } finally {
        isBusy = false;
    }
    showToast(`시간대를 ${tzLabel(name)}(으)로 바꿨습니다.`);
    renderSiteClock();
    renderTzSelect();
    // '진행중' 미션도 새 '오늘' 기준으로 다시 받는다
    try {
        await loadMissions();
    } catch (err) {
        showToast(err.message, true);
    }
}

byId('tz-select').addEventListener('change', () => {
    const custom = byId('tz-select').value === TZ_CUSTOM;
    byId('tz-custom-wrap').hidden = !custom;
    if (custom) byId('tz-custom').focus();
});
byId('tz-save-btn').addEventListener('click', openTimeZoneConfirm);

TAB_LOADERS.settings = loadSiteConfig;


// =====================================================
// 시작
// =====================================================

(async () => {
    try {
        await loadMissions();
    } catch (err) {
        byId('mission-chips').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
    showTab(localStorage.getItem(TAB_KEY));
})();
