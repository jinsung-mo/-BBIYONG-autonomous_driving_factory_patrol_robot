// js/app.js

// 탭 전환 기능
const tabA = document.getElementById('tabA');
const tabB = document.getElementById('tabB');
const pgA = document.getElementById('pgA');
const pgB = document.getElementById('pgB');

function switchTab(target) {
    if (target === 'robot') {
        pgA.classList.remove('on');
        pgB.classList.add('on');
        tabA.classList.remove('on');
        tabB.classList.add('on');
    } else {
        pgA.classList.add('on');
        pgB.classList.remove('on');
        tabA.classList.add('on');
        tabB.classList.remove('on');
    }
}

tabA.addEventListener('click', () => switchTab('cctv'));
tabB.addEventListener('click', () => switchTab('robot'));

// 경보 알림 클릭 시 자동 로봇 탭 전환
const alistA = document.getElementById('alistA');
alistA.addEventListener('click', (e) => {
    // 로그 아이템을 클릭하면 로봇 탭으로 전환
    switchTab('robot');
});

// WASD 키보드 입력 및 시각적 피드백
const keyButtons = document.querySelectorAll('.btn-key');

function handleKeyEffect(key, isActive) {
    const btn = document.querySelector(`.btn-key[data-key="${key.toLowerCase()}"]`);
    if (btn) {
        if (isActive) btn.classList.add('active');
        else btn.classList.remove('active');
    }
}

// 키보드 이벤트
document.addEventListener('keydown', (e) => handleKeyEffect(e.key, true));
document.addEventListener('keyup', (e) => handleKeyEffect(e.key, false));

// 시계 기능
setInterval(() => {
    document.getElementById('clock').textContent = new Date().toLocaleString("ko-KR", { hour12: false });
}, 1000);
