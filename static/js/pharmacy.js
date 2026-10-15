// =====================================================
// 약국팀 페이지
//   1. 조제 대기 목록 (오늘, 진료가 모두 끝난 환자, 등록번호 순)
//   2. 조제 패널 열기·닫기
//   3. 처방약마다 배치 선택
//   4. 수량 수정 (재고가 모자랄 때만, 1 이상)
//   5. 수령 처리
//   6. 조제지 출력 (자동 출력 PC에서 새 환자를 자동 인쇄 + 패널의 [조제지 출력])
//   7. 재고 문제 경고창 · 소리
// escapeHtml, patientMeta, doctorLabel, showToast, byId는 common.js
// =====================================================

const REFRESH_MS = 10000;
const ALARM_REPEAT_MS = 10000;               // 경고창을 확인할 때까지 소리를 다시 울리는 간격
const AUTOPRINT_KEY = 'pharmacy_autoprint';  // 이 기기에서 자동 출력을 켰는지 (localStorage)
const PAPER_KEY = 'pharmacy_paper';          // 이 기기의 조제지 용지 'receipt' | 'a4' (localStorage)
// 용지별 @page. 영수증은 크기를 정하지 않아(auto) 프린터 드라이버의 기본 용지(80mm·58mm 감열지)를 따른다.
const PAGE_STYLES = {
    receipt: '@page { size: auto; margin: 0; }',
    a4: '@page { size: A4; margin: 14mm; }',
};
const dispensePanel = byId('dispense-panel');

// ----- 상태 -----
let queueData = null;           // 조제 대기 목록 - 서버 응답 그대로
let queueSignature = '';        // 목록이 바뀌었는지 비교용
let renderPending = false;      // 배치를 고르는 중이라 목록 갱신을 미뤄둔 상태
let currentVisit = null;        // 지금 열려 있는 환자의 조제 정보 (dispense-options 응답)
let batchChoice = new Map();    // 처방약 id → 고른 배치(mission_stock) id
let isBusy = false;             // 저장 요청 중이면 자동 새로고침·중복 클릭을 막음

