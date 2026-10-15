// =====================================================
// 관리자 페이지
//   1. 미션 선택 (진행중 미션 먼저) - 통계·미션 재고 탭에서만 보인다
//   2. 탭 (통계 | 미션 재고 | 창고 재고 | 약품 | 설정)
//   3. 통계 탭 - 요약, 진료과별 환자 수, 약 분류별·진료과별 사용량, 다음 미션 준비표, 엑셀 다운로드
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

// 진료과 × (소아/성인 × 성별) 표 + 맨 아래 전체(방문 기준)
function renderVisitStatsTable(visit) {
    if (visit.rows.length === 0) {
        byId('visit-stats-table').innerHTML = emptyRowHtml('아직 진료 완료된 환자가 없습니다.');
        return;
    }
    const table = new Map();   // 진료과 → { '소아M': 3, ... }
    visit.rows.forEach((r) => {
        if (!table.has(r.department)) table.set(r.department, {});
        table.get(r.department)[r.age_group + r.sex] = r.count;
    });
    const cells = (counts) => {
        const values = AGE_SEX_COLUMNS.map(([a, s]) => counts[a + s] || 0);
        const total = values.reduce((sum, n) => sum + n, 0);
        return values.map((n) => `<td class="stats-qty">${n}</td>`).join('') + `<td class="stats-qty">${total}</td>`;
    };
    const totals = {};
    visit.by_age_sex.forEach((x) => { totals[x.age_group + x.sex] = x.count; });

    byId('visit-stats-table').innerHTML = `
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
    } catch (err) {
        if (seq !== statsRequestSeq) return;
        statsData = null;
        byId('admin-stats-summary').innerHTML = '';
        byId('visit-stats-table').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
        ['category-stats-table', 'department-stats', 'prep-table'].forEach((id) => { byId(id).innerHTML = ''; });
    }
}

TAB_LOADERS.stats = loadStats;

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
