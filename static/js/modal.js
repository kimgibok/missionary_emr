// hideCancel: 보기만 하는 모달(이력 등)은 [취소] 없이 확인 버튼 하나만 둔다
function openModal({ title, bodyHtml, confirmLabel = '확인', onConfirm, hideCancel = false }) {
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

    const cancelBtn = document.getElementById('modal-cancel');
    cancelBtn.onclick = close;
    cancelBtn.hidden = hideCancel;
    overlay.classList.add('open');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
}
