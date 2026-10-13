// =====================================================
// 진료팀 페이지
//   1. 배정 목록 (진료 대기 / 오늘 진료 완료)
//   2. 진료 상세 열기·닫기, 읽기 전용(완료된 배정)
//   3. 활력징후·병력 / 환자 기본정보 수정
//   4. 다른 의사 배정 현황 · 추가 배정(전과) · 배정 취소
//   5. 진료 완료 / 완료 취소
//   6. 처방약 카드 공용 (새 처방 장바구니 + 처방 수정)
//   7. 작성된 처방 조회·수정·삭제
//   8. 다른 의사 처방 (진료 완료분, 읽기 전용)
//   9. 새 처방 작성
// escapeHtml, patientMeta, doctorLabel, showToast, byId는 common.js
// =====================================================

const REFRESH_MS = 10000;
const clinicalPanel = byId('clinical-panel');

// ----- 상태 -----
let assignList = null;          // { waiting, done } - 서버 응답 그대로
let assignSignature = '';       // 목록이 바뀌었는지 비교용
let renderPending = false;      // 입력 중이라 목록 갱신을 미뤄둔 상태
let currentAssignment = null;   // 지금 열려 있는 배정 상세
let isDirty = false;            // 저장하지 않은 입력이 있는지
let isBusy = false;             // 저장 요청 중이면 자동 새로고침·중복 클릭을 막음

let departments = [];           // 진료과 목록 (새 처방·처방 수정의 선택지)
let rxList = [];                // 내 배정의 처방 목록
let editingRx = null;           // 편집 중인 처방 { id, items } - 한 번에 하나만
let rxCart = [];                // 새 처방 장바구니


// =====================================================
// 1. 배정 목록
// =====================================================

