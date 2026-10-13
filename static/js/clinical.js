// =====================================================
// 진료팀 페이지 - 배정 목록 / 진료 상세 / 처방 작성
// =====================================================

const byId = (id) => document.getElementById(id);

let assignList = null;
let assignSignature = '';
let currentAssignment = null;
let isDirty = false;
let isBusy = false;

const REFRESH_MS = 10000;
const clinicalPanel = byId('clinical-panel');

// ----- 도우미 -----
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sexLabel(sex) { return sex === 'F' ? '여' : '남'; }

function calcAge(visitDate, birthYear) {
    return Number(visitDate.slice(0, 4)) - birthYear;
}

function patientMeta(visit) {
    const p = visit.patient;
    const parts = [sexLabel(p.sex), `${p.birth_year}년생 (${calcAge(visit.visit_date, p.birth_year)}세)`];
    if (p.name_local) parts.push(p.name_local);
    return parts.join(' · ');
}

let toastTimer = null;
function showToast(message, isError = false) {
    const el = byId('toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ----- 배정 목록 -----
function renderAssignList() {
    byId('assign-count').textContent = `${assignList.count}명`;
    const el = byId('assign-list');

    if (assignList.results.length === 0) {
        el.innerHTML = '<p class="empty-text">배정된 환자가 없습니다.</p>';
        placePanel();
        return;
    }

    el.innerHTML = assignList.results.map(a => {
        const selected = currentAssignment && currentAssignment.id === a.id ? ' selected' : '';
        return `
            <button type="button" class="queue-item${selected}" data-assignment-id="${a.id}">
                <span class="queue-item-no ticket-number">${a.visit.reg_no}</span>
                <span class="queue-item-main">
                    <span class="queue-item-name">${escapeHtml(a.visit.patient.name_kr)}</span>
                    <span class="queue-item-meta">${escapeHtml(patientMeta(a.visit))}</span>
                </span>
                <span class="doctor-tag${a.is_done ? '' : ' waiting'}">${a.is_done ? '완료' : '대기'}</span>
            </button>`;
    }).join('');

    placePanel();
}

function placePanel() {
    if (!currentAssignment) {
        byId('panel-dock').appendChild(clinicalPanel);
        clinicalPanel.hidden = true;
        return;
    }
    const item = document.querySelector(`.queue-item[data-assignment-id="${currentAssignment.id}"]`);
    if (item) {
        item.after(clinicalPanel);
    } else {
        byId('panel-dock').appendChild(clinicalPanel);
    }
    clinicalPanel.hidden = false;
}

function panelHasFocus() {
    return Boolean(currentAssignment) && clinicalPanel.contains(document.activeElement);
}

let renderPending = false;
function renderAssignListSafely() {
    if (panelHasFocus()) {
        renderPending = true;
        return;
    }
    renderPending = false;
    renderAssignList();
}

clinicalPanel.addEventListener('focusout', () => {
    setTimeout(() => {
        if (renderPending && !panelHasFocus()) {
            renderPending = false;
            renderAssignList();
        }
    }, 0);
});

async function loadAssignList() {
    const data = await apiFetch('/visit-departments/?is_done=false');
    const doneData = await apiFetch('/visit-departments/?is_done=true');
    const merged = { count: data.count + doneData.count, results: [...data.results, ...doneData.results] };

    const signature = JSON.stringify(merged);
    if (signature === assignSignature) return;
    assignSignature = signature;
    assignList = merged;
    renderAssignListSafely();
}

async function refreshAll(force = false) {
    if (isBusy) return;
    if (document.hidden && !force) return;
    try {
        await loadAssignList();
    } catch (err) {
        console.error(err);
        if (force) showToast(err.message, true);
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll(true);
});
setInterval(() => refreshAll(), REFRESH_MS);
refreshAll(true);

// ----- 진료 상세: 폼 값 넣기/읽기 -----
function setVal(id, value) { byId(id).value = value ?? ''; }
function setChk(id, value) { byId(id).checked = Boolean(value); }
function getChk(id) { return byId(id).checked; }
function getText(id) { return byId(id).value.trim(); }
function getNum(id, parse) {
    const raw = byId(id).value.trim();
    return raw === '' ? null : parse(raw);
}

function fillHeader(a) {
    byId('cl-reg-no').textContent = a.visit.reg_no;
    byId('cl-name').textContent = a.visit.patient.name_kr;
    byId('cl-meta').textContent = patientMeta(a.visit);
}

function updatePregVisibility() {
    const isFemale = currentAssignment && currentAssignment.visit.patient.sex === 'F';
    byId('cl-preg-row').hidden = !isFemale;
    if (!isFemale) byId('cl-is_preg').checked = false;
}

function updateDetailVisibility() {
    byId('cl-allergy-field').hidden = !getChk('cl-has_allergy');
    byId('cl-operation-field').hidden = !getChk('cl-has_operation');
}

function fillVitalsForm(v) {
    setVal('cl-bp', v.bp);
    setVal('cl-pr', v.pr);
    setVal('cl-bt', v.bt);
    setVal('cl-bst', v.bst);
    setChk('cl-is_preg', v.is_preg);
    ['has_htn', 'has_dm', 'has_tbc', 'has_hepatitis', 'has_allergy', 'has_operation']
        .forEach((id) => setChk(`cl-${id}`, v[id]));
    setVal('cl-allergy_detail', v.allergy_detail);
    setVal('cl-operation_detail', v.operation_detail);
    setVal('cl-history_etc', v.history_etc);
    setVal('cl-chief_complaint', v.chief_complaint);
    setVal('cl-symptom_duration', v.symptom_duration);
    updatePregVisibility();
    updateDetailVisibility();
}

function readVitalsPayload() {
    const isFemale = currentAssignment.visit.patient.sex === 'F';
    const hasAllergy = getChk('cl-has_allergy');
    const hasOperation = getChk('cl-has_operation');
    return {
        bp: getText('cl-bp'),
        pr: getNum('cl-pr', (s) => parseInt(s, 10)),
        bt: getNum('cl-bt', parseFloat),
        bst: getNum('cl-bst', parseFloat),
        is_preg: isFemale && getChk('cl-is_preg'),
        has_htn: getChk('cl-has_htn'),
        has_dm: getChk('cl-has_dm'),
        has_tbc: getChk('cl-has_tbc'),
        has_hepatitis: getChk('cl-has_hepatitis'),
        has_allergy: hasAllergy,
        allergy_detail: hasAllergy ? getText('cl-allergy_detail') : '',
        has_operation: hasOperation,
        operation_detail: hasOperation ? getText('cl-operation_detail') : '',
        history_etc: getText('cl-history_etc'),
        chief_complaint: getText('cl-chief_complaint'),
        symptom_duration: getText('cl-symptom_duration'),
    };
}

// ----- 다른 배정 현황 -----
function renderOtherAssignments(a) {
    const others = a.visit.assignments.filter((x) => x.id !== a.id);
    byId('cl-other-assignments').innerHTML = others.map((x) => `
        <span class="doctor-tag${x.is_done ? '' : ' waiting'}">
            ${x.department_code ? escapeHtml(x.department_code) + ' · ' : ''}${escapeHtml(x.doctor_name)} · ${x.is_done ? '진료 완료' : '대기중'}
        </span>`).join('');
}

// ----- 이미 쓴 처방 (조회 + 수정/삭제) -----
let rxList = [];        // 서버에서 받은 이 배정의 처방 목록
let editingRx = null;   // 편집 중인 처방 { id, items } - 한 번에 하나만

function rxViewHtml(p) {
    const side = p.is_dispensed
        ? '<span class="doctor-tag">수령 완료</span>'
        : '<button type="button" class="btn-secondary btn-small" data-action="edit-rx">수정</button>';
    return `
        <div class="prescription-card" data-rx-id="${p.id}">
            <div class="prescription-card-head">
                <span class="prescription-card-dept">${escapeHtml(p.department_name)}</span>
                ${side}
            </div>
            ${p.clinical_note ? `<div class="prescription-card-note">${escapeHtml(p.clinical_note)}</div>` : ''}
            <div class="prescription-card-items">
                ${p.items.length === 0
                    ? '<span class="prescription-drug-chip">처방약 없음</span>'
                    : p.items.map((i) => `<span class="prescription-drug-chip">${escapeHtml(i.drug_name)} × ${i.quantity}</span>`).join('')}
            </div>
        </div>`;
}

function rxEditHtml(p) {
    const departmentOptions = departments
        .map((d) => `<option value="${d.id}"${d.id === p.department ? ' selected' : ''}>${escapeHtml(d.name)}</option>`)
        .join('');
    return `
        <div class="prescription-card editing" data-rx-id="${p.id}">
            <label class="field-label" for="rx-edit-department">진료과 *</label>
            <select class="field-input" id="rx-edit-department">${departmentOptions}</select>
            <label class="field-label" for="rx-edit-note">진료내용</label>
            <textarea class="field-input" id="rx-edit-note" rows="2" maxlength="2000">${escapeHtml(p.clinical_note)}</textarea>
            <div class="rx-cart" id="rx-edit-items"></div>
            <p class="error-message" id="rx-edit-error"></p>
            <div class="rx-edit-actions">
                <button type="button" class="rx-cart-remove" data-action="delete-rx">처방 삭제</button>
                <div class="rx-edit-actions-right">
                    <button type="button" class="btn-secondary btn-small" data-action="cancel-edit">취소</button>
                    <button type="button" class="btn-primary btn-inline" data-action="save-edit">저장</button>
                </div>
            </div>
        </div>`;
}

function renderPrescriptions() {
    const el = byId('cl-prescriptions');
    if (rxList.length === 0) {
        el.innerHTML = '<p class="empty-text">아직 작성된 처방이 없습니다.</p>';
        return;
    }
    el.innerHTML = rxList
        .map((p) => (editingRx && editingRx.id === p.id ? rxEditHtml(p) : rxViewHtml(p)))
        .join('');
    if (editingRx) renderEditItems();
}

function renderEditItems() {
    const visible = editingRx.items.filter((x) => !x.removed);
    byId('rx-edit-items').innerHTML = visible.length === 0
        ? '<p class="empty-text">처방약 없음 (약 없이 저장됩니다)</p>'
        : visible.map(cartItemHtml).join('');
}

async function loadPrescriptions(visitDepartmentId) {
    const data = await apiFetch(`/prescriptions/?visit_department=${visitDepartmentId}`);
    rxList = data.results;
    renderPrescriptions();
}

// 서버 처방약 → 장바구니와 같은 모양의 편집용 항목
function toEditItem(i) {
    const hasSchedule = i.dose_per_intake && i.frequency_per_day && i.duration_days;
    const item = {
        key: i.id,
        id: i.id,
        drug_id: i.drug,
        drug_name: i.drug_name,
        uses_dosage_schedule: i.uses_dosage_schedule,
        dose_per_intake: i.dose_per_intake ?? '',
        frequency_per_day: i.frequency_per_day ?? '',
        duration_days: i.duration_days ?? '',
        quantity: i.quantity ?? '',
        manualQty: i.uses_dosage_schedule && !hasSchedule,  // 스케줄 분류인데 수량으로 저장했던 경우
        removed: false,
    };
    item.original = JSON.stringify(buildPrescriptionDrugPayload(item));  // 바뀐 것만 PATCH하려고 비교용
    return item;
}

function startEditRx(id) {
    const p = rxList.find((x) => x.id === id);
    if (!p) return;
    editingRx = { id, items: p.items.map(toEditItem) };
    renderPrescriptions();
}

function cancelEditRx() {
    editingRx = null;
    renderPrescriptions();
}

async function saveRxEdit() {
    if (!editingRx || isBusy) return;

    const errorEl = byId('rx-edit-error');
    errorEl.textContent = '';

    const departmentId = Number(byId('rx-edit-department').value);
    if (!departmentId) {
        errorEl.textContent = '진료과를 선택해주세요.';
        return;
    }
    const itemError = validateItems(editingRx.items.filter((x) => !x.removed));
    if (itemError) {
        errorEl.textContent = itemError;
        return;
    }

    const original = rxList.find((p) => p.id === editingRx.id);
    const note = byId('rx-edit-note').value.trim();

    isBusy = true;
    try {
        // 1) 처방 머리(진료과·진료내용) - 실패하면 약은 건드리지 않고 편집 상태 유지
        if (departmentId !== original.department || note !== original.clinical_note) {
            await apiFetch(`/prescriptions/${editingRx.id}/`, {
                method: 'PATCH',
                body: JSON.stringify({ department: departmentId, clinical_note: note }),
            });
        }
    } catch (err) {
        errorEl.textContent = err.message;
        isBusy = false;
        return;
    }

    // 2) 처방약 - 뺀 약은 삭제, 바뀐 약만 수정
    const failures = [];
    for (const item of editingRx.items) {
        try {
            if (item.removed) {
                await apiFetch(`/prescription-drugs/${item.id}/clinical/`, { method: 'DELETE' });
                continue;
            }
            const payload = buildPrescriptionDrugPayload(item);
            if (JSON.stringify(payload) !== item.original) {
                await apiFetch(`/prescription-drugs/${item.id}/clinical/`, {
                    method: 'PATCH',
                    body: JSON.stringify(payload),
                });
            }
        } catch (err) {
            failures.push(`${item.drug_name}(${err.message})`);
        }
    }
    isBusy = false;

    editingRx = null;
    if (failures.length > 0) {
        showToast(`일부 약 수정에 실패했습니다: ${failures.join(', ')}`, true);
    } else {
        isDirty = false;
        showToast('처방을 수정했습니다.');
    }
    await loadPrescriptions(currentAssignment.id);
}

function confirmDeleteRx() {
    if (!editingRx) return;
    const rxId = editingRx.id;
    openModal({
        title: '처방 삭제',
        bodyHtml: '<p>이 처방과 처방약을 모두 삭제합니다. 되돌릴 수 없어요.</p>',
        confirmLabel: '삭제하기',
        onConfirm: () => { deleteRx(rxId); },
    });
}

async function deleteRx(rxId) {
    if (isBusy) return;
    isBusy = true;
    try {
        await apiFetch(`/prescriptions/${rxId}/`, { method: 'DELETE' });
        editingRx = null;
        isDirty = false;
        showToast('처방을 삭제했습니다.');
        await loadPrescriptions(currentAssignment.id);
    } catch (err) {
        showToast(err.message, true);
    } finally {
        isBusy = false;
    }
}

byId('cl-prescriptions').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'edit-rx') {
        startEditRx(Number(btn.closest('.prescription-card').dataset.rxId));
        return;
    }
    if (!editingRx) return;

    if (action === 'cancel-edit') cancelEditRx();
    else if (action === 'save-edit') saveRxEdit();
    else if (action === 'delete-rx') confirmDeleteRx();
    else if (action === 'remove' || action === 'toggle-manual') {
        const item = findCartItem(editingRx.items, btn);
        if (!item) return;
        if (action === 'remove') item.removed = true;
        else item.manualQty = !item.manualQty;
        isDirty = true;
        renderEditItems();
    }
});

