(() => {
  const form = document.getElementById('loginForm');
  const error = document.getElementById('error');
  const submit = document.getElementById('submit');
  const pass = document.getElementById('password');
  const eye = document.getElementById('togglePass');

  const API = String(window.VLXD_API || '').replace(/\/+$/, '');
  // Chỉ quay về trang trong app sau khi đăng nhập (không cho ?next= trỏ ra trang ngoài):
  // "#/2026/11" (giao diện GitHub Pages) hoặc "/…" (giao diện chạy thẳng từ máy chủ).
  const next = new URLSearchParams(location.search).get('next') || '';
  const target = /^#\/[\w/-]*$/.test(next) ? `./${next}` : /^\/(?!\/)/.test(next) && !next.startsWith('/login') ? next : './';

  eye.onclick = () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
    pass.focus();
  };

  const showError = (text) => {
    error.textContent = text;
    error.hidden = !text;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const username = form.username.value.trim();
    if (!username || !pass.value) return showError('Nhập tên đăng nhập và mật khẩu.');
    submit.disabled = true;
    submit.textContent = 'Đang đăng nhập…';
    showError('');
    try {
      const res = await fetch(`${API}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: pass.value, remember: form.remember.checked }),
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
      // Duy trì: giữ mã phiên qua các lần mở trình duyệt (localStorage); không: chỉ trong phiên trình duyệt này.
      try {
        localStorage.removeItem('vlxd_token');
        sessionStorage.removeItem('vlxd_token');
        (form.remember.checked ? localStorage : sessionStorage).setItem('vlxd_token', data.token);
      } catch {}
      // Phần #/... (thư mục / phiếu đang mở) không gửi lên server nên vẫn nằm trên địa chỉ trang đăng nhập: giữ lại.
      location.replace(target.includes('#') ? target : target + location.hash);
    } catch (err) {
      showError(err.message === 'Failed to fetch' ? 'Không kết nối được máy chủ.' : err.message);
      pass.select();
      submit.disabled = false;
      submit.textContent = 'Đăng nhập';
    }
  };
})();
