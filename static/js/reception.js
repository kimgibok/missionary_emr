// =====================================================
// 접수팀 페이지 - 1부: 상태, 도우미, 목록 불러오기
// =====================================================

// ----- 상태 (2부에서도 같이 씀) -----
let doctors = [];                  // 이번 미션 진료팀 의사 + 각자의 대기 인원
let doctorsSignature = '';         // 의사 목록이 바뀌었는지 비교용
let listData = { waiting: null, done: null };
let listSignature = '';            // 목록이 바뀌었는지 비교용
let currentVisit = null;           // 지금 열려 있는 방문 상세
let pendingDoctorIds = new Set();  // 이번에 새로 배정하려고 체크한 의사
let readOnly = false;              // 배정된 진료가 모두 끝난 방문이면 true
let isDirty = false;               // 입력 중인 내용이 있는지
let isBusy = false;                // 저장/취소 요청 중이면 자동 새로고침을 잠시 멈춤

const REFRESH_MS = 10000;
const intakeCard = document.getElementById('intake-card');
let renderPending = false;         // 입력 중이라 목록 갱신을 미뤄둔 상태

// ----- 도우미 -----
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

function calcAge(visitDate, birthYear) {
    return Number(visitDate.slice(0, 4)) - birthYear;
}

function patientMeta(visit) {
    const p = visit.patient;
    const parts = [
        sexLabel(p.sex),
        `${p.birth_year}년생 (${calcAge(visit.visit_date, p.birth_year)}세)`,
    ];
    if (p.name_local) parts.push(p.name_local);
    return parts.join(' · ');
}

let toastTimer = null;
function showToast(message, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ----- 목록 그리기 -----
function renderQueueItem(visit, showDoctors) {
    const selected = currentVisit && currentVisit.id === visit.id ? ' selected' : '';

    let doctorsHtml = '';
    if (showDoctors) {
                const tags = visit.assignments.length === 0
            ? '<span class="doctor-tag unassigned">의사 미배정</span>'
            : visit.assignments.map(a => `
                <span class="doctor-tag${a.is_done ? '' : ' waiting'}">
                    ${doctorDisplayName(a.doctor_name, a.department_code)} · ${a.is_done ? '진료 완료' : '대기'}
                </span>`).join('');
        doctorsHtml = `<span class="queue-item-doctors">${tags}</span>`;
    }

    return `
        <button type="button" class="queue-item${selected}" data-visit-id="${visit.id}">
            <span class="queue-item-no ticket-number">${visit.reg_no}</span>
            <span class="queue-item-main">
                <span class="queue-item-name">${escapeHtml(visit.patient.name_kr)}</span>
                <span class="queue-item-meta">${escapeHtml(patientMeta(visit))}</span>
                ${doctorsHtml}
            </span>
        </button>`;
}

function renderList(listId, badgeId, data, showDoctors, emptyText) {
    document.getElementById(badgeId).textContent = `${data.count}명`;
    const el = document.getElementById(listId);

    if (data.results.length === 0) {
        el.innerHTML = `<p class="empty-text">${emptyText}</p>`;
        return;
    }
    el.innerHTML = data.results.map(v => renderQueueItem(v, showDoctors)).join('');
}

function renderLists() {
    document.querySelector('.page-content').appendChild(intakeCard);   // 카드를 먼저 피신

    if (listData.waiting) {
        renderList('waiting-list', 'waiting-count', listData.waiting, false, '접수 대기 중인 환자가 없습니다.');
    }
    if (listData.done) {
        renderList('done-list', 'done-count', listData.done, true, '오늘 접수를 마친 환자가 없습니다.');
    }

    placeIntakeCard();
}

// 접수 카드를 지금 열려 있는 환자 바로 아래에 붙임
function placeIntakeCard() {
    if (!currentVisit) {
        intakeCard.hidden = true;
        return;
    }
    const item = document.querySelector(`.queue-item[data-visit-id="${currentVisit.id}"]`);
    if (item) item.after(intakeCard);   // 목록에서 사라진 경우(다른 기기에서 처리 등)엔 맨 아래에 둠
    intakeCard.hidden = false;
}

function cardHasFocus() {
    return Boolean(currentVisit) && intakeCard.contains(document.activeElement);
}

// 입력 중(커서가 카드 안)이면 화면 갱신을 잠시 미룸 - 키보드가 닫히거나 입력이 끊기는 것 방지
function renderListsSafely() {
    if (cardHasFocus()) {
        renderPending = true;
        return;
    }
    renderPending = false;
    renderLists();
}

intakeCard.addEventListener('focusout', () => {
    setTimeout(() => {
        if (renderPending && !cardHasFocus()) {
            renderPending = false;
            renderLists();
        }
    }, 0);
});

// ----- 서버에서 불러오기 -----
async function loadLists() {
    const [waiting, done] = await Promise.all([
        apiFetch('/visits/?status=waiting_vitals&page_size=200'),
        apiFetch('/visits/?status=intake_done&page_size=200'),
    ]);

    const signature = JSON.stringify([waiting, done]);
    const changed = signature !== listSignature;
    listSignature = signature;
    listData = { waiting, done };

    if (changed) renderListsSafely();
}

async function loadDoctors() {
    const data = await apiFetch('/visit-departments/wait-counts/');

    const signature = JSON.stringify(data);
    if (signature === doctorsSignature) return;
    doctorsSignature = signature;
    doctors = data;

    if (currentVisit) renderDoctorPicker();   // 2부에서 만드는 함수
}

async function refreshAll(force = false) {
    if (isBusy) return;
    if (document.hidden && !force) return;

    try {
        await Promise.all([loadLists(), loadDoctors()]);
    } catch (err) {
        console.error(err);
        if (force) showToast(err.message, true);
    }
}

// ----- 자동 새로고침 -----
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll(true);
});
setInterval(() => refreshAll(), REFRESH_MS);
refreshAll(true);

