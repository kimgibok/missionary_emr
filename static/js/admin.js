// =====================================================
// 관리자 페이지
//   1. 미션 선택 (진행중 미션 먼저) - 통계·미션 재고 탭에서만 보인다
//   2. 탭 (통계 | 미션 재고 | 창고 재고 | 약품 | 설정)
//   3. 통계 탭 - 요약, 진료과별 환자 수, 약 분류별·진료과별 사용량, 다음 미션 준비표, 엑셀 다운로드
//   4. 약품 탭 - 약품·분류·세부 분류 추가·수정·삭제, 검색
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

    // 약품 필터 선택지 (고른 값은 유지)
    byId('drug-filter-cat1').innerHTML = optionsHtml(cat1List, byId('drug-filter-cat1').value, '분류 전체');
    byId('drug-filter-cat2').innerHTML = optionsHtml(cat2List, byId('drug-filter-cat2').value, '세부 분류 전체');
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
    });
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
        confirmDelete({ title: '약품 삭제', name: drug.name, path: `/manage/drugs/${drug.id}/`, onDone: loadDrugs });
    }
});

byId('drug-add-btn').addEventListener('click', () => openDrugModal());
byId('drug-search').addEventListener('input', () => {
    clearTimeout(drugSearchTimer);
    drugSearchTimer = setTimeout(loadDrugs, 300);   // 글자마다 요청하지 않게 잠깐 기다린다
});
byId('drug-filter-cat1').addEventListener('change', loadDrugs);
byId('drug-filter-cat2').addEventListener('change', loadDrugs);

TAB_LOADERS.drugs = async () => {
    try {
        await loadCategories();
    } catch (err) {
        byId('cat1-list').innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
    loadDrugs();
};


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
