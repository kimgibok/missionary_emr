const ROLE_PAGE_MAP = {
    '안내팀': '/info/',
    '접수팀': '/reception/',
    '진료팀': '/clinical/',
    '약국팀': '/pharmacy/',
};

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('error-message');
    const submitBtn = e.target.querySelector('button[type="submit"]');

    errorEl.textContent = '';
    submitBtn.disabled = true;
    clearToken();   // 이 줄 추가 — 로그인 시도 전에 기존 토큰 제거

    try {
        const data = await apiFetch('/auth/login/', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });

        setToken(data.token);
        localStorage.setItem('user_name', data.name);
        localStorage.setItem('is_superuser', data.is_superuser);

        routeAfterLogin(data);
    } catch (err) {
        errorEl.textContent = err.message;
        submitBtn.disabled = false;
    }
});

function routeAfterLogin(data) {
    if (data.is_superuser) {
        window.location.href = '/manage/';
        return;
    }

    const missions = data.current_missions;

    if (missions.length === 0) {
        window.location.href = '/no-mission/';
    } else if (missions.length === 1) {
        localStorage.setItem('current_mission_id', missions[0].mission_id);
        window.location.href = ROLE_PAGE_MAP[missions[0].role] || '/no-mission/';
    } else {
        localStorage.setItem('missions_to_select', JSON.stringify(missions));
        window.location.href = '/select-mission/';
    }
}