byId('cl-prescriptions').addEventListener('input', (e) => {
    if (!editingRx) return;
    isDirty = true;
    applyCartInput(editingRx.items, e);
});

// ----- 열기/닫기 -----
async function openAssignment(id) {
    try {
        const a = await apiFetch(`/visit-departments/${id}/`);
        currentAssignment = a;
        fillHeader(a);
        fillVitalsForm(a.visit);
        renderOtherAssignments(a);
        isDirty = false;
        byId('cl-vitals-error').textContent = '';

        renderAssignList();
        scrollToSelected();
        resetRxForm();
        editingRx = null;
        await loadPrescriptions(id);
    } catch (err) {
        showToast(err.message, true);
    }
}

function scrollToSelected() {
    const item = document.querySelector('.queue-item.selected');
    (item || clinicalPanel).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function requestOpenAssignment(id) {
    if (currentAssignment && currentAssignment.id === id) {
        requestClosePanel();
        return;
    }
    if (currentAssignment && isDirty) {
        openModal({
            title: '작성 중인 내용이 있어요',
            bodyHtml: '<p>다른 환자를 열면 지금 입력한 내용이 사라집니다.</p>',
            confirmLabel: '다른 환자 열기',
            onConfirm: () => { openAssignment(id); },
        });
    } else {
        openAssignment(id);
    }
}

function resetPanel() {
    currentAssignment = null;
    editingRx = null;
    isDirty = false;
    clinicalPanel.hidden = true;
    byId('cl-vitals-error').textContent = '';
    renderAssignList();
}

function requestClosePanel() {
    if (isDirty) {
        openModal({
            title: '작성 중인 내용이 있어요',
            bodyHtml: '<p>지금 닫으면 저장하지 않은 내용이 사라집니다.</p>',
            confirmLabel: '닫기',
            onConfirm: () => { resetPanel(); },
        });
    } else {
        resetPanel();
    }
}

byId('assign-list').addEventListener('click', (e) => {
    const item = e.target.closest('.queue-item');
    if (!item) return;
    requestOpenAssignment(Number(item.dataset.assignmentId));
});

byId('cl-close-btn').addEventListener('click', requestClosePanel);

byId('cl-has_allergy').addEventListener('change', updateDetailVisibility);
byId('cl-has_operation').addEventListener('change', updateDetailVisibility);

['input', 'change'].forEach((eventName) => {
    byId('cl-vitals-form').addEventListener(eventName, () => { isDirty = true; });
});

window.addEventListener('beforeunload', (e) => {
    if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
    }
});

