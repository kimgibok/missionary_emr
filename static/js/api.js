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

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.detail || '요청 처리 중 오류가 발생했습니다.');
    }

    return data;
}