const ROLE_PAGE_MAP = {
    '안내팀': '/info/',
    '접수팀': '/reception/',
    '진료팀': '/clinical/',
    '약국팀': '/pharmacy/',
};

document.addEventListener('DOMContentLoaded', () => {
    const missions = JSON.parse(localStorage.getItem('missions_to_select') || '[]');
    const listEl = document.getElementById('mission-list');

    listEl.innerHTML = missions.map((m, i) => `
        <button class="mission-option" data-index="${i}">
            <div class="mission-option-country">${m.country}</div>
            <div class="mission-option-role">${m.role}</div>
        </button>
    `).join('');

    listEl.querySelectorAll('.mission-option').forEach(btn => {
        btn.addEventListener('click', () => {
            const mission = missions[btn.dataset.index];
            localStorage.setItem('current_mission_id', mission.mission_id);
            localStorage.removeItem('missions_to_select');
            window.location.href = ROLE_PAGE_MAP[mission.role] || '/no-mission/';
        });
    });
});