byId('cl-vitals-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentAssignment || isBusy) return;

    const errorEl = byId('cl-vitals-error');
    errorEl.textContent = '';

    const payload = readVitalsPayload();
    if (!payload.chief_complaint) {
        errorEl.textContent = '주호소를 입력해주세요.';
        byId('cl-chief_complaint').focus();
        return;
    }

    isBusy = true;
    try {
        const updated = await apiFetch(`/visits/${currentAssignment.visit.id}/`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });
        currentAssignment.visit = { ...currentAssignment.visit, ...updated };
        isDirty = false;
        showToast('환자 정보를 저장했습니다.');
        fillHeader(currentAssignment);
        refreshAll(true);
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        isBusy = false;
    }
});

// ----- 환자 기본정보 수정 -----
function openPatientEditModal() {
    if (!currentAssignment) return;
    const p = currentAssignment.visit.patient;

    openModal({
        title: '환자 정보 수정',
        bodyHtml: `
            <label class="field-label" for="pe-name-kr">이름(한글)</label>
            <input class="field-input" type="text" id="pe-name-kr" maxlength="50" value="${escapeHtml(p.name_kr)}">
            <label class="field-label" for="pe-name-local">이름(현지어)</label>
            <input class="field-input" type="text" id="pe-name-local" maxlength="100" value="${escapeHtml(p.name_local)}">
            <label class="field-label" for="pe-sex">성별</label>
            <select class="field-input" id="pe-sex">
                <option value="M"${p.sex === 'M' ? ' selected' : ''}>남</option>
                <option value="F"${p.sex === 'F' ? ' selected' : ''}>여</option>
            </select>
            <label class="field-label" for="pe-birth-year">출생연도</label>
            <input class="field-input" type="number" id="pe-birth-year" inputmode="numeric" value="${p.birth_year}">
            <p class="error-message" id="pe-error"></p>`,
        confirmLabel: '수정하기',
        onConfirm: () => { savePatientEdit(); return false; },
    });
}