let isPrinting = false;         // 자동 출력 중복 실행 방지
let audioCtx = null;            // 경고음 - 사용자가 한 번 눌러야 브라우저가 소리를 허락한다
let alarmTimer = null;          // 경고창을 확인할 때까지 소리 반복
let alarmEntries = [];          // 경고창에 띄운 재고 문제 [{ visit, issues }]


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
    const stockTag = v.stock_issues.length > 0 ? '<span class="doctor-tag unassigned">재고 확인</span>' : '';
    return `
        <button type="button" class="queue-item${selected}" data-visit-id="${v.id}">
            <span class="queue-item-no ticket-number">${v.reg_no}</span>
            <span class="queue-item-main">
                <span class="queue-item-name">${escapeHtml(v.patient.name_kr)}</span>
                <span class="queue-item-meta">${escapeHtml(patientMeta(v))}</span>
            </span>
            <span class="queue-item-tags">
                ${allergyTag}
                ${stockTag}
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
    // 자동 출력 PC는 다른 창에 가려져 있어도 계속 확인한다
    if (document.hidden && !force && !isAutoPrintOn()) return;
    try {
        await loadQueue();
        if (isAutoPrintOn()) await autoPrintNew();
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
// 6. 조제지 출력
//    자동 출력을 켠 기기만 새 환자를 인쇄한다. 서버(print-claim)가 '출력함'을 먼저 가져간 기기에만 주므로
//    두 기기에서 켜도 한 장만 나온다. 확인창 없이 바로 인쇄하려면 크롬을 --kiosk-printing으로 실행한다.
// =====================================================

function isAutoPrintOn() {
    return byId('autoprint-toggle').checked;
}

function nowTimeLabel() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 환자 한 명의 조제지 (escape된 HTML)
function slipHtml(v) {
    const issues = v.stock_issues || [];
    const issueIds = new Set(issues.map((x) => x.prescription_drug));
    const meta = patientMeta(v) + (v.weight ? ` · ${v.weight}kg` : '');

    const allergy = v.has_allergy
        ? `<div class="slip-allergy">알레르기: ${escapeHtml(v.allergy_detail || '있음 (상세 미입력)')}</div>`
        : '';
    const warning = issues.length > 0
        ? `<div class="slip-warning">조제 전 의사 확인 필요
               <ul>${issues.map((x) => `<li>${escapeHtml(x.drug_name)}: ${escapeHtml(x.message)}</li>`).join('')}</ul>
           </div>`
        : '';

    const rows = (p) => p.items.map((i) => `
        <tr${issueIds.has(i.id) ? ' class="has-issue"' : ''}>
            <td>${escapeHtml(i.drug_name)}${issueIds.has(i.id) ? ' <span class="slip-issue-mark">[확인 필요]</span>' : ''}</td>
            <td class="slip-qty">${i.quantity}</td>
            <td>${escapeHtml(dosageText(i)) || '-'}</td>
            <td class="slip-check"><span class="slip-checkbox"></span></td>
        </tr>`).join('');

    const prescriptions = v.prescriptions.map((p) => `
        <section class="slip-rx">
            <h3 class="slip-rx-head">${doctorLabel(p.doctor_name, p.department_name)}</h3>
            ${p.clinical_note ? `<p class="slip-rx-note">${escapeHtml(p.clinical_note)}</p>` : ''}
            ${p.items.length === 0
                ? '<p class="slip-no-drug">처방약 없음</p>'
                : `<table class="slip-table">
                       <thead><tr><th>약</th><th>수량</th><th>복용법</th><th>조제</th></tr></thead>
                       <tbody>${rows(p)}</tbody>
                   </table>`}
        </section>`).join('');

    return `
        <article class="slip">
            <header class="slip-header">
                <div class="slip-ticket">
                    <span class="slip-ticket-no">${v.reg_no}</span>
                    <span class="slip-ticket-label">등록번호</span>
                </div>
                <div class="slip-patient">
                    <div class="slip-name">${escapeHtml(v.patient.name_kr)}</div>
                    <div class="slip-meta">${escapeHtml(meta)}</div>
                </div>
                <div class="slip-title">조제지</div>
            </header>
            ${allergy}
            ${warning}
            ${prescriptions}
            <footer class="slip-footer">${escapeHtml(v.visit_date)} · 출력 ${nowTimeLabel()}</footer>
        </article>`;
}

// 고른 용지에 맞춰 조제지 모양(영수증/A4)과 @page를 바꾼다
function applyPaper() {
    const paper = byId('paper-select').value;
    byId('print-area').classList.toggle('is-receipt', paper === 'receipt');
    byId('page-style').textContent = PAGE_STYLES[paper];
}

byId('paper-select').addEventListener('change', () => {
    localStorage.setItem(PAPER_KEY, byId('paper-select').value);
    applyPaper();
});

// 여러 명이면 한 사람에 한 장씩 이어서 인쇄. window.print()는 인쇄가 끝날 때까지 멈춘다.
function printSlips(visits) {
    applyPaper();
    byId('print-area').innerHTML = visits.map(slipHtml).join('');
    window.print();
}

window.addEventListener('afterprint', () => {
    byId('print-area').innerHTML = '';
});

// 아직 출력하지 않은 환자를 서버에서 '출력함'으로 가져와 인쇄하고, 재고 문제가 있으면 경고
async function autoPrintNew() {
    if (isPrinting || !queueData) return;
    const pending = queueData.results.filter((v) => !v.slip_printed_at);
    if (pending.length === 0) return;

    isPrinting = true;
    try {
        const { claimed } = await apiFetch('/visits/print-claim/', {
            method: 'POST',
            body: JSON.stringify({ ids: pending.map((v) => v.id) }),
        });
        const visits = pending.filter((v) => claimed.includes(v.id));
        if (visits.length === 0) return;

        printSlips(visits);
        const withIssues = visits.filter((v) => v.stock_issues.length > 0);
        if (withIssues.length > 0) raiseStockAlarm(withIssues);
    } catch (err) {
        console.error(err);
        showToast(`조제지 자동 출력 실패: ${err.message}`, true);
    } finally {
        isPrinting = false;
    }
}

// 패널의 [조제지 출력] - 다시 출력하거나 수동으로 출력. 자동 출력 PC가 또 찍지 않게 '출력함'도 남긴다.
async function printCurrent() {
    if (!currentVisit) return;
    const visit = currentVisit;
    printSlips([visit]);
    try {
        await apiFetch('/visits/print-claim/', { method: 'POST', body: JSON.stringify({ ids: [visit.id] }) });
    } catch (err) {
        console.error(err);
    }
}

byId('dp-print-btn').addEventListener('click', printCurrent);


// =====================================================
// 7. 재고 문제 경고창 · 소리 (자동 출력 PC)
// =====================================================

// 소리 허락받기 - 클릭 같은 사용자 동작 안에서 불러야 한다
function ensureAudio() {
    if (!audioCtx) {
        if (!window.AudioContext) return null;
        audioCtx = new AudioContext();
        audioCtx.onstatechange = updateAutoPrintStatus;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function soundReady() {
    return Boolean(audioCtx) && audioCtx.state === 'running';
}

// "삐-삐-삐" (소리 파일 없이 브라우저에서 만든다)
function beep(times = 3) {
    const ctx = audioCtx;
    if (!ctx) return;
    for (let k = 0; k < times; k++) {
        const start = ctx.currentTime + k * 0.35;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.3);
    }
}

function alarmBodyHtml() {
    const lines = alarmEntries.flatMap(({ visit, issues }) => issues.map((x) => `
        <li><strong>#${visit.reg_no} ${escapeHtml(visit.patient.name_kr)}</strong> ·
            ${escapeHtml(x.drug_name)}: ${escapeHtml(x.message)}</li>`));
    return `
        <p class="modal-note">조제지에도 같이 찍혔습니다. 의사에게 확인해주세요.
            약을 바꾸거나 빼야 하면 의사가 [완료 취소] 후 수정하고, 다시 완료하면 수정된 조제지가 자동으로 나옵니다.</p>
        <ul class="alarm-list">${lines.join('')}</ul>`;
}

function stopAlarm() {
    clearInterval(alarmTimer);
    alarmTimer = null;
    alarmEntries = [];
}

// 확인을 누를 때까지 소리를 반복. 이미 경고창이 떠 있으면 새 환자를 목록에 더한다.
function raiseStockAlarm(visits) {
    visits.forEach((visit) => {
        alarmEntries = alarmEntries.filter((x) => x.visit.id !== visit.id);
        alarmEntries.push({ visit, issues: visit.stock_issues });
    });

    openModal({
        title: '재고 확인 필요',
        bodyHtml: alarmBodyHtml(),
        confirmLabel: '확인했어요',
        onConfirm: () => { stopAlarm(); },
    });
    byId('modal-cancel').onclick = () => { stopAlarm(); closeModal(); };

    beep();
    clearInterval(alarmTimer);
    alarmTimer = setInterval(() => beep(), ALARM_REPEAT_MS);
}

function updateAutoPrintStatus() {
    const el = byId('autoprint-status');
    if (!isAutoPrintOn()) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    const ready = soundReady();
    el.classList.toggle('is-warning', !ready);
    el.textContent = ready
        ? '이 기기에서 조제지를 자동 출력합니다. 재고 문제가 있으면 소리와 안내창으로 알려요.'
        : '자동 출력 중 · 경고음을 켜려면 화면을 아무 곳이나 한 번 눌러주세요.';
}

byId('autoprint-toggle').addEventListener('change', () => {
    if (isAutoPrintOn()) {
        localStorage.setItem(AUTOPRINT_KEY, '1');
        ensureAudio();
        beep(1);    // 소리 확인용
        refreshAll(true);
    } else {
        localStorage.removeItem(AUTOPRINT_KEY);
        stopAlarm();
    }
    updateAutoPrintStatus();
});

// 새로고침 뒤에는 브라우저가 소리를 다시 막으므로, 화면을 처음 누를 때 허락받는다
document.addEventListener('pointerdown', () => {
    if (isAutoPrintOn() && !soundReady()) ensureAudio();
});


// =====================================================
// 시작
// =====================================================

byId('autoprint-toggle').checked = localStorage.getItem(AUTOPRINT_KEY) === '1';
byId('paper-select').value = localStorage.getItem(PAPER_KEY) === 'a4' ? 'a4' : 'receipt';
applyPaper();
updateAutoPrintStatus();

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll(true);
});
setInterval(() => refreshAll(), REFRESH_MS);
refreshAll(true);
