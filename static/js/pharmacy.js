// =====================================================
// 약국팀 페이지
//   1. 조제 대기 목록 (오늘, 진료가 모두 끝난 환자, 등록번호 순)
//   2. 조제 패널 열기·닫기
//   3. 처방약마다 배치 선택
//   4. 수량 수정 (재고가 모자랄 때만, 1 이상)
//   5. 수령 처리
// escapeHtml, patientMeta, doctorLabel, showToast, byId는 common.js
// =====================================================

const REFRESH_MS = 10000;
const dispensePanel = byId('dispense-panel');

// ----- 상태 -----
let queueData = null;           // 조제 대기 목록 - 서버 응답 그대로
let queueSignature = '';        // 목록이 바뀌었는지 비교용
let renderPending = false;      // 배치를 고르는 중이라 목록 갱신을 미뤄둔 상태
let currentVisit = null;        // 지금 열려 있는 환자의 조제 정보 (dispense-options 응답)
let batchChoice = new Map();    // 처방약 id → 고른 배치(mission_stock) id
let isBusy = false;             // 저장 요청 중이면 자동 새로고침·중복 클릭을 막음


// =====================================================
// 1. 조제 대기 목록
// =====================================================

// 처방약 전부 (약 없는 처방은 빈 배열)
function allItems(visit) {
    return visit.prescriptions.flatMap((p) => p.items);
}

function queueItemHtml(v) {
    const selected = currentVisit && currentVisit.id === v.id ? ' selected' : '';
    const drugCount = allItems(v).length;
    const drugTag = drugCount === 0 ? '약 없음' : `약 ${drugCount}종`;
    const allergyTag = v.has_allergy ? '<span class="doctor-tag unassigned">알레르기</span>' : '';
    return `
        <button type="button" class="queue-item${selected}" data-visit-id="${v.id}">
            <span class="queue-item-no ticket-number">${v.reg_no}</span>
            <span class="queue-item-main">
                <span class="queue-item-name">${escapeHtml(v.patient.name_kr)}</span>
                <span class="queue-item-meta">${escapeHtml(patientMeta(v))}</span>
            </span>
            <span class="queue-item-tags">
                ${allergyTag}
                <span class="doctor-tag waiting">처방 ${v.prescriptions.length}건 · ${drugTag}</span>
            </span>
        </button>`;
}

function renderQueue() {
    byId('queue-count').textContent = `${queueData.count}명`;
    byId('queue-list').innerHTML = queueData.results.length === 0
        ? '<p class="empty-text">조제를 기다리는 환자가 없습니다.</p>'
        : queueData.results.map(queueItemHtml).join('');
    placePanel();
}

// 조제 패널을 열린 환자 바로 아래에 붙임.
// 목록에서 사라졌으면(다른 기기에서 수령 처리, 의사가 완료 취소) 패널을 닫는다.
function placePanel() {
    if (!currentVisit) {
        byId('panel-dock').appendChild(dispensePanel);
        dispensePanel.hidden = true;
        return;
    }
    const item = document.querySelector(`.queue-item[data-visit-id="${currentVisit.id}"]`);
    if (!item) {
        const name = currentVisit.patient.name_kr;
        closePanel();
        showToast(`${name} 환자가 조제 대기에서 빠졌습니다. (다른 기기에서 수령 처리했거나 의사가 완료를 취소)`, true);
        return;
    }
    item.after(dispensePanel);
    dispensePanel.hidden = false;
}

function panelHasFocus() {
    return Boolean(currentVisit) && dispensePanel.contains(document.activeElement);
}

// 배치를 고르는 중(패널에 포커스)이면 목록 다시 그리기를 미룬다
function renderQueueSafely() {
    if (panelHasFocus()) {
        renderPending = true;
        return;
    }
    renderPending = false;
    renderQueue();
}

dispensePanel.addEventListener('focusout', () => {
    setTimeout(() => {
        if (renderPending && !panelHasFocus()) {
            renderPending = false;
            renderQueue();
        }
    }, 0);
});