async function savePatientEdit() {
    if (isBusy || !currentAssignment) return;

    const errorEl = byId('pe-error');
    errorEl.textContent = '';

    const nameKr = byId('pe-name-kr').value.trim();
    const birthYear = parseInt(byId('pe-birth-year').value, 10);
    if (!nameKr) { errorEl.textContent = '이름(한글)을 입력해주세요.'; return; }
    if (!birthYear || birthYear < 1900 || birthYear > new Date().getFullYear()) {
        errorEl.textContent = '출생연도를 확인해주세요.';
        return;
    }

    isBusy = true;
    let updated = null;
    try {
        updated = await apiFetch(`/patients/${currentAssignment.visit.patient.id}/`, {
            method: 'PATCH',
            body: JSON.stringify({
                name_kr: nameKr,
                name_local: byId('pe-name-local').value.trim(),
                sex: byId('pe-sex').value,
                birth_year: birthYear,
            }),
        });
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        isBusy = false;
    }

    if (!updated || !currentAssignment) return;
    currentAssignment.visit.patient = updated;
    closeModal();
    fillHeader(currentAssignment);
    updatePregVisibility();
    showToast('환자 정보를 수정했습니다.');
}

byId('cl-edit-patient-btn').addEventListener('click', openPatientEditModal);