// =====================================================
// 접수팀 페이지 - 2부: 접수 폼, 의사 배정, 환자 정보 수정
// (1부 파일 맨 아래에 이어서 붙여넣기)
// =====================================================

const byId = (id) => document.getElementById(id);

let submitLabel = '저장 및 배정';   // 새 접수면 '저장 및 배정', 이미 접수된 기록이면 '수정 저장'

// 입력 길이 제한 (서버 모델과 동일하게 맞춰서, 서버 에러가 나기 전에 막음)
const MAX_LENGTHS = {
    bp: 20, allergy_detail: 200, operation_detail: 200,
    history_etc: 200, chief_complaint: 200, symptom_duration: 100,
};
Object.entries(MAX_LENGTHS).forEach(([id, length]) => {
    byId(id).maxLength = length;
});

// ----- 폼 값 읽고 쓰기 -----
function setVal(id, value) { byId(id).value = value ?? ''; }
function setChk(id, value) { byId(id).checked = Boolean(value); }
function getChk(id) { return byId(id).checked; }
function getText(id) { return byId(id).value.trim(); }
function getNum(id, parse) {
    const raw = byId(id).value.trim();
    return raw === '' ? null : parse(raw);
}

function doctorName(id) {
    const d = doctors.find((x) => x.doctor_id === id);
    return d ? d.doctor_name : `의사 #${id}`;
}

function doctorDisplayName(name, deptCode) {
    return deptCode ? `${escapeHtml(deptCode)} · ${escapeHtml(name)}` : escapeHtml(name);
}

function fillPatientHeader(v) {
    byId('intake-reg-no').textContent = v.reg_no;
    byId('intake-name').textContent = v.patient.name_kr;
    byId('intake-meta').textContent = patientMeta(v);
}

function updatePregVisibility() {
    const isFemale = currentVisit && currentVisit.patient.sex === 'F';
    byId('preg-row').hidden = !isFemale;
    if (!isFemale) byId('is_preg').checked = false;
}

function updateDetailVisibility() {
    byId('allergy-field').hidden = !getChk('has_allergy');
    byId('operation-field').hidden = !getChk('has_operation');
}

function fillForm(v) {
    fillPatientHeader(v);
    setVal('bp', v.bp);
    setVal('pr', v.pr);
    setVal('bt', v.bt);
    setVal('bst', v.bst);
    setChk('is_preg', v.is_preg);
    ['has_htn', 'has_dm', 'has_tbc', 'has_hepatitis', 'has_allergy', 'has_operation']
        .forEach((id) => setChk(id, v[id]));
    setVal('allergy_detail', v.allergy_detail);
    setVal('operation_detail', v.operation_detail);
    setVal('history_etc', v.history_etc);
    setVal('chief_complaint', v.chief_complaint);
    setVal('symptom_duration', v.symptom_duration);
    updatePregVisibility();
    updateDetailVisibility();
}

