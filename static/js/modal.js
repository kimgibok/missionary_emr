function openModal({ title, bodyHtml, confirmLabel = '확인', onConfirm }) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;

    const confirmBtn = document.getElementById('modal-confirm');
    confirmBtn.textContent = confirmLabel;

    const close = () => overlay.classList.remove('open');

    const newConfirmBtn = confirmBtn.cloneNode(true); // 이전 클릭 리스너 제거용
    confirmBtn.replaceWith(newConfirmBtn);
    newConfirmBtn.addEventListener('click', () => {
        const result = onConfirm();
        if (result !== false) close();
    });

    document.getElementById('modal-cancel').onclick = close;
    overlay.classList.add('open');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
}