// =====================================================
// 진료과 / 약품 카테고리 / 처방 작성
// =====================================================

let departments = [];
let drugCategory1List = [];
let drugCategory2List = [];
let rxCart = [];

async function loadDepartments() {
    try {
        const data = await apiFetch('/departments/?page_size=100');
        departments = data.results;
        byId('rx-department').innerHTML = departments
            .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
            .join('');
    } catch (err) {
        console.error(err);
    }
}
loadDepartments();

async function loadDrugCategories() {
    try {
        const [cat1, cat2] = await Promise.all([
            apiFetch('/drug-categories1/?page_size=50'),
            apiFetch('/drug-categories2/?page_size=50'),
        ]);
        drugCategory1List = cat1.results;
        drugCategory2List = cat2.results;

        byId('rx-cat1').innerHTML = '<option value="">전체</option>' +
            drugCategory1List.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        byId('rx-cat2').innerHTML = '<option value="">전체</option>' +
            drugCategory2List.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    } catch (err) {
        console.error(err);
    }
}
loadDrugCategories();

function resetRxForm() {
    rxCart = [];
    byId('rx-note').value = '';
    byId('rx-drug-search').value = '';
    byId('rx-cat1').value = '';
    byId('rx-cat2').value = '';
    byId('rx-drug-results').innerHTML = '';
    byId('rx-error').textContent = '';
    renderCart();
}

