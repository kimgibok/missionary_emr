async function loadWaitCounts() {
    const el = document.getElementById('wait-counts');
    try {
        const data = await apiFetch('/visit-departments/wait-counts/');

        if (data.length === 0) {
            el.innerHTML = '<span style="color: var(--color-text-muted); font-size: 14px;">배정된 의사가 없습니다.</span>';
            return;
        }

        el.innerHTML = data.map(d => `
            <div class="wait-count-item">
                <span>${d.department_code ? `${d.department_code} · ` : ''}${d.doctor_name || '(이름없음)'}</span>
                <span class="count">${d.waiting_count}명 대기</span>
            </div>
        `).join('');
    } catch (err) {
        el.innerHTML = `<span style="color: var(--color-danger); font-size: 14px;">${err.message}</span>`;
    }
}

initPatientIntake({
    onVisitCreated: (visit) => {
        document.getElementById('ticket-result').innerHTML = `
            <div class="ticket">
                <div class="ticket-reg-no">${visit.reg_no}</div>
                <div class="ticket-label">등록번호</div>
            </div>
        `;
        loadWaitCounts();
    },
});

loadWaitCounts();