async function loadQueue() {
    const data = await apiFetch('/visits/pharmacy-queue/?page_size=200');
    const signature = JSON.stringify(data);
    if (signature === queueSignature) return;
    queueSignature = signature;
    queueData = data;
    renderQueueSafely();
}

async function refreshAll(force = false) {
    if (isBusy) return;
    if (document.hidden && !force) return;
    try {
        await loadQueue();
    } catch (err) {
        console.error(err);
        if (force) showToast(err.message, true);
    }
}

byId('queue-list').addEventListener('click', (e) => {
    const item = e.target.closest('.queue-item');
    if (!item) return;
    const id = Number(item.dataset.visitId);
    if (currentVisit && currentVisit.id === id) {
        closePanel();
    } else {
        openVisit(id);
    }
});


// =====================================================
// 2. 조제 패널 열기·닫기
// =====================================================

async function loadVisitOptions(id) {
    currentVisit = await apiFetch(`/visits/${id}/dispense-options/`);
    applyDefaultChoices();
    renderPanel();
}

async function openVisit(id) {
    try {
        batchChoice = new Map();
        await loadVisitOptions(id);
        renderQueue();
        scrollToSelected();
    } catch (err) {
        showToast(err.message, true);
    }
}

function closePanel() {
    currentVisit = null;
    batchChoice = new Map();
    byId('dp-error').textContent = '';
    if (queueData) renderQueue();
}