async function searchDrugs() {
    const resultsEl = byId('rx-drug-results');
    const search = byId('rx-drug-search').value.trim();
    const cat1 = byId('rx-cat1').value;
    const cat2 = byId('rx-cat2').value;

    const params = new URLSearchParams({ page_size: '30' });
    if (search) params.set('search', search);
    if (cat1) params.set('cat1', cat1);
    if (cat2) params.set('cat2', cat2);

    try {
        const data = await apiFetch(`/drugs/?${params.toString()}`);

        if (data.results.length === 0) {
            resultsEl.innerHTML = '<p class="empty-text">검색 결과가 없습니다.</p>';
            return;
        }

        resultsEl.innerHTML = data.results.map((d) => `
            <div class="patient-item">
                <div>
                    <div class="patient-item-name">${escapeHtml(d.drug_name)}</div>
                    <div class="patient-item-meta">${escapeHtml(d.cat1_name)} · ${escapeHtml(d.ingredient || '')} · 잔량 ${d.remaining_qty}</div>
                </div>
                <button class="btn-primary btn-inline" type="button" data-drug-id="${d.drug_id}">담기</button>
            </div>`).join('');

        resultsEl.querySelectorAll('button[data-drug-id]').forEach((btn, i) => {
            btn.addEventListener('click', () => addToCart(data.results[i]));
        });
    } catch (err) {
        resultsEl.innerHTML = `<p class="empty-text" style="color: var(--color-danger);">${escapeHtml(err.message)}</p>`;
    }
}

