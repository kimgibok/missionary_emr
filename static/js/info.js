async function loadWaitCounts() {
    try {
        const data = await apiFetch('/visit-departments/wait-counts/');
        const el = document.getElementById('wait-counts');

        if (data.length === 0) {
            el.innerHTML = '<span style="color: var(--color-text-muted); font-size: 14px;">배정된 의사가 없습니다.</span>';
            return;
        }

        el.innerHTML = data.map(d => `
            <div class="wait-count-item">
                <span>${d.doctor_name || '(이름없음)'}</span>
                <span class="count">${d.waiting_count}명 대기</span>
            </div>
        `).join('');
    } catch (err) {
        console.error(err);
    }
}

document.getElementById('search-btn').addEventListener('click', async () => {
    const search = document.getElementById('search-input').value;
    if (!search) return;

    try {
        const data = await apiFetch(`/patients/?search=${encodeURIComponent(search)}&scope=current_mission`);
        const el = document.getElementById('search-results');

        if (data.results.length === 0) {
            el.innerHTML = '<p style="color: var(--color-text-muted); font-size: 14px;">검색 결과가 없습니다. 신규 등록해주세요.</p>';
            return;
        }

        el.innerHTML = data.results.map(p => `
            <div class="patient-item">
                <div>
                    <div class="patient-item-name">${p.name_kr}</div>
                    <div class="patient-item-meta">${p.sex === 'M' ? '남' : '여'} · ${p.birth_year}년생</div>
                </div>
                <button class="btn-primary btn-inline" data-patient-id="${p.id}">방문 등록</button>
            </div>
        `).join('');

        el.querySelectorAll('button[data-patient-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                openModal({
                    title: '방문 등록',
                    bodyHtml: `
                        <label class="field-label">체중 (kg, 선택)</label>
                        <input class="field-input" type="number" step="0.1" id="modal-weight-input">
                    `,
                    confirmLabel: '등록',
                    onConfirm: () => {
                        const weight = document.getElementById('modal-weight-input').value;
                        registerVisit(btn.dataset.patientId, weight || undefined);
                    },
                });
            });
        });
    } catch (err) {
        alert(err.message);
    }
});

document.getElementById('new-patient-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    try {
        const patient = await apiFetch('/patients/', {
            method: 'POST',
            body: JSON.stringify({
                name_kr: document.getElementById('name_kr').value,
                name_local: document.getElementById('name_local').value,
                sex: document.getElementById('sex').value,
                birth_year: parseInt(document.getElementById('birth_year').value),
            }),
        });

        await registerVisit(patient.id, document.getElementById('weight').value);
        e.target.reset();
    } catch (err) {
        alert(err.message);
    }
});

async function registerVisit(patientId, weight) {
    try {
        const body = { patient: patientId };
        if (weight) body.weight = parseFloat(weight);

        const visit = await apiFetch('/visits/', {
            method: 'POST',
            body: JSON.stringify(body),
        });

        document.getElementById('ticket-result').innerHTML = `
            <div class="ticket">
                <div class="ticket-reg-no">${visit.reg_no}</div>
                <div class="ticket-label">등록번호</div>
            </div>
        `;
        loadWaitCounts();
    } catch (err) {
        alert(err.message);
    }
}

loadWaitCounts();