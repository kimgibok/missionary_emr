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
    clearToken();   // 로그인 시도 전에 기존 토큰 제거

    try {
        const data = await apiFetch('/auth/login/', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });

        setToken(data.token);
        localStorage.setItem('token_expires_at', String(Date.now() + data.expires_in * 1000));
        localStorage.setItem('user_name', data.name);
        localStorage.setItem('is_superuser', data.is_superuser);
        try {
            sessionStorage.removeItem(AUTH_EXPIRED_KEY);
        } catch {
            // 무시
        }

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

// 토큰 만료로 왔으면 크게 알린다 (api.js의 goLoginExpired가 표시를 남긴다)
try {
    document.getElementById('login-expired').hidden = sessionStorage.getItem(AUTH_EXPIRED_KEY) !== '1';
} catch {
    // 저장이 막힌 브라우저면 안내 없이 로그인 화면만
}