byId('rx-drug-search-btn').addEventListener('click', searchDrugs);
byId('rx-drug-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchDrugs(); }
});
byId('rx-cat1').addEventListener('change', searchDrugs);
byId('rx-cat2').addEventListener('change', searchDrugs);

function addToCart(d) {
    if (rxCart.some((item) => item.drug_id === d.drug_id)) {
        showToast('이미 담긴 약입니다.', true);
        return;
    }
    rxCart.push({
        key: d.drug_id,
        drug_id: d.drug_id,
        drug_name: d.drug_name,
        uses_dosage_schedule: d.uses_dosage_schedule,
        remaining_qty: d.remaining_qty,
        dose_per_intake: '',
        frequency_per_day: '',
        duration_days: '',
        quantity: '',
        manualQty: false,
    });
    isDirty = true;
    renderCart();
}

function removeFromCart(drugId) {
    rxCart = rxCart.filter((item) => item.drug_id !== drugId);
    renderCart();
}

function cartFieldsHtml(item) {
    const useSchedule = item.uses_dosage_schedule && !item.manualQty;

    if (useSchedule) {
        return `
            <div class="rx-cart-fields">
                <div><label>1회량</label><input class="field-input" type="number" step="0.1" data-field="dose_per_intake" value="${item.dose_per_intake}"></div>
                <div><label>1일 횟수</label><input class="field-input" type="number" data-field="frequency_per_day" value="${item.frequency_per_day}"></div>
                <div><label>일수</label><input class="field-input" type="number" data-field="duration_days" value="${item.duration_days}"></div>
            </div>
            <button type="button" class="rx-cart-remove" data-action="toggle-manual" style="color: var(--color-accent); margin-top: 8px;">수량 직접 입력으로 전환</button>`;
    }

    const toggleBtn = item.uses_dosage_schedule
        ? `<button type="button" class="rx-cart-remove" data-action="toggle-manual" style="color: var(--color-accent); margin-top: 8px;">복용스케줄 입력으로 전환</button>`
        : '';

    return `
        <div class="rx-cart-fields">
            <div><label>수량</label><input class="field-input" type="number" data-field="quantity" value="${item.quantity}"></div>
        </div>
        ${toggleBtn}`;
}

// 약 카드 한 장 - 새 처방 장바구니와 처방 수정 화면이 같이 쓴다 (item.key로 구분)
function cartItemHtml(item) {
    const stock = item.remaining_qty !== undefined
        ? `<div class="rx-cart-item-stock">현장 잔량 ${item.remaining_qty}</div>`
        : '';
    return `
        <div class="rx-cart-item" data-key="${item.key}">
            <div class="rx-cart-item-head">
                <span class="rx-cart-item-name">${escapeHtml(item.drug_name)}</span>
                <button type="button" class="rx-cart-remove" data-action="remove">빼기</button>
            </div>
            ${stock}
            ${cartFieldsHtml(item)}
        </div>`;
}

function findCartItem(items, el) {
    const card = el.closest('.rx-cart-item');
    return card ? items.find((x) => String(x.key) === card.dataset.key) : null;
}

