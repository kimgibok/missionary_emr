// =====================================================
// 안내팀 페이지 - 의사별 대기 인원 + 환자 검색·신규 등록·방문 등록(patient-intake.js)
// escapeHtml, doctorLabel, byId는 common.js
// =====================================================

async function loadWaitCounts() {
    const el = byId('wait-counts');
    try {
        const data = await apiFetch('/visit-departments/wait-counts/');

        if (data.length === 0) {
            el.innerHTML = '<p class="empty-text">배정된 의사가 없습니다.</p>';
            return;
        }

        el.innerHTML = data.map((d) => `
            <div class="wait-count-item">
                <span>${doctorLabel(d.doctor_name || '(이름없음)', d.department_code)}</span>
                <span class="count">${d.waiting_count}명 대기</span>
            </div>
        `).join('');
    } catch (err) {
        el.innerHTML = `<p class="empty-text is-error">${escapeHtml(err.message)}</p>`;
    }
}

initPatientIntake({
    onVisitCreated: (visit) => {
        byId('ticket-result').innerHTML = `
            <div class="ticket">
                <div class="ticket-reg-no">${visit.reg_no}</div>
                <div class="ticket-label">등록번호</div>
            </div>
        `;
        loadWaitCounts();
    },
});

loadWaitCounts();
