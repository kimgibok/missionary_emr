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
        localStorage.clear();
        window.location.href = '/';
        throw new Error('로그인이 만료되었습니다. 다시 로그인해주세요.');
    }

    const data = await response.json();

    if (!response.ok) {
        throw new Error(formatApiError(data));
    }

    return data;
}