// 1회량/횟수/일수/수량 입력값을 항목에 반영
function applyCartInput(items, e) {
    const field = e.target.dataset.field;
    if (!field) return;
    const item = findCartItem(items, e.target);
    if (item) item[field] = e.target.value;
}

function renderCart() {
    byId('rx-cart').innerHTML = rxCart.map(cartItemHtml).join('');
}

byId('rx-cart').addEventListener('click', (e) => {
    const item = findCartItem(rxCart, e.target);
    if (!item) return;

    if (e.target.dataset.action === 'remove') {
        removeFromCart(item.drug_id);
    } else if (e.target.dataset.action === 'toggle-manual') {
        item.manualQty = !item.manualQty;
        renderCart();
    }
});

byId('rx-cart').addEventListener('input', (e) => {
    applyCartInput(rxCart, e);
    isDirty = true;
});

function buildPrescriptionDrugPayload(item) {
    const useSchedule = item.uses_dosage_schedule && !item.manualQty;
    if (useSchedule) {
        return {
            drug: item.drug_id,
            dose_per_intake: item.dose_per_intake === '' ? null : parseFloat(item.dose_per_intake),
            frequency_per_day: item.frequency_per_day === '' ? null : parseInt(item.frequency_per_day, 10),
            duration_days: item.duration_days === '' ? null : parseInt(item.duration_days, 10),
        };
    }
    // 수량 직접 입력: 세 값을 null로 같이 보내야 서버 save()가 수량을 다시 계산하지 않는다 (수정 시 중요)
    return {
        drug: item.drug_id,
        dose_per_intake: null,
        frequency_per_day: null,
        duration_days: null,
        quantity: item.quantity === '' ? 0 : parseInt(item.quantity, 10),
    };
}

function validateItems(items) {
    for (const item of items) {
        const useSchedule = item.uses_dosage_schedule && !item.manualQty;
        if (useSchedule) {
            if (!item.dose_per_intake || !item.frequency_per_day || !item.duration_days) {
                return `${item.drug_name}: 1회량/1일횟수/일수를 모두 입력해주세요.`;
            }
        } else if (!item.quantity || Number(item.quantity) <= 0) {
            return `${item.drug_name}: 수량을 입력해주세요.`;
        }
    }
    return null;
}

byId('rx-save-btn').addEventListener('click', async () => {
    if (!currentAssignment || isBusy) return;

    const errorEl = byId('rx-error');
    errorEl.textContent = '';

    const departmentId = byId('rx-department').value;
    if (!departmentId) {
        errorEl.textContent = '진료과를 선택해주세요.';
        return;
    }

    const cartError = validateItems(rxCart);
    if (cartError) {
        errorEl.textContent = cartError;
        return;
    }

    isBusy = true;
    const saveBtn = byId('rx-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중…';

    try {
        const prescription = await apiFetch('/prescriptions/', {
            method: 'POST',
            body: JSON.stringify({
                visit_department: currentAssignment.id,
                department: Number(departmentId),
                clinical_note: byId('rx-note').value.trim(),
            }),
        });

        const failedDrugs = [];
        for (const item of rxCart) {
            try {
                await apiFetch('/prescription-drugs/', {
                    method: 'POST',
                    body: JSON.stringify({ prescription: prescription.id, ...buildPrescriptionDrugPayload(item) }),
                });
            } catch (err) {
                failedDrugs.push(item.drug_name);
            }
        }

        if (failedDrugs.length > 0) {
            errorEl.textContent = `처방은 저장됐지만 다음 약 추가에 실패했습니다: ${failedDrugs.join(', ')}`;
        } else {
            isDirty = false;
            showToast('처방을 저장했습니다.');
        }

        resetRxForm();
        await loadPrescriptions(currentAssignment.id);
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        isBusy = false;
        saveBtn.disabled = false;
        saveBtn.textContent = '처방 저장';
    }
});