function scrollToSelected() {
    const item = document.querySelector('.queue-item.selected');
    (item || dispensePanel).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

byId('dp-close-btn').addEventListener('click', closePanel);


// =====================================================
// 3. 처방 카드 · 배치 선택
// =====================================================

// "1회 1 · 하루 3번 · 5일 · 식후" - 복용스케줄로 처방한 약만 앞부분이 있다
function dosageText(i) {
    const parts = [];
    if (i.dose_per_intake && i.frequency_per_day && i.duration_days) {
        parts.push(`1회 ${i.dose_per_intake}`, `하루 ${i.frequency_per_day}번`, `${i.duration_days}일`);
    }
    if (i.usage) parts.push(i.usage);
    return parts.join(' · ');
}

// 이 처방약에 쓸 수 있는 배치 = 잔량이 처방 수량 이상
function usableBatches(i) {
    return i.available_batches.filter((b) => b.remaining_qty >= i.quantity);
}

// 이전에 고른 배치가 아직 쓸 수 있으면 유지, 아니면 쓸 수 있는 배치가 하나뿐일 때만 자동 선택 (자동 FIFO 아님)
function applyDefaultChoices() {
    const next = new Map();
    allItems(currentVisit).forEach((i) => {
        const usable = usableBatches(i);
        const prev = batchChoice.get(i.id);
        if (prev && usable.some((b) => b.mission_stock_id === prev)) {
            next.set(i.id, prev);
        } else if (usable.length === 1) {
            next.set(i.id, usable[0].mission_stock_id);
        }
    });
    batchChoice = next;
}

function batchOptionsHtml(i) {
    const chosen = batchChoice.get(i.id);
    const options = i.available_batches.map((b) => {
        const short = b.remaining_qty < i.quantity;
        const expired = b.expiry_date < currentVisit.visit_date;
        const label = [
            `유통기한 ${b.expiry_date}${expired ? ' (지남)' : ''}`,
            b.source,
            `잔량 ${b.remaining_qty}${short ? ' - 부족' : ''}`,
        ].join(' · ');
        const attrs = (short ? ' disabled' : '') + (b.mission_stock_id === chosen ? ' selected' : '');
        return `<option value="${b.mission_stock_id}"${attrs}>${escapeHtml(label)}</option>`;
    });
    return `<option value=""${chosen ? '' : ' selected'}>배치 선택</option>${options.join('')}`;
}

function dispenseItemHtml(i) {
    const dosage = dosageText(i);
    let batchHtml;
    if (i.available_batches.length === 0) {
        batchHtml = '<p class="dispense-item-missing">이번 미션 재고에 없는 약입니다. 의사에게 처방 변경을 요청하세요.</p>';
    } else if (usableBatches(i).length === 0) {
        batchHtml = `
            <select class="field-input dispense-batch" data-item-id="${i.id}" aria-label="${escapeHtml(i.drug_name)} 배치">${batchOptionsHtml(i)}</select>
            <p class="dispense-item-missing">처방 수량만큼 남은 배치가 없습니다. 수량을 줄이거나 의사에게 처방 변경을 요청하세요.</p>`;
    } else {
        batchHtml = `<select class="field-input dispense-batch" data-item-id="${i.id}" aria-label="${escapeHtml(i.drug_name)} 배치">${batchOptionsHtml(i)}</select>`;
    }
    const missing = usableBatches(i).length === 0 ? ' is-missing' : '';
    return `
        <div class="dispense-item${missing}" data-item-id="${i.id}">
            <div class="dispense-item-head">
                <span class="dispense-item-name">${escapeHtml(i.drug_name)}</span>
                <span class="dispense-item-qty ticket-number">× ${i.quantity}</span>
                <button type="button" class="qty-edit-btn" data-action="edit-qty">수량 수정</button>
            </div>
            ${dosage ? `<div class="dispense-item-dosage">${escapeHtml(dosage)}</div>` : ''}
            ${batchHtml}
        </div>`;
}

function prescriptionHtml(p) {
    const items = p.items.length === 0
        ? '<p class="dispense-no-drug">처방약 없음 (약 없이 수령 처리됩니다)</p>'
        : `<div class="dispense-items">${p.items.map(dispenseItemHtml).join('')}</div>`;
    return `
        <div class="prescription-card">
            <div class="prescription-card-head">
                <span class="prescription-card-dept">${doctorLabel(p.doctor_name, p.department_name)}</span>
            </div>
            ${p.clinical_note ? `<div class="prescription-card-note">${escapeHtml(p.clinical_note)}</div>` : ''}
            ${items}
        </div>`;
}

function renderPanel() {
    const v = currentVisit;
    byId('dp-reg-no').textContent = v.reg_no;
    byId('dp-name').textContent = v.patient.name_kr;
    byId('dp-meta').textContent = patientMeta(v) + (v.weight ? ` · ${v.weight}kg` : '');

    const allergy = byId('dp-allergy');
    allergy.hidden = !v.has_allergy;
    allergy.textContent = v.has_allergy ? `알레르기: ${v.allergy_detail || '있음 (상세 미입력)'}` : '';

    byId('dp-prescriptions').innerHTML = v.prescriptions.map(prescriptionHtml).join('');
    byId('dp-error').textContent = '';
}

byId('dp-prescriptions').addEventListener('change', (e) => {
    const select = e.target.closest('.dispense-batch');
    if (!select) return;
    const itemId = Number(select.dataset.itemId);
    if (select.value) {
        batchChoice.set(itemId, Number(select.value));
    } else {
        batchChoice.delete(itemId);
    }
    byId('dp-error').textContent = '';
});


// =====================================================
// 4. 수량 수정 (재고가 모자랄 때만, 1 이상 / 약을 바꾸거나 빼는 건 의사가)
// =====================================================

function findItem(itemId) {
    return allItems(currentVisit).find((i) => i.id === itemId);
}

function openQtyModal(itemId) {
    const item = findItem(itemId);
    if (!item) return;
    openModal({
        title: '수량 수정',
        bodyHtml: `
            <p class="modal-note">${escapeHtml(item.drug_name)} · 지금 수량 ${item.quantity}<br>
            재고가 모자랄 때만 줄여주세요. 약을 바꾸거나 빼야 하면 의사에게 [완료 취소]를 요청하세요.</p>
            <label class="field-label" for="qty-input">수량</label>
            <input class="field-input" type="number" id="qty-input" min="1" inputmode="numeric" value="${item.quantity}">
            <p class="error-message" id="qty-error"></p>`,
        confirmLabel: '수정하기',
        onConfirm: () => { saveQty(itemId); return false; },
    });
    byId('qty-input').select();
}

async function saveQty(itemId) {
    if (isBusy || !currentVisit) return;
    const errorEl = byId('qty-error');
    const quantity = parseInt(byId('qty-input').value, 10);
    if (!quantity || quantity < 1) {
        errorEl.textContent = '1 이상의 수량을 입력해주세요.';
        return;
    }

    isBusy = true;
    try {
        await apiFetch(`/prescription-drugs/${itemId}/`, {
            method: 'PATCH',
            body: JSON.stringify({ quantity }),
        });
    } catch (err) {
        errorEl.textContent = err.message;
        isBusy = false;
        return;
    }
    isBusy = false;

    closeModal();
    showToast('수량을 수정했습니다.');
    try {
        await loadVisitOptions(currentVisit.id);   // 잔량 기준으로 배치 선택지를 다시 계산
    } catch (err) {
        showToast(err.message, true);
    }
    refreshAll(true);
}

byId('dp-prescriptions').addEventListener('click', (e) => {
    if (e.target.dataset.action !== 'edit-qty') return;
    const card = e.target.closest('.dispense-item');
    openQtyModal(Number(card.dataset.itemId));
});


// =====================================================
// 5. 수령 처리
// =====================================================

function requestDispense() {
    if (!currentVisit || isBusy) return;
    const errorEl = byId('dp-error');
    const items = allItems(currentVisit);

    const notChosen = items.filter((i) => !batchChoice.has(i.id));
    if (notChosen.length > 0) {
        errorEl.textContent = `배치를 고르지 않은 약이 있습니다: ${notChosen.map((i) => i.drug_name).join(', ')}`;
        return;
    }

    const name = currentVisit.patient.name_kr;
    const summary = items.length === 0
        ? '처방약 없이 수령 처리합니다.'
        : `처방약 ${items.length}종을 고른 배치에서 재고 차감하고 수령 처리합니다.`;
    openModal({
        title: '수령 완료',
        bodyHtml: `<p class="modal-note">${escapeHtml(name)} 환자 · ${summary}<br>잘못 처리했으면 오늘 안에 수령 취소할 수 있어요.</p>`,
        confirmLabel: '수령 완료',
        onConfirm: () => { dispense(); },
    });
}

async function dispense() {
    if (!currentVisit || isBusy) return;
    const btn = byId('dp-dispense-btn');
    const name = currentVisit.patient.name_kr;
    const items = allItems(currentVisit).map((i) => ({
        prescription_drug: i.id,
        mission_stock: batchChoice.get(i.id),
    }));

    isBusy = true;
    btn.disabled = true;
    btn.textContent = '처리 중…';
    try {
        await apiFetch(`/visits/${currentVisit.id}/dispense/`, {
            method: 'POST',
            body: JSON.stringify({ items }),
        });
        showToast(`${name} 환자 수령 처리를 완료했습니다.`);
        closePanel();   // 목록 갱신 전에 닫아야 placePanel이 '대기에서 빠짐' 알림을 띄우지 않는다
    } catch (err) {
        byId('dp-error').textContent = err.message;
        showToast(err.message, true);
    } finally {
        isBusy = false;
        btn.disabled = false;
        btn.textContent = '수령 완료';
    }
    // 실패했어도 갱신한다 - 다른 기기에서 먼저 처리했으면 목록에서 빠지면서 패널이 닫힌다
    refreshAll(true);
}

byId('dp-dispense-btn').addEventListener('click', requestDispense);


// =====================================================
// 시작
// =====================================================

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll(true);
});
setInterval(() => refreshAll(), REFRESH_MS);
refreshAll(true);