function readIntakePayload() {
    const isFemale = currentVisit.patient.sex === 'F';
    const hasAllergy = getChk('has_allergy');
    const hasOperation = getChk('has_operation');
    return {
        bp: getText('bp'),
        pr: getNum('pr', (s) => parseInt(s, 10)),
        bt: getNum('bt', parseFloat),
        bst: getNum('bst', parseFloat),
        is_preg: isFemale && getChk('is_preg'),
        has_htn: getChk('has_htn'),
        has_dm: getChk('has_dm'),
        has_tbc: getChk('has_tbc'),
        has_hepatitis: getChk('has_hepatitis'),
        has_allergy: hasAllergy,
        allergy_detail: hasAllergy ? getText('allergy_detail') : '',
        has_operation: hasOperation,
        operation_detail: hasOperation ? getText('operation_detail') : '',
        history_etc: getText('history_etc'),
        chief_complaint: getText('chief_complaint'),
        symptom_duration: getText('symptom_duration'),
    };
}

// ----- 읽기 전용 (배정된 모든 진료가 끝난 방문) -----
function isVisitReadOnly(v) {
    return v.assignments.length > 0 && v.assignments.every((a) => a.is_done);
}

function applyReadOnly() {
    document.querySelectorAll('#intake-form input:not([data-doctor-id])').forEach((input) => {
        input.disabled = readOnly;
    });
    byId('intake-submit').hidden = readOnly;
    byId('intake-submit').textContent = submitLabel;
    byId('readonly-notice').hidden = !readOnly;
    byId('edit-patient-btn').hidden = readOnly;
    renderDoctorPicker();
}

// ----- 의사 선택 영역 -----
function assignedOptionHtml(a) {
    const cancelBtn = (!a.is_done && !readOnly)
        ? `<button type="button" class="doctor-cancel" data-assignment-id="${a.id}" data-doctor-name="${escapeHtml(a.doctor_name)}">취소</button>`
        : '';
    return `
        <div class="doctor-option assigned">
            <span class="doctor-option-name">${doctorDisplayName(a.doctor_name, a.department_code)}</span>
            <span class="doctor-option-side">
                <span class="doctor-tag${a.is_done ? '' : ' waiting'}">${a.is_done ? '진료 완료' : '배정됨'}</span>
                ${cancelBtn}
            </span>
        </div>`;
}

function renderDoctorPicker() {
    const box = byId('doctor-picker');
    if (!currentVisit) {
        box.innerHTML = '';
        return;
    }

    const assignments = currentVisit.assignments || [];
    const knownIds = new Set(doctors.map((d) => d.doctor_id));
    const parts = [];

    doctors.forEach((d) => {
        const assigned = assignments.find((a) => a.doctor_id === d.doctor_id);
        if (assigned) {
            parts.push(assignedOptionHtml(assigned));
        } else {
            parts.push(`
                <label class="doctor-option">
                    <input type="checkbox" data-doctor-id="${d.doctor_id}"${pendingDoctorIds.has(d.doctor_id) ? ' checked' : ''}${readOnly ? ' disabled' : ''}>
                    <span class="doctor-option-name">${doctorDisplayName(d.doctor_name, d.department_code)}</span>
                    <span class="doctor-option-wait">${d.waiting_count}명 대기</span>
                </label>`);
        }
    });

    // 진료팀 목록에 없는 사람이 배정돼 있는 경우(관리자가 직접 배정한 경우 등)도 보이게
    assignments.filter((a) => !knownIds.has(a.doctor_id)).forEach((a) => parts.push(assignedOptionHtml(a)));

    box.innerHTML = parts.length
        ? parts.join('')
        : '<p class="empty-text">이번 미션에 진료팀으로 등록된 의사가 없습니다. 관리자에게 문의해주세요.</p>';
}

byId('doctor-picker').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-doctor-id]');
    if (!input) return;
    const id = Number(input.dataset.doctorId);
    if (input.checked) pendingDoctorIds.add(id);
    else pendingDoctorIds.delete(id);
    isDirty = true;
});