function doneTimeLabel(doneAt) {
    if (!doneAt) return '완료';
    const d = new Date(doneAt);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 완료`;
}

function assignItemHtml(a) {
    const selected = currentAssignment && currentAssignment.id === a.id ? ' selected' : '';
    return `
        <button type="button" class="queue-item${selected}" data-assignment-id="${a.id}">
            <span class="queue-item-no ticket-number">${a.visit.reg_no}</span>
            <span class="queue-item-main">
                <span class="queue-item-name">${escapeHtml(a.visit.patient.name_kr)}</span>
                <span class="queue-item-meta">${escapeHtml(patientMeta(a.visit))}</span>
            </span>
            <span class="doctor-tag${a.is_done ? '' : ' waiting'}">${a.is_done ? doneTimeLabel(a.done_at) : '대기'}</span>
        </button>`;
}

function renderQueue(listId, badgeId, data, emptyText) {
    byId(badgeId).textContent = `${data.count}명`;
    byId(listId).innerHTML = data.results.length === 0
        ? `<p class="empty-text">${emptyText}</p>`
        : data.results.map(assignItemHtml).join('');
}

function renderAssignList() {
    renderQueue('assign-list', 'assign-count', assignList.waiting, '대기 중인 환자가 없습니다.');
    renderQueue('done-assign-list', 'done-assign-count', assignList.done, '아직 진료를 완료한 환자가 없습니다.');
    placePanel();
}

// 상세 패널을 열린 환자 바로 아래에 붙임 (목록에 없으면 #panel-dock으로)
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

// 입력 중(패널에 포커스)이면 목록 다시 그리기를 미룬다
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
    const [waiting, done] = await Promise.all([
        apiFetch('/visit-departments/?is_done=false&page_size=200'),
        apiFetch('/visit-departments/?is_done=true&page_size=200'),   // 서버가 완료 시각 최신순으로 정렬
    ]);
    const merged = { waiting, done };

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

['assign-list', 'done-assign-list'].forEach((listId) => {
    byId(listId).addEventListener('click', (e) => {
        const item = e.target.closest('.queue-item');
        if (!item) return;
        requestOpenAssignment(Number(item.dataset.assignmentId));
    });
});


// =====================================================
// 2. 진료 상세 열기·닫기, 읽기 전용
// =====================================================

async function openAssignment(id) {
    try {
        const a = await apiFetch(`/visit-departments/${id}/`);
        currentAssignment = a;
        fillHeader(a);
        fillVitalsForm(a.visit);
        renderOtherAssignments(a);
        applyReadOnly();
        isDirty = false;
        byId('cl-vitals-error').textContent = '';

        renderAssignList();
        scrollToSelected();
        resetRxForm();
        editingRx = null;
        await Promise.all([loadPrescriptions(id), loadOtherPrescriptions()]);
    } catch (err) {
        showToast(err.message, true);
    }
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

function scrollToSelected() {
    const item = document.querySelector('.queue-item.selected');
    (item || clinicalPanel).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fillHeader(a) {
    byId('cl-reg-no').textContent = a.visit.reg_no;
    byId('cl-name').textContent = a.visit.patient.name_kr;
    byId('cl-meta').textContent = patientMeta(a.visit);
}

// 내 진료가 완료된 배정은 읽기 전용.
// vitals는 다른 의사가 아직 진료 중일 수 있어 서버는 막지 않고 화면에서만 잠근다.
function applyReadOnly() {
    const done = Boolean(currentAssignment && currentAssignment.is_done);
    byId('cl-readonly-notice').hidden = !done;
    byId('cl-vitals-form').querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = done; });
    byId('cl-vitals-submit').hidden = done;
    byId('cl-edit-patient-btn').hidden = done;
    byId('cl-new-rx').hidden = done;
    byId('cl-transfer-btn').hidden = done;
    byId('cl-complete-btn').hidden = done;
    byId('cl-uncomplete-btn').hidden = !done;
}

byId('cl-close-btn').addEventListener('click', requestClosePanel);

window.addEventListener('beforeunload', (e) => {
    if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
    }
});


// =====================================================
// 3. 활력징후·병력 / 환자 기본정보 수정
// =====================================================

function setVal(id, value) { byId(id).value = value ?? ''; }
function setChk(id, value) { byId(id).checked = Boolean(value); }
function getChk(id) { return byId(id).checked; }
function getText(id) { return byId(id).value.trim(); }
function getNum(id, parse) {
    const raw = byId(id).value.trim();
    return raw === '' ? null : parse(raw);
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

byId('cl-has_allergy').addEventListener('change', updateDetailVisibility);
byId('cl-has_operation').addEventListener('change', updateDetailVisibility);

['input', 'change'].forEach((eventName) => {
    byId('cl-vitals-form').addEventListener(eventName, () => { isDirty = true; });
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
// 4. 다른 의사 배정 현황 · 추가 배정(전과) · 배정 취소
// =====================================================

function renderOtherAssignments(a) {
    const me = a.visit.assignments.find((x) => x.id === a.id);
    const others = a.visit.assignments.filter((x) => x.id !== a.id);
    byId('cl-other-assignments').innerHTML = others.map((x) => {
        // 내가 추가한 배정이고 아직 진료 전이면 취소 가능 (처방이 있으면 서버가 거절)
        const canCancel = !a.is_done && !x.is_done && me && x.assigned_by === me.doctor_id;
        const cancelBtn = canCancel
            ? `<button type="button" class="doctor-cancel transfer-cancel" data-assignment-id="${x.id}" data-doctor-name="${escapeHtml(x.doctor_name)}"><span>배정 취소</span></button>`
            : '';
        return `
            <span class="other-assignment">
                <span class="doctor-tag${x.is_done ? '' : ' waiting'}">
                    ${doctorLabel(x.doctor_name, x.department_code)} · ${x.is_done ? '진료 완료' : '대기중'}
                </span>
                ${cancelBtn}
            </span>`;
    }).join('');
}

// 배정 현황만 다시 받아서 갱신 (입력 중인 vitals·처방 폼은 건드리지 않음)
async function refreshOtherAssignments() {
    if (!currentAssignment) return;
    try {
        const a = await apiFetch(`/visit-departments/${currentAssignment.id}/`);
        currentAssignment.visit.assignments = a.visit.assignments;
        renderOtherAssignments(currentAssignment);
        await loadOtherPrescriptions();
    } catch (err) {
        console.error(err);
    }
}

async function openTransferModal() {
    if (!currentAssignment || isBusy) return;

    let doctors;
    try {
        doctors = await apiFetch('/visit-departments/wait-counts/');
    } catch (err) {
        showToast(err.message, true);
        return;
    }

    const assignments = currentAssignment.visit.assignments;
    const myDoctorId = assignments.find((x) => x.id === currentAssignment.id)?.doctor_id;
    const assignedIds = new Set(assignments.map((x) => x.doctor_id));

    // 나와 이미 배정된 의사는 고를 수 없게 회색으로
    const options = doctors.map((d) => {
        if (assignedIds.has(d.doctor_id)) {
            return `
                <div class="doctor-option assigned">
                    <span class="doctor-option-name">${doctorLabel(d.doctor_name, d.department_code)}</span>
                    <span class="doctor-tag waiting">${d.doctor_id === myDoctorId ? '나' : '배정됨'}</span>
                </div>`;
        }
        return `
            <label class="doctor-option">
                <input type="checkbox" data-doctor-id="${d.doctor_id}" data-doctor-name="${escapeHtml(d.doctor_name)}">
                <span class="doctor-option-name">${doctorLabel(d.doctor_name, d.department_code)}</span>
                <span class="doctor-option-wait">${d.waiting_count}명 대기</span>
            </label>`;
    }).join('');

    openModal({
        title: '다른 의사에게 추가 배정',
        bodyHtml: `
            <p class="modal-note">선택한 의사의 대기 목록에 이 환자가 추가됩니다. 내 진료는 따로 [진료 완료]를 눌러 끝내주세요.</p>
            <div class="doctor-picker">${options || '<p class="empty-text">진료팀 의사가 없습니다.</p>'}</div>
            <p class="error-message" id="transfer-error"></p>`,
        confirmLabel: '배정하기',
        onConfirm: () => { saveTransfer(); return false; },
    });
}

async function saveTransfer() {
    if (!currentAssignment || isBusy) return;

    const errorEl = byId('transfer-error');
    errorEl.textContent = '';

    const picked = [...document.querySelectorAll('#modal-body input[data-doctor-id]:checked')]
        .map((input) => ({ id: Number(input.dataset.doctorId), name: input.dataset.doctorName }));
    if (picked.length === 0) {
        errorEl.textContent = '배정할 의사를 선택해주세요.';
        return;
    }

    isBusy = true;
    const done = [];
    const failed = [];
    for (const doctor of picked) {
        try {
            await apiFetch('/visit-departments/', {
                method: 'POST',
                body: JSON.stringify({ visit: currentAssignment.visit.id, user: doctor.id }),
            });
            done.push(doctor.name);
        } catch (err) {
            failed.push(`${doctor.name}(${err.message})`);
        }
    }
    isBusy = false;

    // 전부 실패면 모달을 열어둔 채 이유를 보여준다
    if (done.length === 0) {
        errorEl.textContent = `배정하지 못했습니다: ${failed.join(', ')}`;
        return;
    }

    closeModal();
    if (failed.length > 0) {
        showToast(`${done.join(', ')} 배정 완료 / 실패: ${failed.join(', ')}`, true);
    } else {
        showToast(`${done.join(', ')} 선생님에게 추가 배정했습니다.`);
    }
    await refreshOtherAssignments();
}

function requestCancelTransfer(assignmentId, name) {
    openModal({
        title: '추가 배정 취소',
        bodyHtml: `<p>${escapeHtml(name)} 선생님 배정을 취소할까요? 그 선생님의 대기 목록에서 이 환자가 빠집니다.</p>`,
        confirmLabel: '배정 취소',
        onConfirm: () => { cancelTransfer(assignmentId); },
    });
}

async function cancelTransfer(assignmentId) {
    if (isBusy) return;
    isBusy = true;
    try {
        await apiFetch(`/visit-departments/${assignmentId}/`, { method: 'DELETE' });
        showToast('배정을 취소했습니다.');
    } catch (err) {
        showToast(err.message, true);
    } finally {
        isBusy = false;
    }
    await refreshOtherAssignments();
}

byId('cl-transfer-btn').addEventListener('click', openTransferModal);

byId('cl-other-assignments').addEventListener('click', (e) => {
    const btn = e.target.closest('.doctor-cancel');
    if (!btn) return;
    requestCancelTransfer(Number(btn.dataset.assignmentId), btn.dataset.doctorName);
});


// =====================================================
// 5. 진료 완료 / 완료 취소
// =====================================================

function requestComplete() {
    if (!currentAssignment || currentAssignment.is_done || isBusy) return;

    // 처방이 없으면 약국 대기에 안 나타나므로 서버도 막는다 - 미리 안내
    if (rxList.length === 0) {
        showToast('처방을 하나 이상 저장해야 진료를 완료할 수 있습니다. 약이 없으면 약 없이 처방을 저장해주세요.', true);
        return;
    }

    const othersWaiting = currentAssignment.visit.assignments
        .filter((x) => x.id !== currentAssignment.id && !x.is_done);
    const notes = [
        `<p class="modal-note">작성한 처방 ${rxList.length}건으로 진료를 마칩니다. 완료 후에는 수정할 수 없고, 약국 수령 전까지만 [완료 취소]로 되돌릴 수 있어요.</p>`,
    ];
    if (othersWaiting.length > 0) {
        const names = othersWaiting.map((x) => escapeHtml(x.doctor_name)).join(', ');
        notes.push(`<p class="modal-note">다른 의사(${names}) 진료가 끝나야 약국 대기에 올라갑니다.</p>`);
    }
    if (isDirty || editingRx) {
        notes.push('<p class="error-message">저장하지 않은 입력이 있습니다. 완료하면 사라져요.</p>');
    }

    openModal({
        title: '진료 완료',
        bodyHtml: notes.join(''),
        confirmLabel: '진료 완료',
        onConfirm: () => { completeAssignment(); },
    });
}

async function setAssignmentDone(isDone) {
    if (!currentAssignment || isBusy) return false;
    isBusy = true;
    try {
        await apiFetch(`/visit-departments/${currentAssignment.id}/`, {
            method: 'PATCH',
            body: JSON.stringify({ is_done: isDone }),
        });
        return true;
    } catch (err) {
        showToast(err.message, true);
        return false;
    } finally {
        isBusy = false;
    }
}

async function completeAssignment() {
    const name = currentAssignment.visit.patient.name_kr;
    if (!(await setAssignmentDone(true))) return;
    showToast(`${name} 진료를 완료했습니다.`);
    resetPanel();        // 패널 닫고 목록으로
    refreshAll(true);
}

function requestUncomplete() {
    if (!currentAssignment || !currentAssignment.is_done) return;
    openModal({
        title: '완료 취소',
        bodyHtml: '<p>진료 완료를 취소하고 다시 수정할 수 있게 합니다. 약국 대기에 올라가 있었다면 다시 빠집니다.</p>',
        confirmLabel: '완료 취소',
        onConfirm: () => { uncompleteAssignment(); },
    });
}

async function uncompleteAssignment() {
    const id = currentAssignment.id;
    if (!(await setAssignmentDone(false))) return;
    showToast('완료를 취소했습니다. 다시 수정할 수 있어요.');
    await openAssignment(id);   // 수정 가능한 상태로 다시 열기
    refreshAll(true);
}

byId('cl-complete-btn').addEventListener('click', requestComplete);
byId('cl-uncomplete-btn').addEventListener('click', requestUncomplete);


// =====================================================
// 6. 처방약 카드 공용 - 새 처방 장바구니(rxCart)와 처방 수정(editingRx.items)이 같이 쓴다
//    항목 모양: { key, drug_id, drug_name, uses_dosage_schedule,
//                dose_per_intake, frequency_per_day, duration_days, quantity, manualQty, ... }
// =====================================================

function usesSchedule(item) {
    return item.uses_dosage_schedule && !item.manualQty;
}

function cartFieldsHtml(item) {
    if (usesSchedule(item)) {
        return `
            <div class="rx-cart-fields">
                <div><label>1회량</label><input class="field-input" type="number" step="0.1" data-field="dose_per_intake" value="${item.dose_per_intake}"></div>
                <div><label>1일 횟수</label><input class="field-input" type="number" data-field="frequency_per_day" value="${item.frequency_per_day}"></div>
                <div><label>일수</label><input class="field-input" type="number" data-field="duration_days" value="${item.duration_days}"></div>
            </div>
            <button type="button" class="rx-cart-toggle" data-action="toggle-manual">수량 직접 입력으로 전환</button>`;
    }

    const toggleBtn = item.uses_dosage_schedule
        ? '<button type="button" class="rx-cart-toggle" data-action="toggle-manual">복용스케줄 입력으로 전환</button>'
        : '';

    return `
        <div class="rx-cart-fields">
            <div><label>수량</label><input class="field-input" type="number" data-field="quantity" value="${item.quantity}"></div>
        </div>
        ${toggleBtn}`;
}

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

function buildPrescriptionDrugPayload(item) {
    if (usesSchedule(item)) {
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
        if (usesSchedule(item)) {
            if (!item.dose_per_intake || !item.frequency_per_day || !item.duration_days) {
                return `${item.drug_name}: 1회량/1일횟수/일수를 모두 입력해주세요.`;
            }
        } else if (!item.quantity || Number(item.quantity) <= 0) {
            return `${item.drug_name}: 수량을 입력해주세요.`;
        }
    }
    return null;
}


// =====================================================
// 7. 작성된 처방 (내 배정) 조회·수정·삭제
// =====================================================

// 처방 카드 (조회용). readOnly면 [수정] 버튼 없음 - 다른 의사 처방에도 사용
function rxViewHtml(p, readOnly = false) {
    let side = '';
    if (p.is_dispensed) {
        side = '<span class="doctor-tag">수령 완료</span>';
    } else if (!readOnly && !currentAssignment.is_done) {
        side = '<button type="button" class="btn-secondary btn-small" data-action="edit-rx">수정</button>';
    }
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


// =====================================================
// 8. 다른 의사 처방 (진료 완료분, 읽기 전용) - 같은 약 중복 처방 방지용
// =====================================================

async function loadOtherPrescriptions() {
    if (!currentAssignment) return;
    const others = currentAssignment.visit.assignments.filter((x) => x.id !== currentAssignment.id);
    byId('cl-others-rx-section').hidden = others.length === 0;   // 다른 의사가 없으면 영역 자체를 숨김
    if (others.length === 0) return;

    const el = byId('cl-others-rx');
    try {
        const data = await apiFetch(`/prescriptions/?visit=${currentAssignment.visit.id}&page_size=100`);
        const list = data.results.filter((p) => p.visit_department !== currentAssignment.id);
        if (list.length === 0) {
            el.innerHTML = '<p class="empty-text">아직 진료를 완료한 다른 의사가 없습니다.</p>';
            return;
        }
        // 의사별로 묶어서 "FM · 김의사" 머리말 아래에 처방 카드
        el.innerHTML = others.map((a) => {
            const theirs = list.filter((p) => p.visit_department === a.id);
            if (theirs.length === 0) return '';
            return `
                <div class="others-rx-group">
                    <div class="others-rx-doctor">${doctorLabel(a.doctor_name, a.department_code)}</div>
                    ${theirs.map((p) => rxViewHtml(p, true)).join('')}
                </div>`;
        }).join('');
    } catch (err) {
        el.innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
}

// 배정 현황(완료 여부)도 같이 갱신
byId('cl-others-rx-refresh').addEventListener('click', refreshOtherAssignments);


// =====================================================
// 9. 새 처방 작성 - 진료과·분류 불러오기, 약 검색, 장바구니, 저장
// =====================================================

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

async function loadDrugCategories() {
    const optionsHtml = (list) => '<option value="">전체</option>' +
        list.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    try {
        const [cat1, cat2] = await Promise.all([
            apiFetch('/drug-categories1/?page_size=50'),
            apiFetch('/drug-categories2/?page_size=50'),
        ]);
        byId('rx-cat1').innerHTML = optionsHtml(cat1.results);
        byId('rx-cat2').innerHTML = optionsHtml(cat2.results);
    } catch (err) {
        console.error(err);
    }
}

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
        resultsEl.innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
}

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

function renderCart() {
    byId('rx-cart').innerHTML = rxCart.map(cartItemHtml).join('');
}

async function saveNewPrescription() {
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
}

byId('rx-drug-search-btn').addEventListener('click', searchDrugs);
byId('rx-drug-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchDrugs(); }
});
byId('rx-cat1').addEventListener('change', searchDrugs);
byId('rx-cat2').addEventListener('change', searchDrugs);

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

byId('rx-save-btn').addEventListener('click', saveNewPrescription);


// =====================================================
// 시작
// =====================================================

loadDepartments();
loadDrugCategories();

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll(true);
});
setInterval(() => refreshAll(), REFRESH_MS);
refreshAll(true);
