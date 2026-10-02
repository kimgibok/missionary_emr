// 공용: 환자 검색 + 신규 등록 + 방문 등록
// 페이지에 #search-input, #search-btn, #search-results,
// #new-patient-form(name_kr, name_local, sex, birth_year, weight)이 있어야 함
// 사용법: initPatientIntake({ onVisitCreated(visit) })

function initPatientIntake({ onVisitCreated }) {
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    const resultsEl = document.getElementById('search-results');
    const form = document.getElementById('new-patient-form');

    function piEscape(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function registerVisit(patientId, weight) {
        try {
            const body = { patient: patientId };
            if (weight) body.weight = parseFloat(weight);

            const visit = await apiFetch('/visits/', {
                method: 'POST',
                body: JSON.stringify(body),
            });

            onVisitCreated(visit);
        } catch (err) {
            alert(err.message);
        }
    }

    async function doSearch() {
        const search = searchInput.value.trim();
        if (!search) return;

        try {
            const data = await apiFetch(`/patients/?search=${encodeURIComponent(search)}&scope=current_mission`);

            if (data.results.length === 0) {
                resultsEl.innerHTML = '<p class="empty-text">검색 결과가 없습니다. 아래에서 신규 등록해주세요.</p>';
                return;
            }

            resultsEl.innerHTML = data.results.map(p => `
                <div class="patient-item">
                    <div>
                        <div class="patient-item-name">${piEscape(p.name_kr)}</div>
                        <div class="patient-item-meta">${p.sex === 'M' ? '남' : '여'} · ${p.birth_year}년생</div>
                    </div>
                    <button class="btn-primary btn-inline" type="button" data-patient-id="${p.id}">방문 등록</button>
                </div>
            `).join('');

            resultsEl.querySelectorAll('button[data-patient-id]').forEach(btn => {
                btn.addEventListener('click', () => {
                    openModal({
                        title: '방문 등록',
                        bodyHtml: `
                            <label class="field-label">체중 (kg, 선택)</label>
                            <input class="field-input" type="number" step="0.1" id="modal-weight-input">
                        `,
                        confirmLabel: '등록',
                        onConfirm: () => {
                            registerVisit(Number(btn.dataset.patientId), document.getElementById('modal-weight-input').value);
                        },
                    });
                });
            });
        } catch (err) {
            alert(err.message);
        }
    }

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        try {
            const patient = await apiFetch('/patients/', {
                method: 'POST',
                body: JSON.stringify({
                    name_kr: document.getElementById('name_kr').value,
                    name_local: document.getElementById('name_local').value,
                    sex: document.getElementById('sex').value,
                    birth_year: parseInt(document.getElementById('birth_year').value, 10),
                }),
            });

            await registerVisit(patient.id, document.getElementById('weight').value);
            form.reset();
        } catch (err) {
            alert(err.message);
        }
    });
}