byId('doctor-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.doctor-cancel');
    if (!btn) return;
    requestCancelAssignment(Number(btn.dataset.assignmentId), btn.dataset.doctorName);
});

// ----- 배정 취소 -----
function requestCancelAssignment(assignmentId, name) {
    openModal({
        title: '의사 배정 취소',
        bodyHtml: `<p>${escapeHtml(name)} 선생님 배정을 취소할까요?</p>`,
        confirmLabel: '배정 취소',
        onConfirm: () => { cancelAssignment(assignmentId); return false; },
    });
}

async function cancelAssignment(assignmentId) {
    if (isBusy) return;
    isBusy = true;
    let ok = false;
    try {
        await apiFetch(`/visit-departments/${assignmentId}/`, { method: 'DELETE' });
        ok = true;
    } catch (err) {
        showToast(err.message, true);
    } finally {
        isBusy = false;
        closeModal();
    }

    if (ok) showToast('배정을 취소했습니다.');
    await refreshAssignments();   // 성공/실패 모두 최신 상태로 다시 맞춤
    refreshAll(true);
}

// 입력 중인 값은 건드리지 않고, 배정 정보와 읽기 전용 여부만 서버 기준으로 갱신
async function refreshAssignments() {
    if (!currentVisit) return;
    try {
        const fresh = await apiFetch(`/visits/${currentVisit.id}/`);
        if (isVisitReadOnly(fresh) && !readOnly) {
            // 그 사이 진료가 모두 끝난 경우: 저장된 값으로 되돌리고 읽기 전용으로 전환
            currentVisit = fresh;
            readOnly = true;
            pendingDoctorIds = new Set();
            fillForm(fresh);
            isDirty = false;
            showToast('진료가 모두 끝나 수정할 수 없는 상태가 되었습니다.', true);
        } else {
            currentVisit.assignments = fresh.assignments;
            readOnly = isVisitReadOnly(fresh);
        }
        applyReadOnly();
    } catch (err) {
        console.error(err);
    }
}

// ----- 방문 열기 / 닫기 -----
async function openVisit(id) {
    try {
        const visit = await apiFetch(`/visits/${id}/`);
        currentVisit = visit;
        pendingDoctorIds = new Set();
        readOnly = isVisitReadOnly(visit);
        submitLabel = visit.chief_complaint ? '수정 저장' : '저장 및 배정';
        fillForm(visit);
        applyReadOnly();
        isDirty = false;
        byId('intake-error').textContent = '';

        renderLists();        // 선택 강조 + 접수 카드를 그 환자 바로 아래로 옮김
        scrollToSelected();
    } catch (err) {
        showToast(err.message, true);
    }
}

