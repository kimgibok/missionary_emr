const ROLE_NAV_ITEMS = [
    { href: '/info/', label: '안내팀' },
    { href: '/reception/', label: '접수팀' },
    { href: '/clinical/', label: '진료팀' },
    { href: '/pharmacy/', label: '약국팀' },
    { href: '/manage/', label: '관리자' },
];

function renderNav() {
    const isSuperuser = localStorage.getItem('is_superuser') === 'true';
    const navLinks = document.getElementById('nav-links');
    const navUser = document.getElementById('nav-user');

    navUser.textContent = localStorage.getItem('user_name') || '';

    if (!isSuperuser) {
        navLinks.innerHTML = '';
        return;
    }

    navLinks.innerHTML = ROLE_NAV_ITEMS.map(item => {
        const isActive = window.location.pathname === item.href;
        return `<a class="nav-link${isActive ? ' active' : ''}" href="${item.href}">${item.label}</a>`;
    }).join('');
}

function logout() {
    apiFetch('/auth/logout/', { method: 'POST' }).finally(() => {
        clearToken();
        localStorage.clear();
        window.location.href = '/';
    });
}

document.addEventListener('DOMContentLoaded', () => {
    renderNav();
    document.getElementById('nav-logout-btn').addEventListener('click', logout);
});