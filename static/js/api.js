const API_BASE = '/api/v1';

function getToken() {
    return localStorage.getItem('token');
}

function setToken(token) {
    localStorage.setItem('token', token);
}

function clearToken() {
    localStorage.removeItem('token');
}

// 로그인할 때 저장하는 키 - 로그아웃·만료 때는 이것만 지운다.
// localStorage.clear()를 쓰면 약국 출력 PC의 [자동 출력]·용지 같은 기기 설정까지 지워진다.
const AUTH_KEYS = ['token', 'token_expires_at', 'user_name', 'is_superuser', 'current_mission_id', 'missions_to_select'];
const AUTH_EXPIRED_KEY = 'auth_expired';    // 만료로 로그인 화면에 왔는지 (sessionStorage, 로그인 화면이 크게 알린다)

function clearAuth() {
    AUTH_KEYS.forEach((key) => localStorage.removeItem(key));
}

// 토큰 만료까지 남은 분 (로그인할 때 서버가 준 expires_in 기준, 모르면 null)
function tokenMinutesLeft() {
    const expiresAt = Number(localStorage.getItem('token_expires_at'));
    return expiresAt ? Math.floor((expiresAt - Date.now()) / 60000) : null;
}

// 토큰이 만료돼 로그인 화면으로 보낸다
function goLoginExpired() {
    clearAuth();
    try {
        sessionStorage.setItem(AUTH_EXPIRED_KEY, '1');
    } catch {
        // 저장이 막힌 브라우저면 안내만 빠진다
    }
    window.location.href = '/';
}

function formatApiError(data) {
    if (data.detail) return data.detail;
    const messages = Object.entries(data).map(
        ([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(' ') : msgs}`
    );
    return messages.join('\n') || '요청 처리 중 오류가 발생했습니다.';
}

async function apiFetch(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    const token = getToken();
    if (token) {
        headers['Authorization'] = `Token ${token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

    if (response.status === 204) {
        return null;
    }

    // 로그인 요청이 아닌데 401이면 토큰 만료/무효 → 로그인 화면으로
    if (response.status === 401 && path !== '/auth/login/') {
        goLoginExpired();
        throw new Error('로그인이 만료되었습니다. 다시 로그인해주세요.');
    }

    // 500 오류 페이지처럼 JSON이 아닌 응답이 오면 null (그대로 json()하면 "Unexpected token '<'"가 화면에 뜬다)
    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }

    if (!response.ok) {
        throw new Error(data ? formatApiError(data) : `서버 오류가 발생했습니다. (${response.status}) 잠시 후 다시 시도해주세요.`);
    }
    if (data === null) {
        throw new Error('서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해주세요.');
    }

    return data;
}
// 파일 받기 (엑셀 등) - apiFetch처럼 토큰을 붙이고 401이면 로그인 화면으로, 오류는 메시지로 바꿔 던진다.
// 파일 이름은 서버의 Content-Disposition(filename*=UTF-8''...)을 쓰고, 없으면 fallbackName.
async function apiDownload(path, fallbackName) {
    const token = getToken();
    const response = await fetch(`${API_BASE}${path}`, {
        headers: token ? { Authorization: `Token ${token}` } : {},
    });

    if (response.status === 401) {
        goLoginExpired();
        throw new Error('로그인이 만료되었습니다. 다시 로그인해주세요.');
    }
    if (!response.ok) {
        let data = null;
        try {
            data = await response.json();
        } catch {
            data = null;
        }
        throw new Error(data ? formatApiError(data) : `서버 오류가 발생했습니다. (${response.status}) 잠시 후 다시 시도해주세요.`);
    }

    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
    const filename = match ? decodeURIComponent(match[1]) : fallbackName;

    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