function scrollToSelected() {
    const item = document.querySelector('.queue-item.selected');
    (item || intakeCard).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function requestOpenVisit(id) {
    if (currentVisit && currentVisit.id === id) {
        scrollToSelected();
        return;
    }
    if (currentVisit && isDirty && !readOnly) {
        openModal({
            title: '작성 중인 내용이 있어요',
            bodyHtml: '<p>다른 환자를 열면 지금 입력한 내용이 사라집니다.</p>',
            confirmLabel: '다른 환자 열기',
            onConfirm: () => { openVisit(id); },
        });
    } else {
        openVisit(id);
    }
}

function resetIntake() {
    currentVisit = null;
    pendingDoctorIds = new Set();
    readOnly = false;
    isDirty = false;
    byId('intake-card').hidden = true;
    byId('intake-error').textContent = '';
    renderLists();   // 선택 강조 해제
}

function requestCloseIntake() {
    if (isDirty && !readOnly) {
        openModal({
            title: '작성 중인 내용이 있어요',
            bodyHtml: '<p>지금 닫으면 저장하지 않은 내용이 사라집니다.</p>',
            confirmLabel: '닫기',
            onConfirm: () => { resetIntake(); },
        });
    } else {
        resetIntake();
    }
}

['waiting-list', 'done-list'].forEach((listId) => {
    byId(listId).addEventListener('click', (e) => {
        const item = e.target.closest('.queue-item');
        if (!item) return;
        requestOpenVisit(Number(item.dataset.visitId));
    });
});

byId('close-intake-btn').addEventListener('click', requestCloseIntake);

// ----- 폼 동작 -----
byId('has_allergy').addEventListener('change', updateDetailVisibility);
byId('has_operation').addEventListener('change', updateDetailVisibility);

// 입력이 하나라도 바뀌면 "작성 중"으로 표시
['input', 'change'].forEach((eventName) => {
    byId('intake-form').addEventListener(eventName, () => {
        if (!readOnly) isDirty = true;
    });
});

// 작성 중에 페이지를 떠나려 하면 브라우저 경고
window.addEventListener('beforeunload', (e) => {
    if (isDirty && !readOnly) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// ----- 저장 및 배정 -----
byId('intake-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentVisit || readOnly || isBusy) return;

    const errorEl = byId('intake-error');
    errorEl.textContent = '';

    const payload = readIntakePayload();
    if (!payload.chief_complaint) {
        errorEl.textContent = '주호소를 입력해주세요.';
        byId('chief_complaint').focus();
        return;
    }
    if (currentVisit.assignments.length + pendingDoctorIds.size === 0) {
        errorEl.textContent = '의사를 한 명 이상 선택해주세요.';
        return;
    }

    const visitId = currentVisit.id;
    const submitBtn = byId('intake-submit');
    isBusy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '저장 중…';

    let saved = false;
    const failedDoctors = [];

    try {
        await apiFetch(`/visits/${visitId}/`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });
        saved = true;

        for (const doctorId of [...pendingDoctorIds]) {
            try {
                await apiFetch('/visit-departments/', {
                    method: 'POST',
                    body: JSON.stringify({ visit: visitId, user: doctorId }),
                });
                pendingDoctorIds.delete(doctorId);
            } catch (err) {
                failedDoctors.push(doctorName(doctorId));
            }
        }
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        isBusy = false;
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
    }

    if (!saved) return;

    if (failedDoctors.length === 0) {
        isDirty = false;
        showToast('접수 정보를 저장했습니다.');
        await refreshAll(true);
        resetIntake();
    } else {
        errorEl.textContent = `접수 정보는 저장됐지만 다음 의사 배정에 실패했습니다: ${failedDoctors.join(', ')}\n다시 선택해서 저장해주세요.`;
        await refreshAssignments();
        refreshAll(true);
    }
});

// ----- 환자 정보 수정 -----
function openPatientEditModal() {
    if (!currentVisit || readOnly) return;
    const p = currentVisit.patient;

    openModal({
        title: '환자 정보 수정',
        bodyHtml: `
            <p class="modal-note">안내팀이 입력한 정보를 수정합니다. 저장하면 바로 반영돼요.</p>
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
    if (isBusy || !currentVisit) return;

    const errorEl = byId('pe-error');
    errorEl.textContent = '';

    const nameKr = byId('pe-name-kr').value.trim();
    const birthYear = parseInt(byId('pe-birth-year').value, 10);
    if (!nameKr) {
        errorEl.textContent = '이름(한글)을 입력해주세요.';
        return;
    }
    if (!birthYear || birthYear < 1900 || birthYear > new Date().getFullYear()) {
        errorEl.textContent = '출생연도를 확인해주세요.';
        return;
    }

    const patientId = currentVisit.patient.id;
    let updated = null;
    isBusy = true;
    try {
        updated = await apiFetch(`/patients/${patientId}/`, {
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

    if (!updated || !currentVisit) return;
    currentVisit.patient = updated;
    closeModal();
    fillPatientHeader(currentVisit);
    updatePregVisibility();
    showToast('환자 정보를 수정했습니다.');
    refreshAll(true);
}

byId('edit-patient-btn').addEventListener('click', openPatientEditModal);

initPatientIntake({
    onVisitCreated: (visit) => {
        currentVisit = visit;
        currentVisit.assignments = [];
        pendingDoctorIds = new Set();
        readOnly = false;
        submitLabel = '저장 및 배정';
        fillForm(visit);
        applyReadOnly();
        isDirty = false;
        byId('intake-error').textContent = '';

        document.querySelector('.page-content').appendChild(intakeCard);
        intakeCard.hidden = false;
        showToast(`${visit.patient.name_kr}님 등록번호 ${visit.reg_no}번 발급 — 바로 접수를 진행해주세요.`);
        intakeCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

        refreshAll(true);   // 접수 대기 목록에 반영
    },
});