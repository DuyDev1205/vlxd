/* VLXD Thanh Duy — giao diện nhập phiếu bán hàng */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(typeof tag === 'string' ? document.createElement(tag) : tag, props); // tag: tên thẻ hoặc phần tử có sẵn
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};

const state = {
  meta: null,
  date: null,
  data: null, // { period, exists, prev, next, customers, drive, sync }
  selectedId: null,
  entryDate: null, // ngày bán đang chọn ở dòng nhập mới
  entryHidden: store('hideEntry') === '1', // đã bấm × ẩn hàng nhập mới
  products: [],
  customers: [],
  folder: { year: null, month: null }, // thư mục đang xem ở màn hình Phiếu
  openLine: null, // điện thoại: id dòng hàng đang mở thẻ sửa (các dòng khác thu gọn như hoá đơn)
  retail: false, // đang ở tab Bán lẻ (cuốn bán lẻ của tháng: mỗi lần bán 1 sheet)
  draft: { id: 0, name: '', lines: [], debt: 0, total: 0, grandTotal: 0, draft: true }, // phiếu bán lẻ đang gõ, chưa lưu
};

/* ---------- Helpers ---------- */

// Máy chủ API (config.js). Trống = cùng địa chỉ với giao diện.
const API = String(window.VLXD_API || '').replace(/\/+$/, '');
const apiUrl = (path) => API + path;
const TOKEN_KEY = 'vlxd_token';
function authToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}
/** Hết phiên / chưa đăng nhập: xoá mã phiên, sang trang đăng nhập, xong quay lại đúng chỗ đang xem. */
function toLogin() {
  clearToken();
  location.replace(`login.html?next=${encodeURIComponent(location.hash)}`);
  throw new Error('Phiên đăng nhập đã hết, đang chuyển tới trang đăng nhập…');
}
/** fetch tới API, kèm mã phiên trong header (không dùng cookie: giao diện và máy chủ khác tên miền). */
async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 401) toLogin();
  return res;
}

const inflight = new Set(); // các lệnh ghi đang chạy, Ctrl+S đợi xong mới lưu lên Drive

function api(method, url, body) {
  const run = request(method, url, body);
  if (method !== 'GET') {
    inflight.add(run);
    run.catch(() => {}).finally(() => inflight.delete(run));
  }
  return run;
}

async function request(method, url, body) {
  const res = await apiFetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw Object.assign(new Error(data?.error || `Lỗi ${res.status}`), data ?? {});
  return data;
}

const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const qf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 });
const money = (n) => (n ? nf.format(n) : '0');
const moneyInput = (n) => (n ? nf.format(n) : '');
const qtyInput = (n) => (n ? qf.format(n) : '');

/** "95k" → 95000, "3tr" → 3000000, "1,5tr" → 1500000, "95.000" → 95000 */
function parseMoney(s) {
  const t = String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return 0;
  const m = /^([\d.,]+)(k|n|ng|nghìn|ngàn|tr|triệu|m)$/.exec(t);
  if (m) {
    const base = parseFloat(m[1].replace(',', '.')) || 0;
    return Math.round(base * (/^(tr|triệu|m)$/.test(m[2]) ? 1e6 : 1e3));
  }
  return Number(t.replace(/\D/g, '')) || 0;
}

function parseQty(s) {
  const t = String(s ?? '').trim();
  if (!t) return 0;
  // "1.000" (nghìn) vs "14,5" / "14.5" (thập phân)
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ''));
  return parseFloat(t.replace(',', '.')) || 0;
}

const isoDate = (d) => d.toISOString().slice(0, 10);
const toUTC = (iso) => new Date(`${iso}T00:00:00Z`);
const dm = (iso) => {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
};
const dmy = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

/* ---------- Lịch chọn ngày (thay lịch mặc định của trình duyệt) ---------- */

const VN_DOW = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
let calendar = null; // { box, anchor }

function closeCalendar() {
  if (!calendar) return;
  calendar.box.remove();
  calendar.anchor.setAttribute('aria-expanded', 'false');
  calendar = null;
}

/**
 * Mở lịch dưới `anchor`. Tuần bắt đầu Thứ 2; `marks` là các ngày được chấm (vd. ngày đã có phiếu).
 * Bấm lại vào anchor thì đóng.
 */
function openCalendar(anchor, value, onPick, { marks = new Set(), markLabel = '' } = {}) {
  if (calendar?.anchor === anchor) return closeCalendar();
  closeCalendar();
  let view = (value || state.meta.today).slice(0, 7); // 'YYYY-MM' đang xem
  const box = el('div', { className: 'calendar', role: 'dialog', ariaLabel: 'Chọn ngày' });
  const pick = (d) => {
    closeCalendar();
    onPick(d);
  };

  const render = () => {
    const [y, m] = view.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const start = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * 864e5);
    const days = Array.from({ length: 42 }, (_, i) => isoDate(new Date(start.getTime() + i * 864e5)));
    const shift = (n) => {
      view = isoDate(new Date(Date.UTC(y, m - 1 + n, 1))).slice(0, 7);
      render();
    };
    box.replaceChildren(
      el('div', { className: 'cal-head' },
        el('button', { type: 'button', className: 'cal-nav', ariaLabel: 'Tháng trước', innerHTML: '<svg viewBox="0 0 20 20"><path d="M12.5 5l-5 5 5 5"/></svg>', onclick: () => shift(-1) }),
        el('div', { className: 'cal-title' }, el('strong', { textContent: `Tháng ${m}` }), el('span', { textContent: y })),
        el('button', { type: 'button', className: 'cal-nav', ariaLabel: 'Tháng sau', innerHTML: '<svg viewBox="0 0 20 20"><path d="M7.5 5l5 5-5 5"/></svg>', onclick: () => shift(1) })),
      el('div', { className: 'cal-grid' },
        ...VN_DOW.map((d, i) => el('span', { className: `cal-dow${i === 6 ? ' sun' : ''}`, textContent: d })),
        ...days.map((d, i) =>
          el('button', {
            type: 'button',
            className: ['cal-day', d.slice(0, 7) !== view && 'out', i % 7 === 6 && 'sun', d === state.meta.today && 'today', d === value && 'selected', marks.has(d) && 'mark']
              .filter(Boolean)
              .join(' '),
            textContent: Number(d.slice(8)),
            title: `${dmy(d)}${marks.has(d) && markLabel ? ` · ${markLabel}` : ''}`,
            onclick: () => pick(d),
          }),
        )),
      el('div', { className: 'cal-foot' },
        marks.size && markLabel ? el('span', { className: 'cal-legend' }, el('i'), markLabel) : el('span'),
        el('button', { type: 'button', className: 'cal-today', textContent: 'Hôm nay', onclick: () => pick(state.meta.today) })),
    );
  };

  render();
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8));
  const below = r.bottom + 6;
  const top = below + box.offsetHeight > innerHeight - 8 && r.top - box.offsetHeight - 6 > 8 ? r.top - box.offsetHeight - 6 : below;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');
  calendar = { box, anchor };
}

/**
 * Ngày gõ tay trong ô NGÀY → 'YYYY-MM-DD', '' (xoá trống) hoặc undefined (sai).
 * "28/10", "28-10-2026", "28" (tháng của phiếu). Không ghi năm/tháng mà ra sau ngày phiếu thì lùi về năm/tháng trước.
 */
function parseDayInput(text) {
  const t = text.trim();
  if (!t) return '';
  const m = /^(\d{1,2})(?:[/.\- ](\d{1,2})(?:[/.\- ](\d{2}|\d{4}))?)?$/.exec(t);
  if (!m) return undefined;
  const end = state.data.period.end;
  const day = Number(m[1]);
  let y = Number(end.slice(0, 4));
  const mo = Number(m[2] ?? end.slice(5, 7));
  if (m[3]) y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const make = (yy, mm) => new Date(Date.UTC(yy, mm - 1, day));
  let d = make(y, mo);
  if (!m[3] && isoDate(d) > end) d = m[2] ? make(y - 1, mo) : make(y, mo - 1);
  return mo >= 1 && mo <= 12 && d.getUTCDate() === day ? isoDate(d) : undefined;
}

/** Ô ngày: gõ dd/mm hoặc xoá trống; nút lịch bên cạnh để chọn trên lịch. */
function dateCell(value, { repeat = false, onChange }) {
  const input = el('input', {
    className: `date-input${repeat ? ' repeat' : ''}`,
    value: value ? dm(value) : '',
    placeholder: '--/--',
    autocomplete: 'off',
    ariaLabel: 'Ngày bán',
  });
  input.dataset.col = 0;
  const commit = (v) => {
    input.value = v ? dm(v) : '';
    input.classList.remove('repeat');
    if (v === value) return;
    value = v;
    onChange(v);
  };
  input.onchange = () => {
    const v = parseDayInput(input.value);
    if (v === undefined) {
      toast(`Ngày "${input.value}" không hợp lệ, gõ dạng 28/10`, { error: true });
      input.value = value ? dm(value) : '';
    } else commit(v);
  };
  const btn = el('button', {
    type: 'button',
    className: 'date-pick',
    tabIndex: -1,
    title: 'Chọn trên lịch',
    ariaLabel: 'Chọn ngày trên lịch',
    innerHTML: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>',
  });
  btn.onclick = () => openCalendar(btn, value, (v) => (commit(v), input.focus()));
  return el('span', { className: 'date-cell' }, input, btn);
}

/** Hàng nút chọn năm (thay cho dropdown); năm đang chọn lưu ở box.dataset.year. */
function renderYearChips(box, years, selected, onPick) {
  box.dataset.year = selected;
  box.replaceChildren(
    ...years.map((y) =>
      el('button', {
        type: 'button',
        className: `year-chip${y === selected ? ' active' : ''}`,
        textContent: y,
        onclick: () => {
          if (Number(box.dataset.year) === y) return;
          renderYearChips(box, years, y, onPick);
          onPick(y);
        },
      }),
    ),
  );
}

function toast(message, { error = false, action, onAction, timeout = 4000 } = {}) {
  const t = el('div', { className: `toast${error ? ' error' : ''}` }, el('span', { textContent: message }));
  if (action) {
    t.append(el('button', { textContent: action, onclick: () => (onAction(), t.remove()) }));
    timeout = Math.max(timeout, 8000);
  }
  $('#toasts').append(t);
  setTimeout(() => t.remove(), timeout);
}

const fail = (e) => toast(e.message || String(e), { error: true });

const ICON_TRASH = '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10h6.6L14 6M8.5 9v4.5M11.5 9v4.5"/></svg>';
const ICON_ASK = '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.6a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 1.9-2.2 3.2M10 14.4v.1"/></svg>';

/**
 * Hộp xác nhận thay cho confirm() của trình duyệt. Trả về Promise<boolean> (true = bấm nút đồng ý).
 * Enter = đồng ý, Esc hoặc bấm ra ngoài = huỷ.
 */
function confirmDialog({ title, message = '', ok = 'Đồng ý', danger = false }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { className: 'modal confirm-modal' });
    const close = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    const okBtn = el('button', { type: 'button', className: `btn ${danger ? 'danger' : 'primary'}`, textContent: ok, onclick: () => close(true) });
    dlg.append(
      el('div', { className: `confirm-icon${danger ? ' danger' : ''}`, innerHTML: danger ? ICON_TRASH : ICON_ASK }),
      el('div', { className: 'confirm-body' },
        el('h3', { textContent: title }),
        message ? el('p', { textContent: message }) : ''),
      el('div', { className: 'modal-actions' },
        el('button', { type: 'button', className: 'btn ghost', textContent: 'Huỷ', onclick: () => close(false) }),
        okBtn),
    );
    dlg.addEventListener('cancel', (e) => (e.preventDefault(), close(false)));
    dlg.addEventListener('mousedown', (e) => {
      const r = dlg.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (e.target === dlg && outside) close(false);
    });
    document.body.append(dlg);
    dlg.showModal();
    okBtn.focus();
  });
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

/* ---------- Drive ---------- */

const GOOGLE_ICON =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.8-2.1 5.1-4.4 6.7v5.6h7.1c4.2-3.8 6.6-9.5 6.6-16.3z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.6c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.8C8.1 41.1 15.5 46 24 46z"/><path fill="#FBBC05" d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2V14H4.5C3 17 2.2 20.4 2.2 24s.8 7 2.3 10l7.3-5.8z"/><path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.5 2 8.1 6.9 4.5 14l7.3 5.8c1.7-5.2 6.5-9 12.2-9z"/></svg>';

function renderDrive() {
  const box = $('#drive');
  const d = state.meta.drive;
  box.replaceChildren();
  if (d.connected) {
    box.append(
      el('span', { className: 'drive-pill', title: 'Google Drive đã kết nối', textContent: d.email ? `Drive · ${d.email}` : 'Đã kết nối Drive' }),
      el('button', {
        className: 'link-btn',
        textContent: 'Ngắt kết nối',
        onclick: async () => {
          const yes = await confirmDialog({
            title: 'Ngắt kết nối Google Drive?',
            message: 'File đã lưu trên Drive vẫn giữ nguyên. Muốn lưu tiếp thì kết nối lại.',
            ok: 'Ngắt kết nối',
            danger: true,
          });
          if (!yes) return;
          await api('POST', '/api/drive/disconnect').catch(fail);
          await loadMeta();
          driveFilesCache.clear();
          browser.driveYears = null;
          if (state.data) renderStatus();
          if (!$('#view-files').hidden) renderFiles();
        },
      }),
    );
    return;
  }
  const btn = el('button', { className: 'btn google sm' });
  btn.innerHTML = `${GOOGLE_ICON}Kết nối Google Drive`;
  btn.onclick = () => {
    if (d.configured) connectDrive();
    else {
      $('#redirectUri').textContent = d.redirectUri;
      $('#driveSetup').showModal();
    }
  };
  box.append(btn);
}

/** Sang trang đăng nhập Google để cấp quyền Drive; xong Google quay về app. */
async function connectDrive() {
  try {
    const { url } = await api('POST', '/api/drive/auth-url');
    if (!/^https:\/\/accounts\.google\.com\//.test(url)) throw new Error('Link đăng nhập Google không hợp lệ');
    location.href = url;
  } catch (e) {
    fail(e);
  }
}

/** Tải file Excel của phiếu (cần mã phiên nên tải bằng fetch rồi lưu, không dùng link trực tiếp). */
async function downloadExport() {
  const res = await apiFetch(`/api/export/${state.date}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Lỗi ${res.status}`);
  const cd = res.headers.get('Content-Disposition') || '';
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] || /filename="?([^";]+)"?/i.exec(cd)?.[1] || `Phieu ${state.date}.xlsx`);
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- Kéo thả đổi thứ tự sheet (khách trong phiếu) ---------- */

const GRIP_ICON = '<svg viewBox="0 0 12 20"><circle cx="3.5" cy="5" r="1.4"/><circle cx="8.5" cy="5" r="1.4"/><circle cx="3.5" cy="10" r="1.4"/><circle cx="8.5" cy="10" r="1.4"/><circle cx="3.5" cy="15" r="1.4"/><circle cx="8.5" cy="15" r="1.4"/></svg>';

/**
 * Chuột: giữ và kéo cả ô khách. Cảm ứng: kéo bằng tay nắm ⋮⋮ (vuốt chỗ khác vẫn cuộn danh sách bình thường).
 * Thả ra thì lưu thứ tự mới; phiếu trên Drive xếp lại các sheet theo.
 */
function enableSheetDrag(ul) {
  let drag = null;
  const begin = () => {
    drag.active = true;
    drag.li.classList.add('dragging');
    ul.classList.add('sorting');
    closeCtxMenu();
    navigator.vibrate?.(10);
  };
  ul.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-id]');
    if (state.retail || !li || e.button !== 0 || e.target.closest('.c-remove')) return; // bán lẻ xếp theo thời gian, không kéo
    const grip = e.target.closest('.c-grip');
    if (e.pointerType !== 'mouse' && !grip) return;
    drag = { li, x: e.clientX, y: e.clientY, id: e.pointerId, active: false, horizontal: getComputedStyle(ul).display === 'flex' };
    if (grip) {
      e.preventDefault();
      begin();
    }
  });
  addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      begin();
    }
    e.preventDefault();
    const pos = drag.horizontal ? e.clientX : e.clientY;
    const items = [...ul.querySelectorAll('li[data-id]')].filter((x) => x !== drag.li);
    const before = items.find((it) => {
      const r = it.getBoundingClientRect();
      return pos < (drag.horizontal ? r.left + r.width / 2 : r.top + r.height / 2);
    });
    if (before) {
      if (drag.li.nextElementSibling !== before) ul.insertBefore(drag.li, before);
    } else if (items.length && items[items.length - 1].nextElementSibling !== drag.li) {
      items[items.length - 1].after(drag.li);
    }
    // điện thoại: dải khách kéo ngang, kéo sát mép thì tự cuộn
    if (drag.horizontal) {
      const r = ul.getBoundingClientRect();
      if (e.clientX < r.left + 30) ul.scrollLeft -= 12;
      else if (e.clientX > r.right - 30) ul.scrollLeft += 12;
    }
  }, { passive: false });
  const end = async (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    d.li.classList.remove('dragging');
    ul.classList.remove('sorting');
    // thả xong trình duyệt còn bắn "click": không tính là bấm chọn khách
    ul.dataset.justDragged = '1';
    setTimeout(() => delete ul.dataset.justDragged, 0);
    const ids = [...ul.querySelectorAll('li[data-id]')].map((x) => Number(x.dataset.id));
    if (ids.join() === periodCustomers().filter((c) => !c.draft).map((c) => c.id).join()) return;
    try {
      await api('PUT', `/api/phieu/${state.data.period.end}/order`, { ids });
      await loadPeriod({ keepRows: true });
      toast('Đã đổi thứ tự sheet');
    } catch (err) {
      fail(err);
      renderSidebar();
    }
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  ul.addEventListener('click', (e) => {
    if (ul.dataset.justDragged) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

/* ---------- Menu chuột phải của sheet (khách trong phiếu) ---------- */

let ctxMenu = null;
function closeCtxMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}

/** Nhấn giữ ~0,5 giây trên màn hình cảm ứng (iPhone không có chuột phải). */
function onLongPress(node, fn) {
  let timer = null;
  let start = null;
  node.addEventListener('touchstart', (e) => {
    if (e.target.closest('.c-grip')) return; // đang kéo đổi thứ tự, không mở menu
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      node.dataset.longpress = '1';
      navigator.vibrate?.(15);
      fn(start.x, start.y);
    }, 480);
  }, { passive: true });
  const cancel = () => clearTimeout(timer);
  node.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  }, { passive: true });
  node.addEventListener('touchend', cancel);
  node.addEventListener('touchcancel', cancel);
  // nhấn giữ xong thả tay: không tính là bấm chọn khách
  node.addEventListener('click', (e) => {
    if (node.dataset.longpress) {
      delete node.dataset.longpress;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

const MENU_ICONS = {
  copy: '<svg viewBox="0 0 20 20"><rect x="6.5" y="6.5" width="10" height="10" rx="2"/><path d="M13.5 6.5v-2a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5"/></svg>',
  text: '<svg viewBox="0 0 20 20"><path d="M6 3.5h8l2.5 2.5v10.5h-10.5zM8.5 9h6M8.5 12h6M8.5 15h3.5"/></svg>',
  print: '<svg viewBox="0 0 20 20"><path d="M5.5 7.5V2.5h9v5M5.5 14.5h-2v-7h13v7h-2M5.5 11.5h9v6h-9z"/></svg>',
  remove: '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"/></svg>',
};

function openSheetMenu(c, x, y) {
  closeCtxMenu();
  const item = (icon, label, fn, cls = '') => {
    const b = el('button', { type: 'button', role: 'menuitem', className: cls });
    b.innerHTML = MENU_ICONS[icon];
    b.append(el('span', { textContent: label }));
    b.onclick = () => {
      closeCtxMenu();
      fn();
    };
    return b;
  };
  ctxMenu = el('div', { className: 'menu ctx-menu', role: 'menu' },
    el('div', { className: 'ctx-title', textContent: customerLabel(c) }),
    state.retail ? null : item('copy', 'Sao chép sheet…', () => openCopyDialog(c)),
    item('text', 'Chép nội dung', () => copySheetText(c).catch(fail)),
    item('print', 'In phiếu', () => printPhieu({ ids: [c.id], summary: false }).catch(fail)),
    el('hr'),
    item('remove', 'Xoá khỏi phiếu', () => removeFromPhieu(c), 'danger'));
  document.body.append(ctxMenu);
  // đặt menu tại chỗ bấm, không tràn ra ngoài màn hình
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  ctxMenu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  ctxMenu.querySelector('button').focus();
}

/** Bảng hàng dạng chữ (cột cách bằng Tab): dán vào Excel thành cột, dán Zalo vẫn dễ đọc. */
async function copySheetText(c) {
  const rows = [['STT', 'Ngày', 'Tên hàng', 'ĐVT', 'SL', 'Đơn giá', 'Thành tiền']];
  c.lines.forEach((l, i) => rows.push([i + 1, l.date ? dm(l.date) : '', sheetItemName(l), l.unit, qtyInput(l.qty), money(l.price), money(Math.round(l.qty * l.price))]));
  const text = [
    `${customerLabel(c)} · Phiếu ${dmy(state.data.period.end)}`,
    ...rows.map((r) => r.join('\t')),
    `Tổng cộng\t\t\t\t\t\t${money(c.total ?? c.lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0))}`,
    ...(c.debt ? [`Nợ cũ\t\t\t\t\t\t${money(c.debt)}`] : []),
    `TỔNG TIỀN\t\t\t\t\t\t${money(c.grandTotal)}`,
  ].join('\n');
  await navigator.clipboard.writeText(text);
  toast(`Đã chép ${c.lines.length} dòng · dán vào Zalo / Excel`);
}

let copyFrom = null; // khách (sheet) đang sao chép
let copyDate = null; // ngày phiếu nhận

function openCopyDialog(c) {
  if (!c.lines.length) return toast('Sheet này chưa có dòng hàng nào để sao chép', { error: true });
  copyFrom = c;
  // sang phiếu khác: mặc định phiếu hôm nay (nếu đang xem phiếu khác ngày hôm nay)
  copyDate = state.meta.today !== state.data.period.end ? state.meta.today : state.data.period.end;
  $('#copySub').textContent = `${customerLabel(c)} · ${c.lines.length} dòng`;
  $('#copyForm').where.value = 'same';
  $('#copyName').value = '';
  $('#copyKeepDates').checked = true;
  $('#copyError').hidden = true;
  $('#copyNames').replaceChildren(...state.customers.filter((x) => x.name && x.id !== c.id).map((x) => el('option', { value: x.name })));
  syncCopyForm();
  $('#copyDialog').showModal();
  $('#copyName').focus();
}

function syncCopyForm() {
  const other = $('#copyForm').where.value === 'other';
  $('#copyDateField').hidden = !other;
  $('#copyDateText').textContent = dmy(copyDate);
  // sang phiếu khác: mặc định chép cho chính khách đó (để trống tên); cùng phiếu: bắt buộc khách khác
  $('#copyName').placeholder = other ? `Để trống = ${customerLabel(copyFrom)}` : 'Tên khách';
  if (!other) $('#copyKeepDates').checked = true;
}

async function submitCopy(e) {
  e.preventDefault();
  const other = $('#copyForm').where.value === 'other';
  const toDate = other ? copyDate : state.data.period.end;
  const toName = $('#copyName').value.trim();
  const err = $('#copyError');
  if (!other && !toName) {
    err.textContent = 'Nhập tên khách khác.';
    err.hidden = false;
    return $('#copyName').focus();
  }
  $('#copyGo').disabled = true;
  try {
    const r = await api('POST', `/api/phieu/${state.data.period.end}/customers/${copyFrom.id}/copy`, {
      toDate,
      toName,
      keepDates: $('#copyKeepDates').checked,
    });
    $('#copyDialog').close();
    await loadCustomers();
    if (r.to !== state.data.period.end) {
      state.selectedId = r.customer.id;
      store('lastCustomer', String(r.customer.id));
      location.hash = `#/phieu/${r.to}`;
    } else {
      await loadPeriod();
      selectCustomer(r.customer.id);
    }
    toast(`Đã chép ${r.lines} dòng sang ${r.customer.name || 'khách mới'}${r.to === state.data.period.end ? '' : ` · ${dm(r.to)}`}`);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $('#copyGo').disabled = false;
  }
}

/* ---------- In PDF khổ A5 (điện thoại: trình duyệt di động luôn in A4 nếu in thẳng trang web) ---------- */

const USE_PDF_PRINT = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
let pdfReady = null; // { url, file }

async function printPdf(job) {
  const ids = job.ids ?? [];
  if (!ids.length && !job.summary) return void toast('Chưa có phiếu nào để in', { error: true });
  const done = showBusy('Đang tạo phiếu A5', 'Dựng PDF đúng khổ A5 để in từ điện thoại');
  try {
    const res = await apiFetch(`/api/print/${state.data.period.end}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, summary: Boolean(job.summary) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Lỗi ${res.status}`);
    const blob = await res.blob();
    const names = periodCustomers().filter((c) => ids.includes(c.id)).map((c) => c.label || customerLabel(c));
    const fileName = `${state.data.period.title}${names.length === 1 ? ` - ${names[0]}` : ''}.pdf`.replace(/[\\/:*?"<>|]/g, ' ');
    if (pdfReady) URL.revokeObjectURL(pdfReady.url);
    pdfReady = { url: URL.createObjectURL(blob), file: new File([blob], fileName, { type: 'application/pdf' }) };
    $('#pdfInfo').textContent = [names.length ? names.join(', ') : '', job.summary ? 'kèm phiếu tổng kết' : ''].filter(Boolean).join(' · ');
    $('#pdfDialog').showModal();
  } catch (e) {
    fail(e);
  } finally {
    done();
  }
}

/* ---------- Tự đồng bộ: máy khác sửa thì máy này tự cập nhật ---------- */

let knownRev = 0;
let syncPending = false;
let lastTyping = 0;
// Đang gõ dở (vừa gõ trong 3 giây) / đang mở hộp thoại / đang xem gợi ý: chờ xong mới cập nhật để không mất chữ
const isBusy = () => Boolean(document.querySelector('dialog[open]')) || Date.now() - lastTyping < 3000 || !$('#suggest').hidden || Boolean(ctxMenu);

async function pollChanges() {
  if (document.hidden) return;
  try {
    const r = await api('GET', `/api/rev?since=${knownRev}`);
    if (knownRev && r.others) syncPending = true;
    knownRev = r.rev;
  } catch {
    return; // mất mạng: lần sau thử lại
  }
  if (syncPending && !isBusy()) applyRemoteChanges().catch(() => {});
}

async function applyRemoteChanges() {
  syncPending = false;
  const view = document.querySelector('.view:not([hidden])')?.id;
  const y = scrollY;
  if (view === 'view-invoice' && state.data) {
    await loadPeriod();
    if (!current() && state.data.customers[0]) selectCustomer(state.data.customers[0].id);
  } else if (view === 'view-files') {
    [browser.app, browser.retail] = await Promise.all([api('GET', '/api/phieus'), api('GET', '/api/retail/books').catch(() => [])]);
    renderFiles();
  } else if (view === 'view-products') {
    await loadProducts();
    renderProducts();
  } else if (view === 'view-customers') {
    await loadCustomers();
    renderCustomers();
  }
  scrollTo(0, y);
  toast('Đã cập nhật thay đổi từ máy khác', { timeout: 2500 });
}

/* ---------- Tự lên bản mới (app thêm vào màn hình chính iPhone không tự tải lại trang) ---------- */

const BUILD = document.querySelector('meta[name="vlxd-build"]')?.content ?? ''; // trống = chạy thử trên máy
let updating = false;

async function checkVersion() {
  if (!BUILD || updating || document.hidden) return;
  try {
    // ?t= để bỏ qua bộ nhớ đệm của GitHub Pages (giữ file ~10 phút)
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { build } = await res.json();
    if (!build || build === BUILD) return;
    if (isBusy()) return void setTimeout(checkVersion, 5000); // đang gõ: đợi gõ xong
    updating = true;
    toast('Có bản mới, đang cập nhật…', { timeout: 1500 });
    setTimeout(() => location.replace(`./?v=${encodeURIComponent(build)}${location.hash}`), 600);
  } catch {
    /* mất mạng: lần sau kiểm tra lại */
  }
}

function startAutoSync() {
  setInterval(pollChanges, 4000);
  setInterval(checkVersion, 5 * 60e3);
  checkVersion();
  // Mở lại app từ màn hình chính / quay lại tab: đồng bộ + kiểm tra bản mới ngay
  const resume = () => {
    if (document.hidden) return;
    pollChanges();
    checkVersion();
  };
  addEventListener('pageshow', resume);
  addEventListener('focus', resume);
  addEventListener('online', resume);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    resume();
    // để máy mở qua đêm: ngày hôm nay mới cho tab Bán lẻ
    api('GET', '/api/meta').then((m) => (state.meta.today = m.today)).catch(() => {});
  });
  // gõ xong (rời ô nhập) mà đang có thay đổi chờ: cập nhật luôn
  document.addEventListener('focusout', () => setTimeout(() => syncPending && !isBusy() && applyRemoteChanges().catch(() => {}), 300));
}

/* ---------- Điện thoại: bàn phím, nút nổi "Thêm hàng" ---------- */

/** Phần màn hình còn nhìn thấy (bàn phím iPhone che bớt mà innerHeight không đổi). */
const visibleBottom = () => (window.visualViewport ? visualViewport.offsetTop + visualViewport.height : innerHeight);

function goToEntry() {
  if ($('#entryRow').hidden) showEntryRow(true);
  const input = $('#eItem');
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function setupMobile() {
  const vv = window.visualViewport;
  const onViewport = () => {
    // bàn phím mở: ẩn thanh tab dưới + nút nổi cho đỡ chật, gợi ý bám theo ô đang gõ
    const kb = vv ? innerHeight - vv.height > 140 : false;
    document.body.classList.toggle('kb-open', kb);
    positionSuggest();
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', positionSuggest);

  $('#fabAdd').onclick = goToEntry;
  $('#fabTop').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });
  // nút nổi chỉ hiện ở trang phiếu trên điện thoại, khi hàng nhập đang khuất
  let entryVisible = false;
  new IntersectionObserver(([e]) => {
    entryVisible = e.isIntersecting;
    updateFab();
  }).observe($('#entryRow'));
  const updateFab = () => {
    const show = matchMedia('(max-width: 640px)').matches && !$('#view-invoice').hidden && Boolean(state.data && current()) && !entryVisible;
    $('#fabWrap').hidden = !show;
    $('#fabTop').hidden = scrollY < 500;
  };
  addEventListener('scroll', updateFab, { passive: true });
  addEventListener('hashchange', () => setTimeout(updateFab, 300));
  document.addEventListener('click', () => setTimeout(updateFab, 0));
}

/* ---------- Tài khoản: thiết bị đang đăng nhập ---------- */

/** "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 …) … Safari" → { name: 'iPhone · Safari', kind: 'phone' } */
function describeDevice(ua = '') {
  const os =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua)) ? 'iPad'
    : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Điện thoại Android' : 'Máy tính bảng Android')
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux'
    : 'Thiết bị lạ';
  const browser =
    /Headless|PhantomJS|Puppeteer|Playwright|bot|crawler|spider/i.test(ua) ? 'Công cụ tự động'
    : /Zalo/i.test(ua) ? 'Zalo'
    : /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook'
    : /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /CocCoc|coc_coc/i.test(ua) ? 'Cốc Cốc'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl|python|node|axios|Go-http/i.test(ua) ? 'Công cụ tự động'
    : '';
  const kind = /iPhone|Android.*Mobile|Mobile.*Android/.test(ua) ? 'phone' : /iPad|Android/.test(ua) ? 'tablet' : 'desktop';
  return { name: browser ? `${os} · ${browser}` : os, kind };
}

const DEVICE_ICONS = {
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  tablet: '<svg viewBox="0 0 24 24"><rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  desktop: '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/></svg>',
};

/** "vừa xong", "5 phút trước", "3 giờ trước", "hôm qua 14:20", "12/11 08:05" */
function timeAgo(ms) {
  const d = Date.now() - ms;
  if (d < 90e3) return 'vừa xong';
  if (d < 3600e3) return `${Math.round(d / 60e3)} phút trước`;
  if (d < 6 * 3600e3) return `${Math.round(d / 3600e3)} giờ trước`;
  const t = new Date(ms);
  const hm = t.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yest = new Date(Date.now() - 86400e3);
  if (t.toDateString() === today.toDateString()) return `hôm nay ${hm}`;
  if (t.toDateString() === yest.toDateString()) return `hôm qua ${hm}`;
  return `${String(t.getDate()).padStart(2, '0')}/${String(t.getMonth() + 1).padStart(2, '0')}${t.getFullYear() === today.getFullYear() ? '' : `/${t.getFullYear()}`} ${hm}`;
}

async function openAccount() {
  const dlg = $('#accountDialog');
  if (!dlg.open) dlg.showModal();
  $('#deviceList').replaceChildren(el('li', { className: 'files-empty', textContent: 'Đang tải…' }));
  const data = await api('GET', '/api/account');
  $('#accountUser').textContent = data.user;
  $('#deviceCount').textContent = data.sessions.length;
  $('#revokeOthers').hidden = data.sessions.length < 2;
  $('#deviceList').replaceChildren(
    ...data.sessions.map((s) => {
      const dev = describeDevice(s.userAgent);
      const revoke = el('button', {
        className: 'btn ghost sm',
        type: 'button',
        textContent: s.current ? 'Đăng xuất' : 'Đăng xuất máy này',
        onclick: async () => {
          if (s.current) return $('#btnLogout').click();
          const yes = await confirmDialog({
            title: `Đăng xuất ${dev.name}?`,
            message: `Máy này (IP ${s.ip}) phải nhập lại mật khẩu mới vào được. Nếu không nhận ra máy này, hãy đổi mật khẩu.`,
            ok: 'Đăng xuất máy đó',
            danger: true,
          });
          if (!yes) return;
          try {
            await api('DELETE', `/api/account/sessions/${s.id}`);
            toast(`Đã đăng xuất ${dev.name}`);
            await openAccount();
          } catch (e) {
            fail(e);
          }
        },
      });
      return el('li', { className: `device${s.current ? ' current' : ''}` },
        el('span', { className: `device-ico ${dev.kind}`, innerHTML: DEVICE_ICONS[dev.kind] }),
        el('span', { className: 'device-info' },
          el('span', { className: 'device-name' }, dev.name, s.current ? el('span', { className: 'chip ok', textContent: 'Máy này' }) : null),
          el('span', { className: 'device-meta', textContent: `IP ${s.ip} · dùng ${s.current ? 'ngay lúc này' : timeAgo(s.lastSeen)}` }),
          el('span', { className: 'device-meta', textContent: `Đăng nhập ${timeAgo(s.createdAt)} · ${s.remember ? 'duy trì 30 ngày' : 'không duy trì'}` })),
        revoke);
    }),
  );
  const fails = data.history.filter((h) => !h.ok).length;
  $('#historyNote').textContent = data.history.length ? `${data.history.length} lần gần nhất${fails ? ` · ${fails} lần sai` : ''}` : '';
  $('#loginHistory').replaceChildren(
    ...(data.history.length
      ? data.history.map((h) =>
          el('li', { className: h.ok ? 'ok' : 'bad' },
            el('span', { className: 'h-dot' }),
            el('span', { className: 'h-what', textContent: h.ok ? 'Đăng nhập thành công' : 'Sai mật khẩu' }),
            el('span', { className: 'h-dev', textContent: `${describeDevice(h.userAgent).name} · IP ${h.ip}` }),
            el('span', { className: 'h-time', textContent: timeAgo(h.at) })))
      : [el('li', { className: 'files-empty', textContent: 'Chưa có lần đăng nhập nào được ghi lại.' })]),
  );
}

/* ---------- Kỳ / phiếu ---------- */

async function loadMeta() {
  state.meta = await api('GET', '/api/meta');
  const s = state.meta.shop;
  const fill = { ...s, tagline0: s.tagline[0], tagline1: s.tagline[1], tagline2: s.tagline[2], tagline3: s.tagline[3] };
  document.querySelectorAll('[data-shop]').forEach((n) => (n.textContent = fill[n.dataset.shop] ?? ''));
  renderDrive();
}

async function loadPeriod({ keepRows = false } = {}) {
  const prevEnd = state.data?.period.end;
  state.data = await api('GET', `/api/period/${state.date}`);
  // Bán lẻ: lần bán mới nhất lên đầu (sau ô "Phiếu mới")
  if (state.data.period.retail) state.data.customers = [state.draft, ...state.data.customers.reverse()];
  if (prevEnd !== state.data.period.end) state.entryDate = null;
  renderToolbar();
  renderSidebar();
  renderStatus();
  if (!keepRows) {
    renderPaper();
    checkDriveHint();
  }
}

const periodCustomers = () => state.data.customers;
const customerLabel = (c) => c.name || '(Chưa có tên)';
const current = () => periodCustomers().find((c) => c.id === state.selectedId) ?? null;

function renderToolbar() {
  const p = state.data.period;
  if (p.retail) {
    const [y, m] = [p.end.slice(1, 5), Number(p.end.slice(6, 8))];
    $('#periodRange').replaceChildren(`Bán lẻ · Tháng ${m}/${y}`);
    $('#saleDateText').textContent = `Tháng ${m}/${y}`;
    $('#prevPhieu').disabled = !state.data.prev;
    $('#prevPhieu').title = 'Tháng trước';
    $('#nextPhieu').disabled = !state.data.next;
    $('#nextPhieu').title = 'Tháng sau';
    $('#periodPath').innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5v8h13v-7H8L6.5 3.5h-5z"/></svg>';
    $('#periodPath').append(`Drive › ${p.year} › ${p.month} › ${p.title}`);
    return;
  }
  $('#periodRange').replaceChildren(
    `Phiếu ngày ${dmy(p.end)} · ${p.endDayName}`,
    state.data.exists ? '' : el('span', { className: 'chip new', textContent: 'Phiếu mới' }),
  );
  $('#prevPhieu').disabled = !state.data.prev;
  $('#prevPhieu').title = state.data.prev ? `Phiếu trước: ${dmy(state.data.prev)}` : 'Không có phiếu trước';
  $('#nextPhieu').disabled = !state.data.next;
  $('#nextPhieu').title = state.data.next ? `Phiếu sau: ${dmy(state.data.next)}` : 'Không có phiếu sau';
  $('#periodPath').innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5v8h13v-7H8L6.5 3.5h-5z"/></svg>';
  $('#periodPath').append(`Drive › ${p.year} › ${p.month} › ${state.meta.drive.format === 'sheets' ? `${p.title} (Google Sheets)` : p.fileName}`);
  const [y, m] = p.end.split('-');
  $('#backToFolder').href = `#/${y}/${Number(m)}`;
  $('#backLabel').textContent = `Tháng ${Number(m)} · ${y}`;
}

function renderSidebar() {
  const list = periodCustomers();
  const ul = $('#customerList');
  ul.replaceChildren();
  if (!list.length) ul.append(el('li', { className: 'none', textContent: 'Chưa có khách nào. Thêm khách ở ô phía trên, mỗi khách là 1 sheet trong phiếu.' }));
  $('.sidebar-title').textContent = state.retail ? 'Phiếu bán lẻ' : 'Khách trong phiếu';
  $('#weekTotalLabel').textContent = state.retail ? 'Tổng bán lẻ tháng này' : 'Tổng kết tiền phiếu này';
  for (const c of list) {
    if (c.draft) {
      ul.append(el('li', { className: 'draft' },
        el('button', { className: c.id === state.selectedId ? 'active' : '', onclick: () => selectCustomer(0) },
          el('span', { className: 'avatar', innerHTML: '<svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg>' }),
          el('span', { className: 'c-info' },
            el('span', { className: 'c-name', textContent: 'Phiếu mới' }),
            el('span', { className: 'c-meta', textContent: 'Gõ hàng là tự lưu' })))));
      continue;
    }
    const initials = (c.label ?? c.name).trim().split(/\s+/).filter(Boolean).slice(-2).map((w) => w[0]).join('').toUpperCase() || (state.retail ? 'KL' : '?');
    const li = el('li', { title: 'Kéo để đổi thứ tự · chuột phải: thêm thao tác' });
    li.dataset.id = c.id;
    li.append(el('span', { className: 'c-grip', title: 'Kéo để đổi thứ tự', ariaHidden: 'true', innerHTML: GRIP_ICON }));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSheetMenu(c, e.clientX, e.clientY);
    });
    onLongPress(li, (x, y) => openSheetMenu(c, x, y));
    ul.append(
      el(li, {},
        el('button', {
          className: c.id === state.selectedId ? 'active' : '',
          onclick: () => selectCustomer(c.id),
        },
        el('span', { className: 'avatar', textContent: initials }),
        el('span', { className: 'c-info' },
          el('span', { className: `c-name${c.name ? '' : ' unnamed'}`, textContent: customerLabel(c) }),
          el('span', { className: 'c-meta', textContent: c.lines.length ? `${c.lines.length} dòng hàng` : 'Chưa có hàng' })),
        el('span', { className: 'c-total', textContent: money(c.grandTotal) })),
        el('button', {
            className: 'c-remove',
            title: 'Xoá khách khỏi phiếu',
            ariaLabel: `Xoá ${customerLabel(c)} khỏi phiếu`,
            innerHTML: '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>',
            onclick: () => removeFromPhieu(c),
          }),
      ),
    );
  }
  const real = list.filter((c) => !c.draft);
  $('#customerCount').textContent = real.length || '';
  $('#weekTotal').textContent = money(real.reduce((s, c) => s + c.grandTotal, 0));
}

function renderStatus() {
  const box = $('#syncStatus');
  const banner = $('#conflictBanner');
  const { sync, drive } = state.data;
  banner.hidden = true;
  banner.className = 'banner';
  box.className = 'sync';
  box.replaceChildren();
  $('#btnSync').disabled = false;

  if (!state.meta.drive.connected) {
    box.textContent = 'Chưa kết nối Drive';
    return;
  }
  const dot = el('span', { className: 'dot' });
  const open = (href, text = 'Mở') => el('a', { href, target: '_blank', rel: 'noopener', textContent: text });

  if (sync?.state === 'pending') {
    box.classList.add('pending');
    box.append(dot, 'Đang lưu lên Drive…');
    $('#btnSync').disabled = true;
    watchSync();
  } else if (sync?.state === 'error') {
    box.classList.add('error');
    box.append(dot, 'Lỗi lưu Drive');
    banner.classList.add('error');
    // Hết phiên đăng nhập Google: "Thử lại" không ích gì, phải đăng nhập lại (xong quay về app, tự lưu lại).
    const reauth = sync.code === 'DRIVE_REAUTH';
    banner.replaceChildren(...[
      el('span', {}, el('b', { textContent: 'Chưa lưu được lên Drive. ' }), sync.message),
      el('span', { className: 'spacer' }),
      sync.helpUrl && el('a', { className: 'btn ghost sm', href: sync.helpUrl, target: '_blank', rel: 'noopener', textContent: 'Bật Drive API' }),
      reauth
        ? el('button', { className: 'btn primary sm', textContent: 'Kết nối lại Google Drive', onclick: connectDrive })
        : el('button', { className: 'btn primary sm', textContent: 'Thử lại', onclick: () => syncNow(false) }),
    ].filter(Boolean)); // replaceChildren(null) sẽ in ra chữ "null"
    banner.hidden = false;
  } else if (sync?.state === 'conflict') {
    box.classList.add('conflict');
    box.append(dot, 'Trùng file trên Drive');
    banner.replaceChildren(...[
      el('span', {}, el('b', { textContent: 'File đã tồn tại. ' }), `${sync.message} Ghi đè bằng dữ liệu trong app?`),
      el('span', { className: 'spacer' }),
      sync.webLink && open(sync.webLink, 'Xem file hiện có'),
      el('button', { className: 'btn primary sm', textContent: 'Ghi đè', onclick: () => syncNow(true) }),
    ].filter(Boolean));
    banner.hidden = false;
  } else if (drive || sync?.state === 'ok') {
    const link = sync?.webLink ?? drive.web_link;
    const at = sync?.at ? new Date(sync.at) : drive?.synced_at ? new Date(drive.synced_at.replace(' ', 'T')) : null;
    box.classList.add('ok');
    box.append(dot, at ? `Đã lưu Drive ${at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} · ` : 'Đã có trên Drive · ');
    if (link) box.append(open(link));
  } else {
    box.textContent = state.meta.drive.autoSync ? 'Tự lưu Drive' : 'Chưa lưu lên Drive';
  }
}

let watching = null;
function watchSync() {
  if (watching) return;
  watching = setTimeout(async () => {
    watching = null;
    try {
      const fresh = await api('GET', `/api/period/${state.date}`);
      state.data.sync = fresh.sync;
      state.data.drive = fresh.drive;
      renderStatus();
    } catch {
      /* thử lại ở lần sau */
    }
  }, 1500);
}

async function syncNow(force = false) {
  if (!state.meta.drive.connected) {
    toast('Hãy kết nối Google Drive trước.', { error: true });
    return;
  }
  $('#btnSync').disabled = true;
  state.data.sync = { state: 'pending' };
  renderStatus();
  try {
    const r = await api('POST', `/api/sync/${state.date}`, { force });
    toast(`Đã lưu: ${r.path}`, { action: 'Mở file', onAction: () => window.open(r.webLink, '_blank') });
  } catch (e) {
    // Lỗi Drive đã hiện ở dải thông báo phía trên, chỉ toast các lỗi khác.
    if (!e.code?.startsWith('DRIVE_')) fail(e);
  }
  await loadPeriod({ keepRows: true });
}

/* ---------- Thư mục phiếu: Năm → Tháng → phiếu theo ngày (giống thư mục trên Drive) ---------- */

const driveFilesCache = new Map(); // năm → danh sách file trên Drive

async function fetchDriveFiles(year, { fresh = false } = {}) {
  if (!fresh && driveFilesCache.has(year)) return driveFilesCache.get(year);
  const files = await api('GET', `/api/drive/files?year=${year}`);
  driveFilesCache.set(year, files);
  return files;
}

async function goToDate(date) {
  state.date = date;
  const retail = date.startsWith('R');
  if (!retail) $('#saleDateText').textContent = dmy(date);
  // ‹ › và lịch trong trang phiếu: đổi địa chỉ nhưng không chồng lịch sử (Back vẫn về thư mục)
  const hash = retail ? `#/ban-le/${date.slice(1)}` : `#/phieu/${date}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  await loadPeriod();
  if (retail) return selectCustomer(0); // vào Bán lẻ: gõ phiếu mới ngay
  const first = state.data.customers[0];
  if (!current() && first) selectCustomer(first.id);
}

/** Nạp file Drive vào app (nếu chưa có) rồi mở phiếu đó. replace = ghi đè dữ liệu phiếu đó trong app. */
async function openDriveFile(f, { replace = false } = {}) {
  if (opening) return; // đang mở 1 file: bỏ qua bấm thêm
  let done = () => {};
  try {
    if (!f.inApp || replace) {
      opening = f.id;
      if (!$('#view-files').hidden) renderFiles();
      done = showBusy(f.date ? `Đang mở phiếu ${fileLabel(f.date)}` : 'Đang mở phiếu', f.name);
      const r = await api('POST', '/api/drive/open', { fileId: f.id, replace });
      f.inApp = true; // không cần đọc lại cả Drive: chỉ đánh dấu file này đã có trong app
      browser.app = null;
      toast(`Đã mở "${f.name}": ${r.customers} khách, ${r.lines} dòng hàng`);
      await Promise.all([loadProducts(), loadCustomers()]);
    }
    if (location.hash === `#/phieu/${f.date}`) await goToDate(f.date);
    else location.hash = `#/phieu/${f.date}`;
  } catch (e) {
    fail(e);
  } finally {
    opening = null;
    done();
    if (!$('#view-files').hidden) renderFiles();
  }
}

let opening = null; // id file Drive đang được mở vào app

/** Màn che "Đang mở…" có hoạ tiết bảng tính đang được điền, trong lúc đọc file .xlsx từ Drive. */
function showBusy(title, sub) {
  const box = el('div', { className: 'busy', role: 'status', ariaLive: 'polite' },
    el('div', { className: 'busy-card' },
      el('span', { className: 'busy-art', innerHTML: BUSY_SHEET }),
      el('b', { className: 'busy-title', textContent: title }),
      el('span', { className: 'busy-sub', textContent: sub }),
      el('span', { className: 'busy-steps', textContent: 'Đọc file trên Google Drive · chép khách và hàng vào app' }),
      el('span', { className: 'busy-bar' }, el('i'))));
  document.body.append(box);
  requestAnimationFrame(() => box.classList.add('show'));
  return () => {
    box.classList.remove('show');
    setTimeout(() => box.remove(), 200);
  };
}
const BUSY_SHEET = `<svg viewBox="0 0 120 140" aria-hidden="true">
  <path class="b-page" d="M14 6h64l30 30v94a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6V12a6 6 0 0 1 6-6z"/>
  <path class="b-fold" d="M78 6v30h30"/>
  <g class="b-rows">${[0, 1, 2, 3, 4].map((i) => `<rect x="22" y="${56 + i * 14}" width="${i % 2 ? 50 : 72}" height="7" rx="3.5" style="animation-delay:${i * 0.18}s"/><rect class="num" x="${i % 2 ? 80 : 98}" y="${56 + i * 14}" width="${i % 2 ? 18 : 0}" height="7" rx="3.5" style="animation-delay:${i * 0.18 + 0.09}s"/>`).join('')}</g>
  <path class="b-head" d="M22 40h50"/>
</svg>`;

const browser = { app: null, retail: [], driveYears: null, driveLoading: false, driveError: '' };
// "Bán Lẻ 11-2026" (tên file cuốn bán lẻ trên Drive) → "2026-11". Chuẩn hoá NFC: tên tiếng Việt từ Drive có thể ở dạng tổ hợp.
const retailMonthOf = (name) => {
  const m = /^bán lẻ\s+(\d{1,2})-(\d{4})$/iu.exec(String(name ?? '').normalize('NFC').trim());
  return m ? `${m[2]}-${m[1].padStart(2, '0')}` : null;
};
const DAY_FULL = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const fileLabel = (iso) => `${Number(iso.slice(8, 10))}-${Number(iso.slice(5, 7))}`; // "10-11" như tên file trên Drive
const FOLDER_ICON =
  '<svg class="folder-icon" viewBox="0 0 48 40" aria-hidden="true"><path class="f-back" d="M3 7a3 3 0 0 1 3-3h11.5l4 4H42a3 3 0 0 1 3 3v23a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path class="f-front" d="M3 15a3 3 0 0 1 3-3h36a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/></svg>';
const SHEET_ICON =
  '<svg class="sheet-icon" viewBox="0 0 34 40" aria-hidden="true"><path class="s-page" d="M5.5 2H22l9 9v25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 3 36V4.5A2.5 2.5 0 0 1 5.5 2z"/><path class="s-fold" d="M22 2v9h9"/><path class="s-grid" d="M9 18.5h16v12H9zM9 22.5h16M9 26.5h16M15 18.5v12"/></svg>';
const CHEVRON = '<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5l5 5-5 5"/></svg>';

/** "Thangs 10" / "THÁNG 9" / "Tháng 09" → 10 / 9 / 9 (0 nếu không đọc được số tháng). */
const monthOfFolder = (name) => {
  const n = Number(/(\d{1,2})/.exec(name ?? '')?.[1]);
  return n >= 1 && n <= 12 ? n : 0;
};
const dated = (date, extra) => ({ key: date, date, year: date.slice(0, 4), month: Number(date.slice(5, 7)), app: null, drive: null, ...extra });

/**
 * Gộp phiếu trong app với file trên Drive (khi đã kết nối): mỗi ngày phiếu 1 mục.
 * File trên Drive có tên không theo mẫu ngày vẫn hiện (theo thư mục năm/tháng chứa nó), bấm thì mở trên Drive.
 */
function browserItems() {
  const map = new Map();
  for (const p of browser.app ?? []) map.set(p.date, dated(p.date, { app: p }));
  const retailItem = (ym) => {
    const key = `R${ym}`;
    if (!map.has(key)) map.set(key, { key, date: null, retail: ym, year: ym.slice(0, 4), month: Number(ym.slice(5, 7)), app: null, drive: null });
    return map.get(key);
  };
  for (const b of browser.retail ?? []) retailItem(b.book.slice(1)).app = { ...b, total: b.total };
  for (const [year, files] of driveFilesCache) {
    for (const f of files) {
      const ym = retailMonthOf(f.name);
      if (ym) {
        retailItem(ym).drive = f; // file "Bán Lẻ 11-2026": cùng 1 mục với cuốn bán lẻ trong app
        continue;
      }
      const date = f.periodEnd ?? f.date;
      if (!date) {
        map.set(f.id, { key: f.id, date: null, year: String(year), month: monthOfFolder(f.month), app: null, drive: f });
        continue;
      }
      const it = map.get(date) ?? dated(date);
      it.drive = f;
      map.set(date, it);
    }
  }
  // mới nhất trước; file không đọc được ngày xếp cuối tháng của nó
  return [...map.values()].sort((a, b) => Boolean(b.retail) - Boolean(a.retail) || (b.date ?? '').localeCompare(a.date ?? '') || (a.drive?.name ?? '').localeCompare(b.drive?.name ?? ''));
}

function groupBy(items, key) {
  const m = new Map();
  for (const it of items) {
    const k = key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

const sumTotal = (items) => items.reduce((s, it) => s + (it.app?.total ?? 0), 0);
const countText = (n, word) => `${n} ${word}`;

function folderTile({ href, name, meta, current }) {
  return el('a', { className: `folder${current ? ' current' : ''}`, href },
    el('span', { className: 'folder-art', innerHTML: FOLDER_ICON }),
    el('span', { className: 'folder-text' },
      el('span', { className: 'folder-name', textContent: name }),
      el('span', { className: 'folder-meta', textContent: meta })),
    current ? el('span', { className: 'chip now', textContent: 'Hiện tại' }) : null);
}

function fileItem(it) {
  if (it.retail) {
    // Cuốn bán lẻ của tháng: mở trong app ở tab Bán lẻ (không phải phiếu ngày)
    const [y, m] = it.retail.split('-');
    const sales = it.app?.sales ?? 0;
    return el('a', { className: 'file retail-book', href: `#/ban-le/${it.retail}` },
      el('span', { className: 'file-art retail-art', innerHTML: '<svg viewBox="0 0 24 24"><path d="M3 4h2.4l2 10.5h10.8l1.8-7.5H6.4M9.5 19.5a1.2 1.2 0 1 0 0-.01M17 19.5a1.2 1.2 0 1 0 0-.01"/></svg>' }),
      el('span', { className: 'file-text' },
        el('span', { className: 'file-name', textContent: `Bán Lẻ ${m}-${y}` }),
        el('span', { className: 'file-sub', textContent: sales ? `${countText(sales, 'phiếu bán lẻ')} · cả tháng` : 'Cuốn bán lẻ cả tháng' })),
      el('span', { className: 'file-tags' }, it.drive ? el('span', { className: 'chip drive', textContent: 'Drive' }) : null),
      el('span', { className: 'file-total', textContent: it.app ? money(it.app.total) : '' }),
      el('span', { className: 'file-go', innerHTML: CHEVRON }));
  }
  if (!it.date) {
    // Tên file không theo mẫu "… {ngày}-{tháng}-{năm}": không biết ngày phiếu nên chỉ mở xem trên Drive.
    return el('a', { className: 'file remote', href: it.drive.webLink, target: '_blank', rel: 'noopener' },
      el('span', { className: 'file-art', innerHTML: SHEET_ICON }),
      el('span', { className: 'file-text' },
        el('span', { className: 'file-name', textContent: it.drive.name }),
        el('span', { className: 'file-sub', textContent: 'Tên file không có ngày theo mẫu · bấm để xem trên Drive' })),
      el('span', { className: 'file-tags' }, el('span', { className: 'chip drive only', textContent: 'Chỉ trên Drive' })),
      el('span', { className: 'file-total' }),
      el('span', { className: 'file-go', innerHTML: CHEVRON }));
  }
  const today = it.date === state.meta.today;
  const inApp = Boolean(it.app) || Boolean(it.drive?.inApp);
  const day = DAY_FULL[toUTC(it.date).getUTCDay()];
  const loading = opening && it.drive?.id === opening;
  const a = el(inApp ? 'a' : 'button', { className: `file${inApp ? '' : ' remote'}${loading ? ' loading' : ''}` });
  if (inApp) a.href = `#/phieu/${it.date}`;
  else {
    a.type = 'button';
    a.onclick = () => openDriveFile(it.drive);
  }
  const sub = inApp
    ? [day, it.app && countText(it.app.customers, 'khách'), it.app?.lines ? countText(it.app.lines, 'dòng hàng') : 'chưa có hàng'].filter(Boolean).join(' · ')
    : `${day} · Trên Google Drive, bấm để mở`;
  a.append(
    el('span', { className: 'file-art', innerHTML: SHEET_ICON }),
    el('span', { className: 'file-text' },
      el('span', { className: 'file-name' }, fileLabel(it.date), el('span', { className: 'ext', textContent: '.xlsx' })),
      el('span', { className: 'file-sub', textContent: sub })),
    el('span', { className: 'file-tags' },
      today ? el('span', { className: 'chip now', textContent: 'Hôm nay' }) : null,
      it.drive ? el('span', { className: `chip drive${inApp ? '' : ' only'}`, title: it.drive.name, textContent: inApp ? 'Drive' : 'Chỉ trên Drive' }) : null),
    el('span', { className: 'file-total', textContent: it.app ? money(it.app.total) : '' }),
    el('span', { className: 'file-go', innerHTML: loading ? '<span class="spinner"></span>' : CHEVRON }));
  return a;
}

/** Khung giả nhấp nháy trong lúc đang đọc Drive (thư mục / file sắp hiện). */
const skeletonTiles = (n) => Array.from({ length: n }, () =>
  el('div', { className: 'folder skeleton', ariaHidden: 'true' },
    el('span', { className: 'sk sk-icon' }), el('span', { className: 'folder-text' }, el('span', { className: 'sk sk-line' }), el('span', { className: 'sk sk-line short' }))));
const skeletonRows = (n) => Array.from({ length: n }, () =>
  el('div', { className: 'file skeleton', ariaHidden: 'true' },
    el('span', { className: 'sk sk-file' }), el('span', { className: 'file-text' }, el('span', { className: 'sk sk-line' }), el('span', { className: 'sk sk-line short' }))));

function renderFilesStatus() {
  const box = $('#filesStatus');
  box.className = 'files-status';
  if (browser.driveLoading) box.textContent = 'Đang đọc thư mục trên Google Drive…';
  else if (browser.driveError) {
    box.classList.add('error');
    box.textContent = `Không đọc được Google Drive: ${browser.driveError}`;
  } else if (browser.driveYears && !browser.driveYears.length) {
    box.classList.add('error');
    box.textContent = `Drive của ${state.meta.drive.email || 'tài khoản đang kết nối'} chưa có thư mục năm nào. Nếu phiếu cũ nằm ở tài khoản Google khác: Ngắt kết nối rồi kết nối lại bằng đúng tài khoản đó.`;
  } else box.textContent = '';
  box.hidden = !box.textContent;
}

function renderFiles() {
  const { year, month } = state.folder;
  const items = browserItems();
  const today = state.meta.today;
  const body = $('#filesBody');
  const crumbs = [['Tất cả phiếu', '#/']];
  if (year) crumbs.push([String(year), `#/${year}`]);
  if (month != null) crumbs.push([month ? `Tháng ${month}` : 'Thư mục khác', `#/${year}/${month}`]);
  $('#crumbs').replaceChildren(...crumbs.slice(0, -1).flatMap(([t, href]) => [el('a', { href, textContent: t }), el('span', { className: 'sep', textContent: '›' })]));
  $('#crumbs').hidden = crumbs.length === 1;
  renderFilesStatus();

  const empty = (text) => el('div', { className: 'files-empty card' }, el('span', { className: 'folder-art', innerHTML: FOLDER_ICON }), el('p', { textContent: text }));

  if (!year) {
    const years = groupBy(items, (it) => it.year);
    for (const y of browser.driveYears ?? []) if (!years.has(String(y))) years.set(String(y), []);
    $('#folderTitle').textContent = 'Tất cả phiếu';
    $('#folderMeta').textContent = `${countText(items.length, 'phiếu')} · ${countText(years.size, 'năm')}`;
    const tiles = [...years].sort((a, b) => b[0].localeCompare(a[0])).map(([y, list]) =>
      folderTile({
        href: `#/${y}`,
        name: y,
        meta: `${countText(new Set(list.map((it) => it.month)).size, 'tháng')} · ${countText(list.length, 'phiếu')}`,
        current: y === today.slice(0, 4),
      }));
    if (browser.driveLoading) tiles.push(...skeletonTiles(Math.max(2, 4 - tiles.length)));
    body.replaceChildren(tiles.length ? el('div', { className: 'folders' }, tiles) : empty('Chưa có phiếu nào. Bấm "Hôm nay" để tạo phiếu đầu tiên.'));
    return;
  }

  const inYear = items.filter((it) => it.year === String(year));
  if (month == null) {
    const months = groupBy(inYear, (it) => it.month);
    $('#folderTitle').textContent = `Năm ${year}`;
    $('#folderMeta').textContent = `${countText(inYear.length, 'phiếu')} · ${countText(months.size, 'tháng')}`;
    const tiles = [...months].sort((a, b) => b[0] - a[0]).map(([m, list]) =>
      folderTile({
        href: `#/${year}/${m}`,
        name: m ? `Tháng ${m}` : 'Thư mục khác',
        meta: [countText(list.length, 'phiếu'), sumTotal(list) ? money(sumTotal(list)) : ''].filter(Boolean).join(' · '),
        current: `${year}-${String(m).padStart(2, '0')}` === today.slice(0, 7),
      }));
    if (browser.driveLoading) tiles.push(...skeletonTiles(Math.max(2, 4 - tiles.length)));
    body.replaceChildren(tiles.length ? el('div', { className: 'folders' }, tiles) : empty(`Năm ${year} chưa có phiếu nào.`));
    return;
  }

  const inMonth = inYear.filter((it) => it.month === month);
  $('#folderTitle').textContent = month ? `Tháng ${month} · ${year}` : `Thư mục khác · ${year}`;
  $('#folderMeta').textContent = !inMonth.length && browser.driveLoading ? 'Đang tìm phiếu trên Drive…' : [countText(inMonth.length, 'phiếu'), sumTotal(inMonth) ? `Tổng ${money(sumTotal(inMonth))}` : ''].filter(Boolean).join(' · ');
  const rows = [...inMonth.map(fileItem), ...(browser.driveLoading ? skeletonRows(inMonth.length ? 2 : 4) : [])];
  body.replaceChildren(rows.length ? el('div', { className: 'files card' }, rows) : empty(`Tháng ${month}/${year} chưa có phiếu nào.`));
}

/** Đọc danh sách phiếu trên Drive (tất cả các năm) để hiện chung trong thư mục. */
async function loadBrowserDrive() {
  if (!state.meta.drive.connected || browser.driveLoading || browser.driveYears) return;
  browser.driveLoading = true;
  browser.driveError = '';
  if (!$('#view-files').hidden) renderFiles(); // hiện khung nhấp nháy chờ danh sách Drive
  try {
    const years = await api('GET', '/api/drive/years');
    await Promise.all(years.map((y) => fetchDriveFiles(String(y))));
    browser.driveYears = years;
  } catch (e) {
    browser.driveError = e.message;
  }
  browser.driveLoading = false;
  if (!$('#view-files').hidden) renderFiles();
}

async function showFolder(year, month) {
  state.folder = { year, month };
  showView('files');
  if (browser.app) renderFiles();
  // luôn đọc lại: số khách / tổng tiền vừa sửa ở trang phiếu
  [browser.app, browser.retail] = await Promise.all([api('GET', '/api/phieus'), api('GET', '/api/retail/books').catch(() => [])]);
  renderFiles();
  loadBrowserDrive();
}

async function openPhieu(date) {
  setRetail(false);
  showView('invoice');
  if (state.date === date && state.data) return;
  await goToDate(date);
  const last = Number(store('lastCustomer'));
  if (last && state.data.customers.some((c) => c.id === last)) selectCustomer(last);
}

/** Tab Bán lẻ: cuốn bán lẻ của tháng (mặc định tháng này), mở sẵn phiếu mới để gõ. */
async function openRetail(month) {
  setRetail(true);
  showView('invoice');
  const key = `R${/^\d{4}-\d{2}$/.test(month ?? '') ? month : state.meta.today.slice(0, 7)}`;
  if (state.date === key && state.data) return;
  await goToDate(key);
}

function setRetail(on) {
  state.retail = on;
  document.body.classList.toggle('retail', on);
}

function showView(name) {
  const tab = name === 'invoice' ? (state.retail ? 'retail' : 'files') : name;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
    t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  });
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  closeCalendar();
  hideSuggest();
  hideCustomerSuggest();
  if (name === 'products') renderProducts();
  if (name === 'customers') renderCustomers();
}

/** Địa chỉ trang: #/ · #/2026 · #/2026/11 · #/phieu/2026-11-10 · #/bang-gia · #/khach-hang */
async function route() {
  // Mở app (chưa có địa chỉ): vào thẳng tab Bán lẻ để gõ phiếu
  if (!location.hash) history.replaceState(null, '', '#/ban-le');
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] !== 'phieu' && parts[0] !== 'ban-le') setRetail(false);
  if (parts[0] === 'ban-le') await openRetail(parts[1]);
  else if (parts[0] === 'bang-gia') showView('products');
  else if (parts[0] === 'khach-hang') showView('customers');
  else if (parts[0] === 'phieu' && /^\d{4}-\d{2}-\d{2}$/.test(parts[1] ?? '')) await openPhieu(parts[1]);
  else {
    const year = /^\d{4}$/.test(parts[0] ?? '') ? Number(parts[0]) : null;
    const month = year && /^(1[0-2]|[0-9])$/.test(parts[1] ?? '') ? Number(parts[1]) : null;
    await showFolder(year, month);
  }
}

/** Tuần đang xem chưa có dữ liệu trong app nhưng Drive đã có file → gợi ý mở. */
async function checkDriveHint() {
  const hint = $('#driveHint');
  hint.hidden = true;
  if (!state.meta.drive.connected || state.data.customers.length) return;
  const end = state.data.period.end;
  try {
    const files = await fetchDriveFiles(end.slice(0, 4));
    const f = files.find((x) => x.periodEnd === end && !x.inApp);
    if (!f || state.data.period.end !== end || state.data.customers.length) return;
    hint.replaceChildren(
      el('span', {}, el('b', { textContent: 'Trên Drive đã có phiếu tuần này. ' }), `File "${f.name}" chưa được mở trong app.`),
      el('a', { className: 'btn ghost sm', href: f.webLink, target: '_blank', rel: 'noopener', textContent: 'Xem trên Drive' }),
      el('button', { className: 'btn primary sm', textContent: 'Mở vào app', onclick: () => openDriveFile(f) }),
    );
    hint.hidden = false;
  } catch {
    /* mất mạng hoặc chưa bật Drive API: bỏ qua gợi ý */
  }
}

/* ---------- Tờ phiếu của 1 khách ---------- */

function selectCustomer(id) {
  state.selectedId = id;
  store('lastCustomer', String(id));
  renderSidebar();
  renderPaper();
  if (!$('#entryRow').hidden) $('#eItem').focus();
}

function renderPaper() {
  const c = current();
  $('#emptyState').hidden = Boolean(c);
  $('#paper').hidden = !c;
  if (!c) return;

  $('#customerName').value = c.draft ? c.name : c.label ?? c.name;
  $('#customerName').placeholder = state.retail ? 'Khách lẻ (không bắt buộc)' : 'Chưa có tên';
  const focused = activeCell();

  const tbody = $('#lineRows');
  if (tbody.contains(SUGGEST_BOX)) homeSuggest(); // đừng xoá mất danh sách gợi ý cùng các dòng cũ
  tbody.replaceChildren();
  let prev = null;
  c.lines.forEach((line, i) => {
    const repeat = line.date === prev; // cùng ngày với dòng trên: không ghi lại ngày
    const date = dateCell(line.date, { repeat, onChange: (v) => save({ date: v }) });
    prev = line.date;

    // Tên hàng hiện như trên sheet: "5.500 viên gạch ống" (số lượng vẫn nằm ở cột SL; sửa ô này thì tách lại như dòng nhập mới).
    const name = el('input', { value: sheetItemName(line), autocomplete: 'off' });
    const unit = el('input', { value: line.unit });
    const qty = el('input', { value: qtyInput(line.qty), inputMode: 'decimal' });
    const price = el('input', { value: moneyInput(line.price), inputMode: 'numeric' });
    [name, unit, qty, price].forEach((inp, k) => {
      inp.dataset.col = k + 1;
      Object.assign(inp, { autocomplete: 'off', spellcheck: false });
      inp.setAttribute('autocorrect', 'off');
      inp.setAttribute('autocapitalize', 'none');
      inp.setAttribute('enterkeyhint', 'next');
    });
    const amount = el('td', { className: 'num amount', textContent: money(Math.round(line.qty * line.price)) });
    // Điện thoại: bảng 4 cột Tên hàng | SL | Giá | Thành tiền (chữ to, dễ dò), mỗi khi sang ngày mới có
    // thanh "Ngày dd/mm" ngang bảng như trên phiếu giấy; chạm vào dòng để mở thẻ sửa.
    const summary = el('td', { className: 'm-sum', title: 'Chạm để sửa' });
    const paintSummary = () =>
      summary.replaceChildren(...[
        line.date && !repeat ? el('span', { className: 'm-date-head', textContent: `Ngày ${dm(line.date)}` }) : null,
        el('span', { className: 'm-name' }, el('i', { textContent: `${i + 1}.` }), sheetItemName(line) || '(chưa có tên hàng)', scaleBadge(line)),
        el('span', { className: 'm-price' }, money(line.price), line.unit ? el('small', { textContent: line.unit }) : null),
        el('span', { className: 'm-amt', textContent: money(Math.round(line.qty * line.price)) }),
      ].filter(Boolean));
    paintSummary();

    const save = async (patch) => {
      try {
        Object.assign(line, await api('PUT', `/api/entries/${line.id}`, patch));
        if (document.activeElement !== name) name.value = sheetItemName(line);
        unit.value = line.unit;
        qty.value = qtyInput(line.qty);
        price.value = moneyInput(line.price);
        amount.textContent = money(Math.round(line.qty * line.price));
        if ('orig_qty' in line && Math.abs(line.qty - (line.orig_qty ?? line.qty)) < 1e-9) line.orig_qty = null;
        paintSummary();
        paintScale();
        if (patch.date) return loadPeriod();
        recalc(c);
        await loadPeriod({ keepRows: true });
      } catch (e) {
        fail(e);
        renderPaper(); // lưu không được: trả các ô về giá trị đã lưu để màn hình (và bản in) khớp dữ liệu
      }
    };
    // Sửa tên thành "30 bao xi măng" / "5500 ống" thì tách số lượng / ĐVT và đổi tên khác ra mặt hàng như dòng nhập mới
    // (tên được để trống). Đổi sang mặt hàng khác thì lấy luôn giá của mặt hàng đó.
    name.onchange = () => {
      const p = parseEntry(name.value);
      save({
        item_name: p.name,
        ...(p.qty != null && { qty: p.qty }),
        ...(p.unit && { unit: p.unit }),
        ...(p.product && p.product.name !== line.item_name && { price: p.product.price }),
      });
    };
    // Gõ lại tên ở dòng đã có cũng hiện gợi ý; chọn gợi ý thì lấy luôn ĐVT và giá của mặt hàng đó.
    const pick = async (s, typedQty) => {
      name.value = s.name;
      await save({ item_name: s.name, unit: s.unit, price: s.price, ...(typedQty != null && { qty: typedQty }) });
      if (name.isConnected && line.item_name === s.name) name.value = sheetItemName(line);
    };
    name.addEventListener('input', () => renderSuggest(parseEntry(name.value), name, pick));
    name.addEventListener('blur', hideSuggest);
    name.addEventListener('keydown', onNameKeydown);
    name.setAttribute('role', 'combobox');
    name.setAttribute('aria-controls', 'suggest');
    unit.onchange = () => save({ unit: unit.value });
    qty.onchange = () => save({ qty: parseQty(qty.value) });
    price.onchange = () => save({ price: parseMoney(price.value) });

    const del = el('button', { className: 'icon-btn del', title: 'Xoá dòng (Ctrl+Delete)', ariaLabel: 'Xoá dòng', tabIndex: -1 });
    del.innerHTML = '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>';
    del.onclick = async () => {
      try {
        await api('DELETE', `/api/entries/${line.id}`);
        toast(`Đã xoá "${line.item_name}"`, {
          action: 'Hoàn tác',
          onAction: () =>
            api('POST', '/api/entries', { phieu: state.data.period.end, customer_id: c.id, date: line.date, lines: [line], saveToCatalog: false })
              .then(() => loadPeriod())
              .catch(fail),
        });
        await loadPeriod();
      } catch (e) {
        fail(e);
      }
    };

    // ×2 số lượng dòng này / hoàn về số lượng gốc
    const x2 = el('button', { className: 'icon-btn x2-btn', type: 'button', title: 'Nhân đôi số lượng dòng này', ariaLabel: 'Nhân đôi số lượng', tabIndex: -1, textContent: '×2' });
    x2.onclick = () => scaleLines([line.id], `"${sheetItemName(line)}"`);
    const back = el('button', { className: 'icon-btn back-btn', type: 'button', title: 'Hoàn về số lượng gốc', ariaLabel: 'Hoàn về số lượng gốc', tabIndex: -1 });
    back.innerHTML = '<svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 1 0 1.8-4.3M4 4v3.5h3.5"/></svg>';
    back.onclick = () => restoreLines([line.id]);
    const qtyCell = el('td', { className: 'c-qty' }, qty);
    const paintScale = () => {
      back.hidden = line.orig_qty == null;
      qtyCell.closest('tr')?.classList.toggle('scaled', line.orig_qty != null); // tô sáng cả dòng đã ×2
      qtyCell.querySelector('.scale-badge')?.remove();
      const b = scaleBadge(line);
      if (b) qtyCell.append(b);
    };
    paintScale();
    const doneBtn = el('button', { className: 'm-done', type: 'button', textContent: 'Xong', tabIndex: -1 });
    const tr = el('tr', { className: line.id === state.openLine ? 'open' : '' },
        el('td', { className: 'stt', textContent: i + 1 }),
        el('td', { className: 'c-date' }, date),
        el('td', { className: 'name' }, name),
        el('td', { className: 'c-unit' }, unit),
        qtyCell,
        el('td', { className: 'money c-price' }, price),
        amount,
        el('td', { className: 'c-act' }, el('span', { className: 'row-acts' }, back, x2, del), doneBtn),
        summary);
    tr.dataset.id = line.id;
    paintScale();
    summary.onclick = () => {
      state.openLine = line.id;
      tbody.querySelectorAll('tr.open').forEach((r) => r.classList.remove('open'));
      tr.classList.add('open');
      tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    doneBtn.onclick = () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // lưu ô đang gõ (change) rồi thu gọn
      state.openLine = null;
      tr.classList.remove('open');
    };
    tbody.append(tr);
  });

  // Ngày bán của dòng mới mặc định để trống; ngày gõ vào chỉ dùng cho dòng đang nhập.
  state.entryDate ??= '';
  $('#eDateCell').replaceChildren(dateCell(state.entryDate, { onChange: (v) => (state.entryDate = v) }));
  $('#eIndex').textContent = c.lines.length + 1; // STT của dòng sắp thêm
  $('#debt').value = moneyInput(c.debt);
  recalc(c);
  renderEntryRow();
  // Vẽ lại bảng (vd. đổi ngày làm dòng đổi chỗ) thì đưa con trỏ về đúng ô đang gõ.
  if (focused && !focused.input.isConnected) focusCell(rowOf(focused.row), focused.col);
}

/* ---------- ×2 số lượng / hoàn số lượng gốc ---------- */

/** Nhãn "×2", "×4"… cho dòng đã nhân (so với số lượng gốc). */
function scaleBadge(line) {
  if (line.orig_qty == null || !line.orig_qty) return null;
  const r = Math.round((line.qty / line.orig_qty) * 100) / 100;
  return el('span', { className: 'scale-badge', title: `Số lượng gốc: ${qtyInput(line.orig_qty)}`, textContent: `×${String(r).replace('.', ',')}` });
}

async function scaleLines(ids, what) {
  try {
    await api('POST', '/api/entries/scale', { ids, factor: 2 });
    await loadPeriod();
    toast(`Đã nhân đôi số lượng ${what}`, {
      action: 'Hoàn tác',
      onAction: () => api('POST', '/api/entries/scale', { ids, factor: 0.5 }).then(() => loadPeriod()).catch(fail),
    });
  } catch (e) {
    fail(e);
  }
}

async function restoreLines(ids) {
  try {
    const r = await api('POST', '/api/entries/restore', { ids });
    await loadPeriod();
    toast(r.restored ? `Đã hoàn ${r.restored > 1 ? `${r.restored} dòng` : 'dòng này'} về số lượng gốc` : 'Không có dòng nào cần hoàn');
  } catch (e) {
    fail(e);
  }
}

/* ---------- Di chuyển giữa các ô như Excel: Enter xuống hàng, Tab sang ô kế, mũi tên theo ô ---------- */

const gridRows = () => [...$('#lineRows').children, ...($('#entryRow').hidden ? [] : [$('#entryRow')])];

/** Hàng nhập mới ẩn được (×) cho bảng gọn như sheet; Enter / ↓ ở dòng cuối thì hiện lại. */
function renderEntryRow() {
  $('#entryRow').hidden = state.entryHidden && current()?.lines.length > 0;
}

function showEntryRow(show) {
  state.entryHidden = !show;
  store('hideEntry', show ? '0' : '1');
  if (!show) {
    ['#eItem', '#eUnit', '#eQty', '#ePrice'].forEach((s) => ($(s).value = ''));
    manual.clear();
    hideSuggest();
    updateEntryAmount();
  }
  renderEntryRow();
  if (show) focusCell($('#entryRow'), 1);
}
const rowOf = (key) => gridRows().find((tr) => (tr.dataset.id ?? 'entry') === key);

/** Ô đang gõ trong bảng hàng: { input, row (id dòng | 'entry'), col }. */
function activeCell() {
  const input = document.activeElement;
  if (!input?.dataset?.col || !input.closest('.lines')) return null;
  return { input, row: input.closest('tr').dataset.id ?? 'entry', col: Number(input.dataset.col) };
}

function focusCell(tr, col) {
  const input = tr?.querySelector(`input[data-col="${col}"]`);
  if (!input) return;
  input.focus({ preventScroll: true });
  input.select();
  keepInView(input);
}

const ENTRY_ROOM = 220; // chỗ trống chừa dưới hàng nhập mới cho danh sách gợi ý

/**
 * Cuộn trang (êm) để ô đang gõ không khuất dưới mép màn hình hay sau thanh trên cùng; ở hàng nhập mới
 * thì chừa thêm `room` px bên dưới cho danh sách gợi ý. Bảng dài thì hàng nhập luôn nằm trong tầm mắt.
 */
function keepInView(input, room = input.closest('#entryRow') ? ENTRY_ROOM : 12) {
  const r = input.getBoundingClientRect();
  const top = $('.topbar').getBoundingClientRect().bottom + 12;
  const below = r.bottom + room - visibleBottom();
  if (below > 0) scrollBy({ top: Math.min(below, r.top - top), behavior: 'smooth' });
  else if (r.top < top) scrollBy({ top: r.top - top, behavior: 'smooth' });
}

function onGridKeydown(e) {
  if (e.defaultPrevented || e.altKey || e.isComposing) return;
  const cell = activeCell();
  if (!cell) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Delete') {
    e.preventDefault();
    deleteRow(cell);
    return;
  }
  if (e.ctrlKey || e.metaKey) return;
  const rows = gridRows();
  const r = rows.indexOf(cell.input.closest('tr'));
  const { selectionStart: s, selectionEnd: t, value } = cell.input;
  const all = s === 0 && t === value.length;
  let to = null; // [hàng, cột]
  // Enter: đang ở ô ngày thì xuống ô ngày, ô khác thì xuống ô tên hàng.
  const enterCol = cell.col === 0 ? 0 : 1;
  if (e.key === 'Enter') to = [e.shiftKey ? r - 1 : r + 1, enterCol];
  else if (e.key === 'ArrowUp') to = [r - 1, cell.col];
  else if (e.key === 'ArrowDown') to = [r + 1, cell.col];
  else if (e.key === 'ArrowLeft' && (all || (s === 0 && t === 0))) to = [r, cell.col - 1];
  else if (e.key === 'ArrowRight' && (all || (s === value.length && t === value.length))) to = [r, cell.col + 1];
  if (!to) return;
  e.preventDefault();
  // Đang ẩn hàng nhập mới: Enter / ↓ ở dòng cuối thì hiện lại để gõ tiếp.
  if (to[0] === rows.length && $('#entryRow').hidden && (e.key === 'ArrowDown' || !e.shiftKey)) return showEntryRow(true);
  focusCell(rows[to[0]], to[1]);
}

/* ---------- Chữ nhỏ nằm trên / dưới: m^3 → m³, H_2O → H₂O, hoặc Ctrl+. / Ctrl+, (như Google Docs) ---------- */

const PLAIN = '0123456789+-=()';
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾';
const SUB = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎';
const scriptIndex = (ch) => [PLAIN, SUP, SUB].map((set) => set.indexOf(ch)).find((i) => i >= 0) ?? -1;

/** Đổi chữ sang kiểu `set` (SUP/SUB); nếu đã đúng kiểu đó rồi thì trả về chữ thường (bấm lại để bỏ). */
function toScript(text, set) {
  const chars = [...text];
  const undo = chars.every((ch) => scriptIndex(ch) < 0 || set.includes(ch));
  return chars.map((ch) => (scriptIndex(ch) < 0 ? ch : (undo ? PLAIN : set)[scriptIndex(ch)])).join('');
}

const isTextInput = (t) =>
  t instanceof HTMLInputElement && ['text', 'search', ''].includes(t.getAttribute('type') ?? '') &&
  !['numeric', 'decimal'].includes(t.inputMode) && !t.classList.contains('date-input');

/** Thay đoạn [s, t) như người dùng gõ (còn Ctrl+Z, và ô vẫn phát sự kiện input/change). */
function replaceRange(input, s, t, text) {
  input.setSelectionRange(s, t);
  document.execCommand('insertText', false, text);
}

/** Ctrl+. chữ trên, Ctrl+, chữ dưới: đổi phần bôi đen, không bôi đen thì đổi ký tự ngay trước con trỏ. */
function onScriptKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key !== '.' && e.key !== ',') || !isTextInput(e.target)) return;
  e.preventDefault();
  const input = e.target;
  const { selectionStart: s, selectionEnd: t } = input;
  const from = s === t ? s - 1 : s;
  if (from < 0) return;
  const text = toScript(input.value.slice(from, t), e.key === '.' ? SUP : SUB);
  replaceRange(input, from, t, text);
  if (s !== t) input.setSelectionRange(s, s + text.length);
}

/** Gõ ^3 → ³, _2 → ₂. */
function onScriptTyping(e) {
  if (e.inputType !== 'insertText' || !isTextInput(e.target)) return;
  const input = e.target;
  const pos = input.selectionStart;
  const mark = input.value[pos - 2];
  const i = PLAIN.indexOf(input.value[pos - 1]);
  if ((mark === '^' || mark === '_') && i >= 0) replaceRange(input, pos - 2, pos, (mark === '^' ? SUP : SUB)[i]);
}

/** Ctrl+Delete: xoá dòng đang đứng (có Hoàn tác), con trỏ sang dòng thế chỗ; ở hàng nhập mới thì xoá trắng hàng đó. */
async function deleteRow(cell) {
  const tr = cell.input.closest('tr');
  if (cell.row === 'entry') {
    // Hàng nhập đã trống: Ctrl+Delete lần nữa thì ẩn hàng đi, con trỏ về dòng cuối.
    const empty = ['#eItem', '#eUnit', '#eQty', '#ePrice'].every((s) => !$(s).value.trim());
    if (empty && current()?.lines.length) {
      showEntryRow(false);
      return focusCell(gridRows().at(-1), cell.col);
    }
    ['#eItem', '#eUnit', '#eQty', '#ePrice'].forEach((s) => ($(s).value = ''));
    manual.clear();
    hideSuggest();
    updateEntryAmount();
    return focusCell(tr, cell.col);
  }
  const r = gridRows().indexOf(tr);
  await tr.querySelector('.del').onclick();
  focusCell(gridRows()[r], cell.col);
}

/** Ctrl+S: lưu ô đang sửa (và dòng đang gõ nếu đã đủ), đợi các lệnh ghi xong rồi lưu lên Drive. */
async function saveShortcut() {
  const a = document.activeElement;
  if (a?.matches?.('input') && a.id !== 'eItem') {
    a.blur(); // phát sự kiện change → lưu ô đó
    a.focus();
  }
  if ($('#eItem').value.trim()) {
    await addLine();
    if ($('#eItem').value.trim()) return; // dòng chưa đủ, addLine đã chỉ ô còn thiếu
  }
  await Promise.allSettled([...inflight]);
  await syncNow(false);
}

function recalc(c) {
  c.total = c.lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0);
  c.grandTotal = c.total + (c.debt || 0);
  $('#sumLines').textContent = money(c.total);
  $('#grandTotal').textContent = money(c.grandTotal);
}

/* ---------- Dòng nhập mới: gõ "10 bao xi măng" → SL 10, ĐVT bao, tên "xi măng", giá theo bảng giá ---------- */

const UNITS = [
  'bao', 'cây', 'kg', 'xe', 'khối', 'm3', 'm2', 'm', 'mét', 'tấm', 'viên', 'thùng', 'lon', 'cái', 'cuộn', 'bộ',
  'tấn', 'ống', 'hộp', 'can', 'lít', 'sợi', 'thanh', 'chai', 'gói', 'tấc', 'phần', 'bịch', 'két', 'đôi', 'chiếc',
];
/** Bỏ dấu để tìm "xi mang" vẫn ra "xi măng"; NFKD đưa "m³" về "m3". */
const norm = (s) =>
  String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();

function unitSet() {
  const set = new Set(UNITS.map(norm));
  for (const p of state.products) if (p.unit) set.add(norm(p.unit));
  return set;
}

/** Tên chính + các tên khác của mặt hàng ("bao HT", "bao xi măng"). */
const namesOf = (p) => [p.name, ...(p.aliases ?? [])];

function findProduct(name) {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return (
    state.products.find((p) => namesOf(p).some((n) => n.toLowerCase() === key)) ??
    state.products.find((p) => namesOf(p).some((n) => norm(n) === norm(name)))
  );
}

/** "10 bao xi măng" | "69kg Đai" | "xi măng" → { qty, unit, name, product } */
function parseEntry(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const units = unitSet();
  let qty = null;
  let rest = t;
  const m = /^(\d+(?:[.,]\d+)?)( ?)(.*)$/.exec(t);
  if (m && m[3] && (m[2] || units.has(norm(m[3].split(' ')[0])))) {
    qty = parseQty(m[1]);
    rest = m[3];
  }
  // Tên hàng giữ cả ĐVT: "10 bao HT" → tên "bao HT", ĐVT bao.
  let product = findProduct(rest);
  let unit = null;
  if (!product) {
    const [first, ...others] = rest.split(' ');
    if (others.length && units.has(norm(first))) {
      unit = first;
      product = findProduct(others.join(' ')); // bảng giá cũ có thể lưu tên không kèm ĐVT ("xi măng")
    }
  }
  return { qty, unit: unit ?? product?.unit ?? null, name: product?.name ?? rest, product, typed: rest };
}

const manual = new Set(); // ô ĐVT / SL / giá mà người dùng tự gõ thì không tự điền đè lên

function updateEntryAmount() {
  const amt = Math.round(parseQty($('#eQty').value) * parseMoney($('#ePrice').value));
  $('#eAmount').textContent = amt ? money(amt) : '–';
}

function autofill() {
  const p = parseEntry($('#eItem').value);
  const set = (sel, v) => {
    if (!manual.has(sel)) $(sel).value = v;
  };
  set('#eQty', p.qty != null ? qtyInput(p.qty) : '');
  set('#eUnit', p.unit ?? '');
  set('#ePrice', p.product ? moneyInput(p.product.price) : '');
  updateEntryAmount();
  renderSuggest(p);
  return p;
}

let suggestions = [];
let activeSuggestion = -1;
let suggestFor = null; // { input, pick(product, qty) }: ô tên hàng đang hiện gợi ý (hàng nhập mới hoặc dòng đã có)

/**
 * Điện thoại: danh sách gợi ý nằm ngay dưới ô đang gõ (trong khung nhập, đẩy các ô dưới xuống) thay vì nổi đè lên —
 * bàn phím iPhone làm lệch toạ độ nên danh sách nổi hay che mất ô. Ẩn đi thì trả về chỗ cũ để không bị xoá theo dòng hàng.
 */
const SUGGEST_BOX = document.getElementById('suggest');
const inlineSuggest = () => matchMedia('(max-width: 640px)').matches;
function homeSuggest() {
  if (!SUGGEST_BOX.classList.contains('inline')) return;
  SUGGEST_BOX.classList.remove('inline');
  document.getElementById('customerSuggest').before(SUGGEST_BOX);
}

function hideSuggest() {
  $('#suggest').hidden = true;
  homeSuggest();
  suggestFor?.input.setAttribute('aria-expanded', 'false');
  suggestions = [];
  activeSuggestion = -1;
}

function positionSuggest() {
  const box = $('#suggest');
  if (box.hidden || !suggestFor) return;
  if (inlineSuggest()) {
    if (box.previousElementSibling !== suggestFor.input) suggestFor.input.after(box);
    box.classList.add('inline');
    box.removeAttribute('style');
    return;
  }
  homeSuggest();
  const r = suggestFor.input.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 380), innerWidth - 16);
  box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  box.style.width = `${width}px`;
  // Dưới ô không đủ chỗ (hàng nhập sát cuối trang) mà phía trên đủ: hiện danh sách lên trên ô.
  const bottom = visibleBottom();
  const top = Math.max($('.topbar').getBoundingClientRect().bottom, window.visualViewport?.offsetTop ?? 0);
  const below = bottom - r.bottom - 12;
  const above = r.top - top - 12;
  // Ưu tiên hiện dưới ô; chỉ lật lên trên khi dưới quá chật mà trên rộng hơn. Chiều cao co theo chỗ trống.
  const up = below < 160 && above > below;
  box.style.maxHeight = `${Math.max(120, Math.min(340, up ? above : below))}px`;
  const h = box.offsetHeight;
  box.style.top = `${up ? r.top - 4 - h : r.bottom + 4}px`;
}

/** Gợi ý mặt hàng cho ô `input` theo chữ đang gõ (đã tách số lượng). Tìm cả theo "ĐVT + tên". */
function renderSuggest(p, input = $('#eItem'), pick = pickEntrySuggestion) {
  if (suggestFor?.input !== input) hideSuggest();
  suggestFor = { input, pick };
  // Tìm theo chữ đang gõ ("ống"), không theo tên đã đổi ("gạch ống"), để vẫn thấy các mặt hàng khác có chữ "ống".
  const q = norm(p.typed ?? p.name);
  if (!q || document.activeElement !== input) return hideSuggest();
  const words = q.split(' ');
  // Tìm theo "ĐVT + tên" và theo từng tên khác; khớp tên khác thì ghi kèm tên đó cho dễ nhận ra.
  const hit = (text) => words.every((w) => norm(text).includes(w));
  const via = new Map();
  const typedAlias = p.product && (p.product.aliases ?? []).find((a) => norm(a) === q);
  if (typedAlias) via.set(p.product, typedAlias);
  suggestions = state.products
    .map((prod) => {
      // Tên khác bắt đầu bằng chữ đang gõ ("on" → "ống") thì ưu tiên tên khác đó.
      const full = hit(`${prod.unit} ${prod.name}`);
      const aliases = (prod.aliases ?? []).filter(hit);
      const alias = aliases.find((a) => norm(a).startsWith(q)) ?? (full ? null : aliases[0]);
      if (alias) via.set(prod, alias);
      const n = norm(alias ?? prod.name);
      return { prod, n, ok: prod === p.product || full || alias != null };
    })
    .filter((x) => x.ok)
    // Mặt hàng gõ đúng tên / tên khác lên đầu, rồi tới tên bắt đầu bằng chữ đang gõ, rồi tên ngắn.
    .sort((a, b) => (b.prod === p.product) - (a.prod === p.product) || b.n.startsWith(q) - a.n.startsWith(q) || a.n.length - b.n.length)
    .slice(0, 8)
    .map((x) => x.prod);
  if (suggestions.length === 1 && suggestions[0] === p.product) return hideSuggest();
  activeSuggestion = -1;

  const box = $('#suggest');
  box.replaceChildren(
    ...suggestions.map((s, i) =>
      el('li', { role: 'option', onmousedown: (e) => (e.preventDefault(), pickSuggestion(i)) },
        el('span', { className: 's-name' }, s.name, via.has(s) ? el('small', { className: 's-alias', textContent: ` = ${via.get(s)}` }) : ''),
        el('span', { className: 's-unit', textContent: s.unit }),
        el('span', { className: 's-price', textContent: money(s.price) })),
    ),
  );
  if (!suggestions.length) {
    if (p.product || input.id !== 'eItem') return hideSuggest();
    box.append(el('li', { className: 's-new', textContent: `"${p.name}" chưa có trong bảng giá. Nhập ĐVT và đơn giá, khi thêm dòng app sẽ tự lưu vào bảng giá.` }));
  }
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  positionSuggest();
  keepInView(input, box.offsetHeight + 12); // danh sách gợi ý dài: cuộn lên cho thấy hết
}

function highlight(i) {
  activeSuggestion = i;
  [...$('#suggest').children].forEach((li, k) => li.classList.toggle('active', k === i));
  $('#suggest').children[i]?.scrollIntoView({ block: 'nearest' });
}

function pickSuggestion(i) {
  const s = suggestions[i];
  if (!s || !suggestFor) return;
  const { input, pick } = suggestFor;
  const qty = parseEntry(input.value).qty;
  hideSuggest();
  pick(s, qty);
}

function pickEntrySuggestion(s, qty) {
  $('#eItem').value = qty != null ? `${String(qty)} ${s.name}` : s.name;
  manual.delete('#eUnit');
  manual.delete('#ePrice');
  autofill();
  hideSuggest();
  if (!parseQty($('#eQty').value)) $('#eQty').focus();
}

/** ↑ ↓ chọn gợi ý, Enter / Tab lấy gợi ý (chưa chọn thì lấy gợi ý đầu). Ở hàng nhập mới Enter (không có gợi ý) thì thêm dòng. */
function onNameKeydown(e) {
  const input = e.target;
  const open = !$('#suggest').hidden && suggestions.length > 0 && suggestFor?.input === input;
  if (e.key === 'Tab' && !e.shiftKey && open) {
    // Tên đã khớp đúng 1 mặt hàng và chưa chọn gợi ý nào: giữ nguyên, Tab sang ô kế như thường.
    if (activeSuggestion < 0 && parseEntry(input.value).product) return hideSuggest();
    pickSuggestion(Math.max(activeSuggestion, 0));
    if (document.activeElement !== input) e.preventDefault(); // đã tự nhảy sang ô số lượng
  } else if (e.key === 'ArrowDown' && open) {
    e.preventDefault();
    highlight((activeSuggestion + 1) % suggestions.length);
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault();
    highlight((activeSuggestion - 1 + suggestions.length) % suggestions.length);
  } else if (e.key === 'Escape') {
    hideSuggest();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    const p = parseEntry(input.value);
    if (open && activeSuggestion >= 0) pickSuggestion(activeSuggestion);
    else if (open && !p.product) pickSuggestion(0);
    else if (input.id === 'eItem') addLine();
    else return hideSuggest(); // dòng đã có: Enter xuống hàng như thường
    e.preventDefault();
  }
}

function trackManual(sel) {
  $(sel).addEventListener('input', (e) => {
    if (e.target.value.trim()) manual.add(sel);
    else manual.delete(sel);
    updateEntryAmount();
  });
}

/** Thêm dòng đang gõ; xong đưa con trỏ về ô `focusCol` của hàng nhập mới (0 = ngày, 1 = tên hàng). */
async function addLine({ focusCol = 1 } = {}) {
  let c = current();
  if (!c) return;
  const p = parseEntry($('#eItem').value);
  const line = {
    item_name: p.name.trim(),
    unit: $('#eUnit').value.trim(),
    qty: parseQty($('#eQty').value),
    price: parseMoney($('#ePrice').value),
  };
  if (!line.item_name && !line.qty && !line.price) return focusCell($('#entryRow'), focusCol);
  line.qty ||= 1; // "xe cát" không ghi số lượng → 1

  const known = p.product ?? (line.item_name ? findProduct(line.item_name) : null);
  let added;
  try {
    if (c.draft) {
      // Dòng đầu của phiếu bán lẻ mới: tạo sheet "14-11 Tên" rồi mới thêm hàng
      const sale = await api('POST', '/api/retail/sales', { date: state.meta.today, name: c.name });
      state.draft.name = '';
      state.selectedId = sale.id;
      c = sale;
    }
    added = await api('POST', '/api/entries', { phieu: state.data.period.end, customer_id: c.id, date: state.entryDate, lines: [line] });
  } catch (e) {
    return fail(e);
  }
  ['#eItem', '#eUnit', '#eQty', '#ePrice'].forEach((s) => ($(s).value = ''));
  state.entryDate = ''; // dòng sau để trống ngày (cùng ngày thì không ghi lại), cần thì gõ ngày mới
  // Đang gõ ở hàng nhập mà trước đó từng bấm × ẩn hàng nhập: thêm dòng xong vẫn giữ hàng nhập để gõ tiếp
  // (không thì dòng đầu tiên của khách mới vừa thêm xong là hàng nhập biến mất, Enter không ra hàng mới).
  if (state.entryHidden) {
    state.entryHidden = false;
    store('hideEntry', '0');
  }
  manual.clear();
  hideSuggest();
  updateEntryAmount();
  await Promise.all([loadPeriod(), loadProducts()]);

  if (!line.price && line.item_name) {
    // Hàng chưa có giá: vẫn thêm dòng, đưa con trỏ tới ô đơn giá của dòng vừa thêm để gõ giá.
    focusCell(rowOf(String(added.ids[0])), 4);
    toast(`Chưa có đơn giá cho "${line.item_name}", gõ giá vào ô Đơn giá`);
    return;
  }
  focusCell($('#entryRow'), focusCol);

  if (!line.item_name) return; // dòng không tên: không lưu vào bảng giá
  if (!known) {
    toast(`Đã lưu "${line.item_name}" vào bảng giá: ${money(line.price)}/${line.unit || 'đvt'}`);
  } else if (known.price !== line.price || (line.unit && known.unit !== line.unit)) {
    toast(`Giá "${known.name}" khác bảng giá (${money(known.price)})`, {
      action: `Cập nhật → ${money(line.price)}`,
      onAction: () =>
        api('PUT', `/api/products/${known.id}`, { price: line.price, unit: line.unit || known.unit })
          .then(loadProducts)
          .then(() => toast('Đã cập nhật bảng giá'))
          .catch(fail),
    });
  }
}

/* Gợi ý khách khi thêm vào phiếu: tìm không dấu, khách đã trong phiếu xếp cuối, có dòng "+ Thêm khách mới". */
let custOptions = [];
let custActive = -1;

function hideCustomerSuggest() {
  $('#customerSuggest').hidden = true;
  $('#newCustomer').setAttribute('aria-expanded', 'false');
  custOptions = [];
  custActive = -1;
}

function highlightCustomer(i) {
  custActive = i;
  [...$('#customerSuggest').children].forEach((li, k) => li.classList.toggle('active', k === i));
  $('#customerSuggest').children[i]?.scrollIntoView({ block: 'nearest' });
}

function renderCustomerSuggest() {
  const input = $('#newCustomer');
  if (document.activeElement !== input) return hideCustomerSuggest();
  const typed = input.value.trim();
  const q = norm(typed);
  const words = q ? q.split(' ') : [];
  const here = new Set(state.data.customers.map((c) => c.id));
  custOptions = state.customers
    .map((c) => ({ c, n: norm(c.name) }))
    .filter(({ n }) => words.every((w) => n.includes(w)))
    .sort((a, b) => here.has(a.c.id) - here.has(b.c.id) || b.n.startsWith(q) - a.n.startsWith(q) || a.c.name.localeCompare(b.c.name, 'vi'))
    .slice(0, 8)
    .map(({ c }) => ({ customer: c, name: c.name, here: here.has(c.id) }));
  if (q && !state.customers.some((c) => norm(c.name) === q)) custOptions.push({ name: typed, isNew: true });
  if (!custOptions.length) return hideCustomerSuggest();

  const box = $('#customerSuggest');
  box.replaceChildren(
    ...custOptions.map((o, i) =>
      el('li', { role: 'option', className: [o.isNew && 'new', o.here && 'here'].filter(Boolean).join(' '), onmousedown: (e) => (e.preventDefault(), pickCustomer(i)) },
        el('span', { className: 's-avatar', textContent: o.isNew ? '+' : o.name.trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase() }),
        el('span', { className: 's-name', textContent: o.isNew ? `Thêm khách mới "${o.name}"` : o.name }),
        el('span', { className: 's-unit', textContent: o.isNew ? '' : o.here ? 'Đã có trong phiếu' : o.customer.phone })),
    ),
  );
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  const r = $('#addCustomerForm').getBoundingClientRect();
  box.style.left = `${r.left}px`;
  box.style.top = `${r.bottom + 6}px`;
  box.style.width = `${Math.max(r.width, 300)}px`;
  highlightCustomer(q ? 0 : -1);
}

function onCustomerKeydown(e) {
  const open = !$('#customerSuggest').hidden && custOptions.length > 0;
  if (e.key === 'ArrowDown' && open) {
    e.preventDefault();
    highlightCustomer((custActive + 1) % custOptions.length);
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault();
    highlightCustomer((custActive - 1 + custOptions.length) % custOptions.length);
  } else if (e.key === 'Escape') {
    hideCustomerSuggest();
  }
}

function pickCustomer(i) {
  const o = custOptions[i];
  hideCustomerSuggest();
  if (!o) return;
  if (o.here) {
    $('#newCustomer').value = '';
    return selectCustomer(o.customer.id);
  }
  addCustomerNamed(o.name);
}

function addCustomer(ev) {
  ev.preventDefault();
  if (!$('#customerSuggest').hidden && custActive >= 0) return pickCustomer(custActive);
  addCustomerNamed($('#newCustomer').value);
}

/** Thêm khách vào phiếu; tên trống = thêm 1 khách mới chưa có tên (đặt tên sau ở ô Họ tên khách hàng). */
async function addCustomerNamed(raw) {
  const input = $('#newCustomer');
  const name = String(raw ?? '').trim();
  try {
    const c = await api('POST', `/api/phieu/${state.data.period.end}/customers`, { name });
    input.value = '';
    await Promise.all([loadPeriod(), loadCustomers()]);
    selectCustomer(c.id);
  } catch (e) {
    fail(e);
  }
}

async function removeFromPhieu(c) {
  const used = Boolean(c.lines.length || c.debt);
  if (used) {
    const what = [c.lines.length && `${c.lines.length} dòng hàng`, c.debt && `nợ cũ ${money(c.debt)}`].filter(Boolean).join(' và ');
    const yes = await confirmDialog({
      title: state.retail ? `Xoá phiếu bán lẻ ${customerLabel(c)}?` : `Xoá ${customerLabel(c)} khỏi phiếu này?`,
      message: state.retail ? `${what} sẽ bị xoá.` : `${what} của khách trong phiếu ngày ${dmy(state.data.period.end)} sẽ bị xoá. Khách vẫn còn trong danh sách khách hàng.`,
      ok: 'Xoá khỏi phiếu',
      danger: true,
    });
    if (!yes) return;
  }
  try {
    await api('DELETE', `/api/phieu/${state.data.period.end}/customers/${c.id}${used ? '?force=1' : ''}`);
    if (state.selectedId === c.id) state.selectedId = null;
    await loadPeriod();
  } catch (e) {
    fail(e);
  }
}

/* ---------- Bảng giá ---------- */

async function loadProducts() {
  state.products = await api('GET', '/api/products');
  if (!$('#view-products').hidden) renderProducts();
}

/** "2026-10-28 11:57:28" → "28/10/2026 11:57:28" */
const dmyTime = (s) => `${dmy(s.slice(0, 10))} ${s.slice(11, 19)}`;

// Sắp xếp bảng giá: bấm tiêu đề cột để đổi; mặc định theo đơn giá tăng dần. Nhớ lựa chọn trên máy này.
const PRODUCT_SORTS = {
  name: (a, b) => a.name.localeCompare(b.name, 'vi'),
  unit: (a, b) => a.unit.localeCompare(b.unit, 'vi') || a.name.localeCompare(b.name, 'vi'),
  price: (a, b) => a.price - b.price || a.name.localeCompare(b.name, 'vi'),
  updated: (a, b) => a.updated_at.localeCompare(b.updated_at) || a.name.localeCompare(b.name, 'vi'),
};
let productSort = (() => {
  const [key, dir] = (store('productSort') ?? '').split(':');
  return PRODUCT_SORTS[key] ? { key, dir: dir === 'desc' ? 'desc' : 'asc' } : { key: 'price', dir: 'asc' };
})();

function sortProductsBy(key) {
  // Cột ngày cập nhật bấm lần đầu thì mới nhất lên trước; cột khác tăng dần.
  const first = key === 'updated' ? 'desc' : 'asc';
  productSort = { key, dir: productSort.key === key ? (productSort.dir === 'asc' ? 'desc' : 'asc') : first };
  store('productSort', `${key}:${productSort.dir}`);
  renderProducts();
}

function renderProducts() {
  const q = norm($('#productSearch').value);
  const sign = productSort.dir === 'desc' ? -1 : 1;
  const list = state.products
    .filter((p) => !q || namesOf(p).some((n) => norm(n).includes(q)))
    .sort((a, b) => sign * PRODUCT_SORTS[productSort.key](a, b));
  for (const th of document.querySelectorAll('#productHead th[data-sort]')) {
    const on = th.dataset.sort === productSort.key;
    th.classList.toggle('sorted', on);
    th.setAttribute('aria-sort', on ? (productSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }
  $('#productCount').textContent = `${state.products.length} mặt hàng`;
  const tbody = $('#productRows');
  tbody.replaceChildren();
  if (!list.length) {
    tbody.append(el('tr', { className: 'empty-row' }, el('td', { colSpan: 5, textContent: q ? 'Không tìm thấy mặt hàng.' : 'Chưa có mặt hàng nào. Bấm "Nhập giá từ phiếu cũ" để lấy giá từ các phiếu trên Drive, hoặc thêm ở ô phía trên.' })));
    return;
  }
  for (const p of list) {
    const save = (patch) =>
      api('PUT', `/api/products/${p.id}`, patch)
        .then((np) => (Object.assign(p, np), renderProducts(), loadProducts()))
        .catch((e) => (fail(e), renderProducts()));
    const name = el('input', { value: p.name, onchange: (e) => save({ name: e.target.value }) });
    const unit = el('input', { value: p.unit, onchange: (e) => save({ unit: e.target.value }) });
    const price = el('input', { value: moneyInput(p.price), inputMode: 'numeric', onchange: (e) => save({ price: parseMoney(e.target.value) }) });

    const row = el('tr', {},
      el('td', {}, el('div', { className: 'name-wrap' }, name, aliasChips(p))),
      el('td', {}, unit),
      el('td', { className: 'num' }, price),
      el('td', { className: 'meta', textContent: dmyTime(p.updated_at) }),
      el('td', { className: 'actions' },
        el('button', { className: 'link-btn', textContent: 'Lịch sử giá', onclick: () => toggleHistory(row, p) }),
        el('button', {
          className: 'link-btn',
          textContent: 'Xoá',
          onclick: async () => {
            const yes = await confirmDialog({
              title: `Xoá "${p.name}"?`,
              message: 'Mặt hàng sẽ bị xoá khỏi bảng giá cùng lịch sử giá và tên khác. Các phiếu đã bán không bị ảnh hưởng.',
              ok: 'Xoá',
              danger: true,
            });
            if (!yes) return;
            await api('DELETE', `/api/products/${p.id}`).catch(fail);
            loadProducts();
          },
        })),
    );
    tbody.append(row);
  }
}

/** Các tên khác của mặt hàng: chip có nút xoá, và nút "+ tên khác" để thêm. */
function aliasChips(p) {
  const box = el('div', { className: 'aliases' });
  const refresh = (np) => (Object.assign(p, np), loadProducts());
  for (const a of p.aliases ?? []) {
    box.append(
      el('span', { className: 'alias-chip', title: `Gõ "${a}" cũng ra mặt hàng này` },
        a,
        el('button', {
          type: 'button',
          ariaLabel: `Bỏ tên khác "${a}"`,
          textContent: '×',
          onclick: () => api('DELETE', `/api/products/${p.id}/aliases?alias=${encodeURIComponent(a)}`).then(refresh).catch(fail),
        })),
    );
  }
  const add = el('button', { type: 'button', className: 'link-btn alias-add', textContent: '+ Tên khác', title: 'Tên gọi khác của mặt hàng này, vd. "bao xi măng" cho "bao HT"' });
  add.onclick = () => {
    const input = el('input', { className: 'alias-input', placeholder: 'vd: bao xi măng', ariaLabel: 'Tên khác' });
    let busy = false; // hộp xác nhận làm ô mất focus (blur) → tránh gửi 2 lần
    const submit = async () => {
      const alias = input.value.trim();
      if (!alias) return input.replaceWith(add);
      if (busy) return;
      busy = true;
      try {
        refresh(await api('POST', `/api/products/${p.id}/aliases`, { alias }));
      } catch (e) {
        if (e.code !== 'ALIAS_IS_PRODUCT') return fail(e);
        const yes = await confirmDialog({
          title: `Gộp vào "${p.name}"?`,
          message: `${e.message}. Mặt hàng kia sẽ bị xoá khỏi bảng giá và trở thành tên khác của "${p.name}" (giữ giá ${money(p.price)}).`,
          ok: 'Gộp',
        });
        if (!yes) return input.replaceWith(add);
        refresh(await api('POST', `/api/products/${p.id}/aliases`, { alias, merge: true }).catch(fail));
      } finally {
        busy = false;
      }
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') (e.preventDefault(), submit());
      if (e.key === 'Escape') input.replaceWith(add);
    };
    input.onblur = () => input.isConnected && (input.value.trim() ? submit() : input.replaceWith(add));
    add.replaceWith(input);
    input.focus();
  };
  box.append(add);
  return box;
}

/** Lịch sử giá ngay dưới mặt hàng: mỗi lần đổi giá 1 hàng, giá nằm ở cột Đơn giá, thời điểm ở cột Cập nhật. */
async function toggleHistory(row, p) {
  if (row.nextElementSibling?.classList.contains('history')) {
    while (row.nextElementSibling?.classList.contains('history')) row.nextElementSibling.remove();
    return;
  }
  const hist = await api('GET', `/api/products/${p.id}/history`).catch(fail);
  if (!hist) return;
  if (!hist.length) return row.after(el('tr', { className: 'history' }, el('td', { colSpan: 5, textContent: 'Chưa có lịch sử giá.' })));
  row.after(
    ...hist.map((h, i) =>
      el('tr', { className: 'history' },
        i === 0 ? el('td', { className: 'history-label', rowSpan: hist.length, colSpan: 2, textContent: `Lịch sử giá · ${hist.length} lần` }) : '',
        el('td', { className: 'num history-price', textContent: money(h.price) }),
        el('td', { className: 'meta', textContent: dmyTime(h.changed_at) }),
        el('td'))),
  );
}

async function addProduct(ev) {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api('POST', '/api/products', { name: f.name.value, unit: f.unit.value, price: parseMoney(f.price.value) });
    f.reset();
    f.name.focus();
    await loadProducts();
  } catch (e) {
    fail(e);
  }
}

/* ---------- Nhập giá từ phiếu cũ: chọn nguồn → đọc → duyệt → lưu ---------- */

const NOT_GOODS = /chuyển\s*khoản|thanh\s*toán|trả\s*tiền|tạm\s*ứng|tổng|nợ\s*cũ|kiểm\s*phiếu/i;
let importItems = [];

const fileDateKey = (name) => {
  const m = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(name ?? '');
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};

function importStep(step) {
  $('#importSource').hidden = step !== 'source';
  $('#importProgress').hidden = step !== 'progress';
  $('#importReview').hidden = step !== 'review';
}

async function openImportDialog() {
  importStep('source');
  $('#importDialog').showModal();
  const months = $('#importMonths');
  const year = $('#importYear');
  year.replaceChildren();
  if (!state.meta.drive.connected) {
    year.hidden = true;
    months.replaceChildren(el('p', { className: 'muted', textContent: 'Kết nối Google Drive để đọc giá thẳng từ các phiếu trên Drive.' }));
    $('#importReadDrive').disabled = true;
    return;
  }
  year.hidden = false;
  $('#importReadDrive').disabled = false;
  months.replaceChildren(el('p', { className: 'muted', textContent: 'Đang tải danh sách từ Drive…' }));
  try {
    const years = await api('GET', '/api/drive/years');
    const want = Number(state.date.slice(0, 4));
    renderYearChips(year, years, years.includes(want) ? want : years[0], () => renderImportMonths().catch(fail));
    await renderImportMonths();
  } catch (e) {
    months.replaceChildren(el('p', { className: 'error-text', textContent: e.message }));
  }
}

/* Chọn phiếu trên Drive để lấy giá, dạng cây: tháng → phiếu (file) → sheet (khách). */
let importGroups = []; // [{ key, label, files }]
const importSel = new Map(); // fileId → { file, sheets: Set | null }  (null = mọi sheet)
const importOpen = new Set(); // tháng / fileId đang mở
const sheetLists = new Map(); // fileId → [{ sheet, customer, lines }] | 'loading' | Error

async function renderImportMonths() {
  const box = $('#importMonths');
  box.replaceChildren(el('p', { className: 'muted tree-note', textContent: 'Đang tải danh sách từ Drive…' }));
  const files = (await fetchDriveFiles($('#importYear').dataset.year))
    .filter((f) => f.date)
    .sort((a, b) => a.date.localeCompare(b.date)); // tháng 1 → 12
  const groups = new Map();
  for (const f of files) {
    if (!groups.has(f.month)) groups.set(f.month, []);
    groups.get(f.month).push(f);
  }
  importGroups = [...groups].map(([key, list]) => ({ key, label: `Tháng ${Number(list[0].date.slice(5, 7))}`, files: list }));
  importSel.clear();
  importOpen.clear();
  // Mặc định: mở và chọn cả tháng gần nhất.
  const last = importGroups.at(-1);
  if (last) {
    importOpen.add(last.key);
    for (const f of last.files) importSel.set(f.id, { file: f, sheets: null });
  }
  drawImportTree();
}

const treeCheck = (checked, onchange, indeterminate = false) => {
  const c = el('input', { type: 'checkbox', checked, onchange });
  c.indeterminate = indeterminate;
  return c;
};
const treeToggle = (open, onclick, label) =>
  el('button', { type: 'button', className: `tree-toggle${open ? ' open' : ''}`, ariaLabel: label, innerHTML: '<svg viewBox="0 0 20 20"><path d="M7.5 5l5 5-5 5"/></svg>', onclick });

function toggleOpen(key) {
  if (importOpen.has(key)) importOpen.delete(key);
  else importOpen.add(key);
  drawImportTree();
}

function drawImportTree() {
  const box = $('#importMonths');
  const top = box.scrollTop;
  if (!importGroups.length) box.replaceChildren(el('p', { className: 'muted tree-note', textContent: 'Không có phiếu nào trong năm này.' }));
  else box.replaceChildren(...importGroups.map(drawImportMonth));
  box.scrollTop = top;
  const n = importSel.size;
  $('#importPickInfo').textContent = n ? `Đã chọn ${n} phiếu` : 'Chưa chọn phiếu nào';
  $('#importReadDrive').disabled = !n;
}

function drawImportMonth(g) {
  const picked = g.files.filter((f) => importSel.has(f.id)).length;
  const open = importOpen.has(g.key);
  const pickAll = (on) => {
    for (const f of g.files) {
      if (!on) importSel.delete(f.id);
      else if (!importSel.has(f.id)) importSel.set(f.id, { file: f, sheets: null });
    }
    drawImportTree();
  };
  return el('div', { className: 'tree-group' },
    el('div', { className: 'tree-row month' },
      treeToggle(open, () => toggleOpen(g.key), `Mở ${g.label}`),
      treeCheck(picked === g.files.length, (e) => pickAll(e.target.checked), picked > 0 && picked < g.files.length),
      el('button', { type: 'button', className: 'tree-label', textContent: g.label, title: `Thư mục "${g.key}"`, onclick: () => toggleOpen(g.key) }),
      el('span', { className: 'tree-meta', textContent: picked ? `${picked}/${g.files.length} phiếu` : `${g.files.length} phiếu` })),
    open ? el('div', { className: 'tree-children' }, g.files.map(drawImportFile)) : null);
}

function drawImportFile(f) {
  const sel = importSel.get(f.id);
  const open = importOpen.has(f.id);
  const list = sheetLists.get(f.id);
  let children = null;
  if (open && list === 'loading') children = el('p', { className: 'muted tree-note', textContent: 'Đang đọc danh sách sheet…' });
  else if (open && list instanceof Error) children = el('p', { className: 'error-text tree-note', textContent: list.message });
  else if (open && list) {
    const used = list.filter((s) => s.lines > 0);
    const hidden = list.length - used.length;
    children = used.length
      ? [
        ...used.map((s) =>
          el('label', { className: 'tree-row sheet' },
            treeCheck(Boolean(sel) && (!sel.sheets || sel.sheets.has(s.sheet)), (e) => toggleSheet(f, used, s.sheet, e.target.checked)),
            el('span', { className: 'tree-label', textContent: s.customer, title: `Sheet "${s.sheet}"` }),
            el('span', { className: 'tree-meta', textContent: `${s.lines} dòng` }))),
        hidden ? el('p', { className: 'muted tree-note', textContent: `${hidden} sheet trống đã ẩn` }) : null,
      ]
      : el('p', { className: 'muted tree-note', textContent: 'Phiếu này không có sheet nào có hàng.' });
  }
  return el('div', { className: 'tree-group' },
    el('div', { className: 'tree-row file' },
      treeToggle(open, () => openFileSheets(f), 'Chọn sheet'),
      treeCheck(Boolean(sel), (e) => {
        if (e.target.checked) importSel.set(f.id, { file: f, sheets: null });
        else importSel.delete(f.id);
        drawImportTree();
      }, Boolean(sel?.sheets)),
      el('button', { type: 'button', className: 'tree-label', title: f.name, onclick: () => openFileSheets(f) },
        el('b', { textContent: dm(f.date) }), el('span', { className: 'muted', textContent: f.name })),
      el('span', { className: 'tree-meta', textContent: !sel ? '' : sel.sheets ? `${sel.sheets.size} sheet` : 'Tất cả sheet' })),
    children ? el('div', { className: 'tree-children' }, children) : null);
}

/** Mở / đóng danh sách sheet của 1 phiếu (lần đầu mở thì đọc file từ Drive). */
async function openFileSheets(f) {
  if (importOpen.has(f.id)) return toggleOpen(f.id);
  importOpen.add(f.id);
  if (!Array.isArray(sheetLists.get(f.id))) {
    sheetLists.set(f.id, 'loading');
    drawImportTree();
    try {
      sheetLists.set(f.id, await api('POST', '/api/drive/sheets', { fileId: f.id }));
    } catch (e) {
      sheetLists.set(f.id, e);
    }
  }
  drawImportTree();
}

function toggleSheet(f, used, sheet, on) {
  const sel = importSel.get(f.id) ?? { file: f, sheets: new Set() };
  const set = sel.sheets ?? new Set(used.map((s) => s.sheet));
  if (on) set.add(sheet);
  else set.delete(sheet);
  if (!set.size) importSel.delete(f.id);
  else importSel.set(f.id, { ...sel, sheets: set.size === used.length ? null : set });
  drawImportTree();
}

function selectAllImport() {
  for (const g of importGroups) for (const f of g.files) if (!importSel.has(f.id)) importSel.set(f.id, { file: f, sheets: null });
  drawImportTree();
}

/** Đọc lần lượt từng phiếu (cũ → mới) để giá mới hơn ghi đè giá cũ hơn. */
async function readPrices(sources) {
  sources.sort((a, b) => a.date.localeCompare(b.date));
  const results = [];
  const failed = [];
  importStep('progress');
  for (const [i, s] of sources.entries()) {
    $('#importProgress').textContent = `Đang đọc ${i + 1}/${sources.length}: ${s.name}`;
    try {
      results.push({ ...s, items: (await s.read()).items });
    } catch (e) {
      failed.push(`${s.name}: ${e.message}`);
    }
  }
  failed.forEach((m) => toast(m, { error: true, timeout: 8000 }));
  if (!results.length) return importStep('source');
  showImportReview(results);
}

function readFromDrive() {
  const picked = [...importSel.values()];
  if (!picked.length) return toast('Chọn ít nhất 1 phiếu', { error: true });
  readPrices(
    picked.map(({ file: f, sheets }) => ({
      name: f.name,
      date: f.date,
      read: () => api('POST', '/api/products/parse-drive', { fileId: f.id, sheets: sheets ? [...sheets] : null }),
    })),
  );
}

function readFromComputer(ev) {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length) return;
  readPrices(
    files.map((f) => ({
      name: f.name,
      date: fileDateKey(f.name) || new Date(f.lastModified).toISOString().slice(0, 10),
      read: async () => {
        const headers = { 'Content-Type': 'application/octet-stream' };
        if (fileDateKey(f.name)) headers['X-File-Date'] = fileDateKey(f.name);
        const res = await apiFetch('/api/products/parse', { method: 'POST', headers, body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        return data;
      },
    })),
  );
}

/** Gộp giá các phiếu (phiếu mới hơn thắng), so với bảng giá hiện tại. */
function showImportReview(results) {
  // Mỗi mặt hàng lấy giá ở dòng có ngày bán mới nhất trên mọi phiếu đã chọn.
  const latest = new Map();
  for (const r of results) {
    for (const it of r.items) {
      const item = { ...it, from: it.date || r.date };
      const prev = latest.get(norm(it.name));
      if (!prev || item.from >= prev.from) latest.set(norm(it.name), item);
    }
  }
  const catalog = new Map(state.products.flatMap((p) => namesOf(p).map((n) => [norm(n), p])));

  importItems = [...latest.values()].map((it) => {
    const cur = catalog.get(norm(it.name)) ?? (it.unit ? catalog.get(norm(`${it.unit} ${it.name}`)) : undefined);
    // Khác ĐVT (vd. "các" theo thùng vs theo tấc) thường là cách bán khác, không phải đổi giá.
    const otherUnit = cur && it.unit && cur.unit && norm(cur.unit) !== norm(it.unit);
    const status = !cur ? 'new' : otherUnit ? 'unit' : cur.price !== it.price || (it.unit && cur.unit !== it.unit) ? 'changed' : 'same';
    const warn = NOT_GOODS.test(it.name) ? 'Có vẻ không phải hàng' : !it.unit ? 'Thiếu ĐVT' : '';
    const checked = (status === 'new' || status === 'changed') && !NOT_GOODS.test(it.name);
    return { id: cur?.id, name: cur?.name ?? it.name, unit: it.unit || cur?.unit || '', price: it.price, cur, status, warn, from: it.from, checked };
  });
  const order = { changed: 0, unit: 1, new: 2, same: 3 };
  importItems.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'vi'));
  $('#importShowSame').checked = false;
  importStep('review');
  renderImportRows();
}

function renderImportRows() {
  const showSame = $('#importShowSame').checked;
  const tbody = $('#importRows');
  tbody.replaceChildren();
  for (const it of importItems) {
    if (it.status === 'same' && !showSame) continue;
    const check = el('input', { type: 'checkbox', checked: it.checked, onchange: (e) => ((it.checked = e.target.checked), updateImportSummary()) });
    const name = el('input', { value: it.name, onchange: (e) => (it.name = e.target.value.trim()) });
    const unit = el('input', { value: it.unit, onchange: (e) => (it.unit = e.target.value.trim()) });
    const price = el('input', { value: moneyInput(it.price), inputMode: 'numeric', onchange: (e) => ((it.price = parseMoney(e.target.value)), (e.target.value = moneyInput(it.price))) });
    const notes = el('td', { className: 'notes' },
      it.status === 'new' ? el('span', { className: 'chip new', textContent: 'Mới' }) : null,
      it.status === 'changed' ? el('span', { className: 'chip warn', textContent: 'Đổi giá' }) : null,
      it.status === 'unit' ? el('span', { className: 'chip bad', textContent: `Khác ĐVT (đang là ${it.cur.unit})` }) : null,
      it.status === 'same' ? el('span', { className: 'chip', textContent: 'Không đổi' }) : null,
      it.warn ? el('span', { className: 'chip bad', textContent: it.warn }) : null,
      el('span', { className: 'from', title: it.from, textContent: `bán ${dm(it.from)}/${it.from.slice(2, 4)}` }));
    tbody.append(
      el('tr', { className: it.checked ? '' : 'off' },
        el('td', { className: 'w-check' }, check),
        el('td', {}, name),
        el('td', {}, unit),
        el('td', { className: 'num' }, price),
        el('td', { className: 'num cur', textContent: it.cur ? `${money(it.cur.price)}${it.cur.unit && it.cur.unit !== it.unit ? ` / ${it.cur.unit}` : ''}` : '—' }),
        notes),
    );
    check.addEventListener('change', () => check.closest('tr').classList.toggle('off', !check.checked));
  }
  updateImportSummary();
}

function updateImportSummary() {
  const count = (s) => importItems.filter((i) => i.status === s).length;
  const checked = importItems.filter((i) => i.checked).length;
  const unit = count('unit') ? ` · ${count('unit')} khác ĐVT` : '';
  $('#importSummary').textContent = `${count('new')} hàng mới · ${count('changed')} đổi giá${unit} · ${count('same')} không đổi`;
  $('#importSave').textContent = checked ? `Lưu ${checked} mặt hàng` : 'Chưa chọn mặt hàng nào';
  $('#importSave').disabled = !checked;
  const visible = importItems.filter((i) => i.status !== 'same' || $('#importShowSame').checked);
  $('#importCheckAll').checked = visible.length > 0 && visible.every((i) => i.checked);
}

async function saveImport() {
  const items = importItems.filter((i) => i.checked && i.name).map(({ id, name, unit, price }) => ({ id, name, unit, price }));
  $('#importSave').disabled = true;
  try {
    const r = await api('POST', '/api/products/apply', { items });
    $('#importDialog').close();
    await loadProducts();
    renderProducts();
    toast(`Đã lưu: ${r.created} mặt hàng mới, ${r.updated} mặt hàng cập nhật`, { timeout: 6000 });
  } catch (e) {
    fail(e);
    $('#importSave').disabled = false;
  }
}

/* ---------- Khách hàng ---------- */

async function loadCustomers() {
  state.customers = await api('GET', '/api/customers');
  if (!$('#view-customers').hidden) renderCustomers();
}

function renderCustomers() {
  const q = $('#customerSearch').value.trim().toLowerCase();
  const list = state.customers.filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));
  $('#customerTotal').textContent = `${state.customers.length} khách hàng`;
  const tbody = $('#customerRows');
  tbody.replaceChildren();
  if (!list.length) {
    tbody.append(el('tr', { className: 'empty-row' }, el('td', { colSpan: 4, textContent: 'Chưa có khách hàng.' })));
    return;
  }
  for (const c of list) {
    const save = (patch) =>
      api('PUT', `/api/customers/${c.id}`, patch)
        .then(() => Promise.all([loadCustomers(), loadPeriod()]))
        .catch((e) => (fail(e), renderCustomers()));
    tbody.append(
      el('tr', {},
        el('td', {}, el('input', { value: c.name, placeholder: 'Chưa có tên', onchange: (e) => save({ name: e.target.value }) })),
        el('td', {}, el('input', { value: c.phone, inputMode: 'tel', placeholder: '—', onchange: (e) => save({ phone: e.target.value }) })),
        el('td', {}, el('input', { value: c.address, placeholder: '—', onchange: (e) => save({ address: e.target.value }) })),
        el('td', { className: 'actions' },
          el('button', {
            className: 'link-btn',
            textContent: 'Xoá',
            onclick: async () => {
              const yes = await confirmDialog({ title: `Xoá khách ${customerLabel(c)}?`, ok: 'Xoá', danger: true });
              if (!yes) return;
              try {
                await api('DELETE', `/api/customers/${c.id}`).catch(async (e) => {
                  if (e.code !== 'HAS_ENTRIES') throw e;
                  const force = await confirmDialog({
                    title: `${e.message}. Xoá luôn?`,
                    message: 'Các dòng hàng, nợ cũ và sheet của khách trong những phiếu đó cũng bị xoá (file trên Drive sẽ được cập nhật). Không hoàn tác được.',
                    ok: 'Xoá khách và dòng hàng',
                    danger: true,
                  });
                  if (force) await api('DELETE', `/api/customers/${c.id}?force=1`);
                });
              } catch (e) {
                fail(e);
              }
              if (state.selectedId === c.id) state.selectedId = null;
              await Promise.all([loadCustomers(), loadPeriod()]);
            },
          }))),
    );
  }
}

/* ---------- In phiếu: dựng lại đúng bố cục sheet trong file Excel (server/excel.js) ---------- */

const SHEET_COLS = [5.86, 8.57, 15.29, 6, 9.43, 10.29, 13.29]; // độ rộng cột A–G của sheet khách
const SUMMARY_COLS = [5, 21.14, 14.43, 13.14]; // cột A–D của sheet tổng kết
const SHEET_MIN_LINES = 1; // in đúng số dòng hàng, không chừa hàng trống (giống lineCount ở server/excel.js)
const SUMMARY_MIN_ROWS = 1; // phiếu tổng kết in đúng số khách (giống summaryCount ở server/excel.js)

// Tên đã tự ghi lượng ("30 bao xi măng", "1/2 xe cát", "nửa xe đá mi", "hai khối cát") thì không ghép số lượng vào trước nữa.
const QTY_LEAD = /^(\d+([.,/]\d+)?|nửa|nữa|rưỡi|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|vài|mấy)\s/iu;

/** Tên hàng như trên sheet: "10 bao xi măng" (giống displayName ở server/excel.js). */
function sheetItemName(line) {
  const name = line.item_name;
  if (!name || !state.meta.nameWithQty || !line.qty) return name;
  if (QTY_LEAD.test(name.normalize('NFC'))) return name;
  return `${qf.format(line.qty)} ${name}`; // chỉ ghép số lượng, ĐVT đã có cột riêng
}

/** Định dạng kế toán của sheet: 0 hiện "-", ô trống để trống. */
const sheetMoney = (n) => (n == null ? '' : n ? nf.format(Math.round(n)) : '-');
const dmyShort = (d) => `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;

const cell = (text, { span = 1, rows = 1, cls = '' } = {}) =>
  el('td', { colSpan: span, rowSpan: rows, className: cls, textContent: text ?? '' });

function sheetRow(heightPt, ...cells) {
  const tr = el('tr', {}, cells);
  tr.style.height = `${heightPt}pt`;
  return tr;
}

function sheetTable(cols, className) {
  const total = cols.reduce((s, w) => s + w, 0);
  const colgroup = el('colgroup', {}, cols.map((w) => {
    const col = el('col');
    col.style.width = `${(w / total) * 100}%`;
    return col;
  }));
  return el('table', { className }, colgroup);
}

const SHEET_HEADERS = ['STT', 'NGÀY', 'TÊN HÀNG', 'ĐVT', 'SỐ LƯỢNG', 'ĐƠN GIÁ', 'THÀNH TIỀN'];
const PRINT_WIDTH_PX = 511; // khổ A5 trừ lề trái/phải 0.25in
let measureCtx;

function textWidth(text, bold = false) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${bold ? 'bold ' : ''}10pt Arial, Helvetica, sans-serif`;
  return measureCtx.measureText(String(text ?? '')).width;
}

/**
 * Độ rộng cột (px) theo nội dung: cột số/ngày/ĐVT nới ra cho vừa (không bóp, không xuống dòng),
 * cột TÊN HÀNG lấy phần còn lại và xuống dòng nếu dài.
 */
function sheetColumnWidths(rows, totals) {
  const widths = SHEET_COLS.map((w, c) => {
    if (c === 2) return 0;
    let px = textWidth(SHEET_HEADERS[c], true);
    for (const row of rows) px = Math.max(px, textWidth(row[c]));
    if (c === 6) for (const t of totals) px = Math.max(px, textWidth(t, true));
    return Math.max(w * 7 + 5, Math.ceil(px + 12));
  });
  widths[2] = Math.max(80, PRINT_WIDTH_PX - widths.reduce((s, w) => s + w, 0));
  return widths;
}

function printCustomerSheet(c) {
  const { shop } = state.meta;
  const count = Math.max(SHEET_MIN_LINES, c.lines.length);
  let prevDate = null;
  const rows = Array.from({ length: count }, (_, i) => {
    const line = c.lines[i];
    const date = line?.date && line.date !== prevDate ? dm(line.date) : '';
    if (line) prevDate = line.date;
    return [
      String(i + 1),
      date,
      line ? sheetItemName(line) : '',
      line?.unit ?? '',
      line?.qty ? qf.format(line.qty) : '',
      line ? sheetMoney(line.price) : '',
      sheetMoney(line ? line.qty * line.price : 0),
    ];
  });
  const totals = [['TỔNG CỘNG', c.total], ['NỢ CŨ', c.debt || null], ['TỔNG TIỀN', c.grandTotal]].map(([label, v]) => [label, sheetMoney(v)]);

  const table = sheetTable(sheetColumnWidths(rows, totals.map((t) => t[1])), 'ps');
  const body = el('tbody');
  const qr = el('td', { className: 'qr-cell', rowSpan: 3 }, el('img', { src: apiUrl('/qr'), alt: '' }));
  body.append(
    sheetRow(14.25, cell('', { span: 3 }), cell(shop.tagline[0], { span: 4, cls: 'b' })),
    sheetRow(14.25, cell(shop.name, { span: 3, cls: 'b' }), cell(shop.tagline[1], { span: 4, cls: 'b' })),
    sheetRow(14.25, cell(shop.address1, { span: 3 }), cell(shop.tagline[2], { span: 4, cls: 'b' })),
    sheetRow(14.25, cell(shop.address2, { span: 3 }), cell(shop.tagline[3], { span: 4, cls: 'b' })),
    sheetRow(14.25, cell(shop.phone, { span: 3, cls: 'b' }), cell('', { span: 3 }), qr),
    sheetRow(14.25, cell(shop.bank, { span: 6, cls: 'b l' })),
    sheetRow(26.25, cell('HÓA ĐƠN BÁN LẺ', { span: 6, cls: 'b title' })),
    sheetRow(14.25, cell('Họ Tên Khách Hàng: ', { span: 3, cls: 'b' }), cell(c.label ?? c.name, { span: 4, cls: 'b' })),
    sheetRow(25.5, ...SHEET_HEADERS.map((h) => cell(h, { cls: 'b box head' }))),
  );

  const colCls = ['box', 'box', 'box l', 'box', 'box', 'box n', 'box n'];
  for (const row of rows) body.append(sheetRow(15.75, ...row.map((text, k) => cell(text, { cls: colCls[k] }))));
  for (const [label, value] of totals) {
    body.append(sheetRow(15.75, cell(label, { span: 6, cls: 'b box' }), cell(value, { cls: 'b box n' })));
  }
  body.append(
    sheetRow(12.75, cell('', { span: 7 })),
    sheetRow(14.25, cell(''), cell('Ngày Kiểm Phiếu: ', { span: 2, cls: 'b' }), cell(dmyShort(new Date()), { span: 4, cls: 'b' })),
    sheetRow(14.25, cell('', { span: 3 }), cell('ĐÃ NHẬN ĐỦ TIỀN', { span: 4, cls: 'b' })),
  );
  table.append(body);
  return table;
}

function printSummarySheet() {
  const { period } = state.data;
  const list = periodCustomers().filter((c) => !c.draft);
  const table = sheetTable(SUMMARY_COLS, 'ps tongket');
  const body = el('tbody');
  body.append(
    period.retail
      ? sheetRow(15, cell('Bán lẻ tháng', { span: 2 }), cell(`${Number(period.end.slice(6, 8))}/${period.end.slice(1, 5)}`, { span: 2 }))
      : sheetRow(15, cell(`${period.endDayName} ngày `, { span: 2 }), cell(dmyShort(toUTC(period.end)), { span: 2 })),
    sheetRow(15, cell('Phiếu Tổng Kết Tiền', { span: 4, rows: 2 })),
    sheetRow(15),
    sheetRow(30, ...['STT', 'Tên Khách Hàng ', 'Số Tiền ', 'Số Tiền\nCòn Lại'].map((h) => cell(h, { cls: 'box wrap' }))),
  );
  const count = Math.max(SUMMARY_MIN_ROWS, list.length);
  for (let i = 0; i < count; i++) {
    const c = list[i];
    body.append(sheetRow(15,
      cell(i + 1, { cls: 'box' }),
      cell(c?.name, { cls: 'box wrap' }), // tên khách dài thì xuống dòng trong ô, không tràn sang cột Số Tiền
      cell(c ? sheetMoney(c.grandTotal) : '', { cls: 'box n' }),
      cell('', { cls: 'box' }),
    ));
  }
  body.append(sheetRow(15,
    cell('Tổng Kết Tiền Tuần Này', { span: 2, cls: 'box' }),
    cell(sheetMoney(list.reduce((s, c) => s + c.grandTotal, 0)), { cls: 'box n' }),
    cell('', { cls: 'box' }),
  ));
  table.append(body);
  return table;
}

/** Việc cần in: { ids: id các khách (theo thứ tự trong phiếu), summary: in kèm phiếu tổng kết }. */
const defaultPrintJob = () => ({ ids: [current() ?? periodCustomers()].flat().map((c) => c.id), summary: false });

/** Dựng bản in; trả về false (kèm thông báo) nếu không có gì để in. */
function fillPrintArea({ ids, summary }) {
  const area = $('#printArea');
  area.replaceChildren();
  if (!state.data) return false;
  const list = periodCustomers().filter((c) => ids.includes(c.id));
  if (!list.length && !summary) {
    toast(periodCustomers().length ? 'Chưa chọn khách nào để in' : 'Phiếu này chưa có khách nào', { error: true });
    return false;
  }
  if (summary) area.append(el('div', { className: 'print-page tongket' }, printSummarySheet()));
  area.append(...list.map((c) => el('div', { className: 'print-page' }, printCustomerSheet(c))));
  fitPrintPages(area);
  return true;
}

/**
 * Phiếu chỉ dài hơn 1 tờ A5 một chút (vd. tên hàng xuống nhiều dòng) thì thu nhỏ cho vừa 1 tờ,
 * như "Fit to page" của Excel; dài hẳn (thu quá 25%) thì để sang trang sau cho chữ khỏi quá nhỏ.
 */
function fitPrintPages(area) {
  const A5 = { width: 559, height: 793 }; // px @96dpi
  area.style.cssText = `display:block;position:absolute;left:-10000px;top:0;width:${A5.width}px`;
  for (const page of area.querySelectorAll('.print-page')) {
    const table = page.querySelector('table');
    const cs = getComputedStyle(page);
    const ratio = (A5.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 4) / table.offsetHeight;
    if (ratio < 1 && ratio >= 0.75) table.style.zoom = ratio.toFixed(3);
  }
  area.style.cssText = '';
}

let printing = false;

async function printPhieu(job) {
  closePrintMenu();
  if (printing) return;
  printing = true;
  try {
    // Lưu ô đang sửa và đợi các lệnh ghi xong để bản in có số mới nhất.
    const a = document.activeElement;
    if (a?.matches?.('input') && a.id !== 'eItem') a.blur();
    await Promise.allSettled([...inflight]);
    if (typeof job === 'function') job = job(); // dựng danh sách sau khi số liệu đã cập nhật
    if (job) job = { ...job, ids: job.ids.filter((id) => id !== 0) }; // bỏ phiếu bán lẻ nháp chưa lưu
    if (USE_PDF_PRINT) return await printPdf(job);
    if (!fillPrintArea(job)) return;
    await Promise.allSettled([...$('#printArea').querySelectorAll('img')].map((img) => img.decode()));
    print();
  } finally {
    printing = false;
  }
}

/* Hộp "Chọn khách để in" (Ctrl+P): mặc định tích tất cả khách và in kèm phiếu tổng kết. */
const pickedPrintIds = () => [...$('#printList').querySelectorAll('input:checked')].map((i) => Number(i.value));

function updatePrintPick() {
  const boxes = [...$('#printList').querySelectorAll('input')];
  const n = boxes.filter((b) => b.checked).length;
  $('#printCheckAll').checked = n > 0 && n === boxes.length;
  $('#printCheckAll').indeterminate = n > 0 && n < boxes.length;
  $('#printPicked').textContent = `Đã chọn ${n}/${boxes.length} khách`;
  const pages = n + ($('#printWithSummary').checked ? 1 : 0);
  $('#printGo').lastChild.textContent = pages ? ` In ${pages} tờ` : ' In';
  $('#printGo').disabled = !pages;
}

function openPrintDialog() {
  closePrintMenu();
  const list = periodCustomers();
  if (!list.length) return toast('Phiếu này chưa có khách nào', { error: true });
  $('#printSub').textContent = `Phiếu ngày ${dmy(state.data.period.end)} · mỗi khách in 1 tờ A5`;
  $('#printList').replaceChildren(...list.map((c) =>
    el('li', {},
      el('label', {},
        el('input', { type: 'checkbox', value: c.id, checked: true, onchange: updatePrintPick }),
        el('span', { className: 'p-name', textContent: customerLabel(c) },
          el('span', { className: 'p-meta', textContent: c.lines.length ? `${c.lines.length} dòng hàng` : 'Chưa có hàng' })),
        el('span', { className: 'p-total', textContent: money(c.grandTotal) })))));
  $('#printWithSummary').checked = true;
  updatePrintPick();
  $('#printDialog').showModal();
  $('#printGo').focus(); // Enter là in luôn
}

function closePrintMenu() {
  $('#printMenu').hidden = true;
  $('#btnPrint').setAttribute('aria-expanded', 'false');
}

function togglePrintMenu() {
  const menu = $('#printMenu');
  if (!menu.hidden) return closePrintMenu();
  menu.hidden = false;
  $('#btnPrint').setAttribute('aria-expanded', 'true');
  menu.querySelector('button').focus();
}

/* ---------- Tabs & khởi động ---------- */

function bind() {
  addEventListener('hashchange', () => route().then(() => scrollTo(0, 0)).catch(fail));
  $('#btnExport').onclick = (e) => {
    e.preventDefault();
    downloadExport().catch(fail);
  };
  $('#btnAccount').onclick = () => openAccount().catch(fail);
  startAutoSync();
  setupMobile();
  $('#pdfClose').onclick = () => $('#pdfDialog').close();
  // In: chia sẻ file PDF (iPhone: chọn "In" trong bảng chia sẻ) — phải bấm trực tiếp nên mới cần hộp này
  $('#pdfShare').onclick = async () => {
    if (!pdfReady) return;
    if (navigator.canShare?.({ files: [pdfReady.file] })) {
      try {
        await navigator.share({ files: [pdfReady.file], title: pdfReady.file.name });
      } catch {
        /* người dùng đóng bảng chia sẻ */
      }
    } else window.open(pdfReady.url, '_blank');
  };
  $('#pdfOpen').onclick = () => pdfReady && window.open(pdfReady.url, '_blank');
  document.addEventListener('input', () => (lastTyping = Date.now()), true);
  enableSheetDrag($('#customerList'));
  // Menu chuột phải: đóng khi bấm ra ngoài / Esc / cuộn
  document.addEventListener('mousedown', (e) => ctxMenu && !ctxMenu.contains(e.target) && closeCtxMenu());
  document.addEventListener('touchstart', (e) => ctxMenu && !ctxMenu.contains(e.target) && closeCtxMenu(), { passive: true });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeCtxMenu());
  addEventListener('scroll', closeCtxMenu, true);
  addEventListener('resize', closeCtxMenu);
  // Hộp sao chép sheet
  $('#copyForm').onsubmit = submitCopy;
  $('#copyForm').addEventListener('change', (e) => e.target.name === 'where' && syncCopyForm());
  $('#copyClose').onclick = $('#copyCancel').onclick = () => $('#copyDialog').close();
  $('#copyDate').onclick = async () => {
    if (calendar?.anchor === $('#copyDate')) return closeCalendar();
    const list = await api('GET', '/api/phieus').catch(() => []);
    openCalendar($('#copyDate'), copyDate, (d) => {
      copyDate = d;
      syncCopyForm();
    }, { marks: new Set(list.map((p) => p.date)), markLabel: 'Ngày đã có phiếu' });
  };
  $('#accountClose').onclick = () => $('#accountDialog').close();
  $('#revokeOthers').onclick = async () => {
    const yes = await confirmDialog({
      title: 'Đăng xuất tất cả máy khác?',
      message: 'Mọi điện thoại / máy tính khác phải nhập lại mật khẩu. Máy này vẫn giữ đăng nhập.',
      ok: 'Đăng xuất máy khác',
      danger: true,
    });
    if (!yes) return;
    try {
      const r = await api('POST', '/api/account/sessions/revoke-others');
      toast(r.removed ? `Đã đăng xuất ${r.removed} máy khác` : 'Không còn máy nào khác đang đăng nhập');
      await openAccount();
    } catch (e) {
      fail(e);
    }
  };
  $('#btnLogout').onclick = async () => {
    if ($('#accountDialog').open) $('#accountDialog').close();
    if (!(await confirmDialog({ title: 'Đăng xuất máy này?', message: 'Lần sau mở app trên máy này sẽ phải nhập lại mật khẩu.', ok: 'Đăng xuất' }))) return;
    await api('POST', '/api/logout').catch(() => {});
    clearToken();
    location.replace('login.html');
  };
  // Phiếu ngày khác: chọn ngày trên lịch (chấm = ngày đã có phiếu)
  $('#btnNewPhieu').onclick = () => {
    if (calendar?.anchor === $('#btnNewPhieu')) return closeCalendar();
    openCalendar($('#btnNewPhieu'), state.meta.today, (d) => (location.hash = `#/phieu/${d}`), {
      marks: new Set((browser.app ?? []).map((p) => p.date)),
      markLabel: 'Ngày đã có phiếu',
    });
  };

  // Lịch ngày phiếu: chấm các ngày đã có phiếu trong app.
  $('#saleDate').onclick = async () => {
    if (calendar?.anchor === $('#saleDate')) return closeCalendar();
    const list = await api('GET', '/api/phieus').catch(() => []);
    openCalendar($('#saleDate'), state.date, (d) => goToDate(d).catch(fail), {
      marks: new Set(list.map((p) => p.date)),
      markLabel: 'Ngày đã có phiếu',
    });
  };
  document.addEventListener('mousedown', (e) => {
    if (calendar && !calendar.box.contains(e.target) && !calendar.anchor.contains(e.target)) closeCalendar();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeCalendar());
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!$('#view-invoice').hidden && state.data) saveShortcut().catch(fail);
    }
    // Ctrl+P ở trang phiếu: mở bảng chọn khách để in (đang mở thì in luôn).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p' && !$('#view-invoice').hidden && state.data) {
      e.preventDefault();
      if ($('#printDialog').open) $('#printGo').click();
      else openPrintDialog();
    }
  });

  $('#btnPrint').onclick = togglePrintMenu;
  const printActions = {
    current: () => (current() ? printPhieu(() => ({ ids: [current().id], summary: false })).catch(fail) : toast('Chọn một khách ở bên trái để in phiếu', { error: true })),
    pick: openPrintDialog,
    summary: () => printPhieu({ ids: [], summary: true }).catch(fail),
  };
  $('#printMenu').querySelectorAll('[data-print]').forEach((b) => (b.onclick = () => {
    closePrintMenu();
    printActions[b.dataset.print]();
  }));
  $('#printClose').onclick = $('#printCancel').onclick = () => $('#printDialog').close();
  $('#printCheckAll').onchange = (e) => {
    $('#printList').querySelectorAll('input').forEach((i) => (i.checked = e.target.checked));
    updatePrintPick();
  };
  $('#printWithSummary').onchange = updatePrintPick;
  $('#printGo').onclick = () => {
    const job = { ids: pickedPrintIds(), summary: $('#printWithSummary').checked };
    $('#printDialog').close();
    printPhieu(job).catch(fail);
  };
  $('#printMenu').addEventListener('keydown', (e) => {
    const items = [...$('#printMenu').querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
    if (e.key === 'Escape') {
      closePrintMenu();
      $('#btnPrint').focus();
    }
  });
  document.addEventListener('mousedown', (e) => !e.target.closest('.menu-wrap') && closePrintMenu());
  // In bằng menu của trình duyệt ở trang phiếu cũng ra mẫu sheet; in xong thì dọn bản in.
  addEventListener('beforeprint', () => {
    if (!printing && !$('#printArea').children.length && !$('#view-invoice').hidden) fillPrintArea(defaultPrintJob());
  });
  addEventListener('afterprint', () => $('#printArea').replaceChildren());
  $('.lines').addEventListener('keydown', onGridKeydown);
  document.addEventListener('keydown', onScriptKey);
  document.addEventListener('input', onScriptTyping);
  addEventListener('resize', closeCalendar);
  $('#prevPhieu').onclick = () => state.data.prev && goToDate(state.data.prev).catch(fail);
  $('#nextPhieu').onclick = () => state.data.next && goToDate(state.data.next).catch(fail);
  $('#btnSync').onclick = () => syncNow(false);
  $('#addCustomerForm').onsubmit = addCustomer;
  $('#newCustomer').addEventListener('input', renderCustomerSuggest);
  $('#newCustomer').addEventListener('focus', renderCustomerSuggest);
  $('#newCustomer').addEventListener('blur', hideCustomerSuggest);
  $('#newCustomer').addEventListener('keydown', onCustomerKeydown);
  addEventListener('resize', hideCustomerSuggest);

  $('#customerName').onchange = async (e) => {
    const c = current();
    if (c?.draft) return void (c.name = e.target.value.trim()); // phiếu bán lẻ chưa lưu: giữ tên, lưu cùng dòng hàng đầu
    try {
      if (state.retail) {
        await api('PUT', `/api/retail/sales/${c.id}`, { name: e.target.value });
        return void (await loadPeriod({ keepRows: true }));
      }
      await api('PUT', `/api/customers/${c.id}`, { name: e.target.value });
      await Promise.all([loadPeriod({ keepRows: true }), loadCustomers()]);
    } catch (err) {
      fail(err);
      e.target.value = c.name;
    }
  };

  $('#debt').onchange = async (e) => {
    const c = current();
    const amount = parseMoney(e.target.value);
    e.target.value = moneyInput(amount);
    c.debt = amount;
    recalc(c);
    try {
      await api('PUT', '/api/debts', { customer_id: c.id, date: state.data.period.end, amount });
      await loadPeriod({ keepRows: true });
    } catch (err) {
      fail(err);
    }
  };

  $('#eItem').addEventListener('input', autofill);
  $('#eItem').addEventListener('focus', autofill);
  $('#eItem').addEventListener('blur', hideSuggest);
  $('#eItem').addEventListener('keydown', onNameKeydown);
  ['#eUnit', '#eQty', '#ePrice'].forEach(trackManual);
  $('#ePrice').addEventListener('blur', (e) => (e.target.value = moneyInput(parseMoney(e.target.value))));
  addEventListener('resize', positionSuggest);
  addEventListener('scroll', positionSuggest, true);
  $('#eAdd').onclick = addLine;
  $('#eHide').onclick = () => showEntryRow(false);
  // Bấm chuột / Tab vào ô trong bảng hàng: kéo cho ô (và chỗ gợi ý của hàng nhập) nằm trong màn hình.
  $('#lineRows').closest('table').addEventListener('focusin', (e) => e.target.matches('input') && keepInView(e.target));
  // Hàng nhập đang ẩn và chưa đứng ở ô nào: Enter là hiện hàng nhập để gõ.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || !$('#entryRow').hidden || !$('#paper').offsetParent) return; // chỉ khi đang xem tờ phiếu
    if (document.activeElement !== document.body || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    showEntryRow(true);
  });
  $('#entryRow').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.id !== 'eItem') {
      e.preventDefault();
      // Enter đã bị chặn nên ô ngày chưa phát "change": phát trước để dòng mới lấy đúng ngày vừa gõ.
      const fromDate = e.target.classList.contains('date-input');
      if (fromDate) e.target.dispatchEvent(new Event('change'));
      addLine({ focusCol: fromDate ? 0 : 1 });
    }
  });

  $('#productSearch').oninput = renderProducts;
  document.querySelectorAll('#productHead th[data-sort]').forEach((th) => (th.querySelector('button').onclick = () => sortProductsBy(th.dataset.sort)));
  $('#addProductForm').onsubmit = addProduct;
  $('#btnImportPrices').onclick = openImportDialog;
  $('#importClose').onclick = () => $('#importDialog').close();
  $('#importPickAll').onclick = selectAllImport;
  $('#importReadDrive').onclick = readFromDrive;
  $('#importFiles').onchange = readFromComputer;
  $('#importShowSame').onchange = renderImportRows;
  $('#importCheckAll').onchange = (e) => {
    const showSame = $('#importShowSame').checked;
    importItems.forEach((i) => (i.status !== 'same' || showSame) && (i.checked = e.target.checked));
    renderImportRows();
  };
  $('#importBack').onclick = () => importStep('source');
  $('#importSave').onclick = saveImport;
  $('#addProductForm').price.addEventListener('blur', (e) => (e.target.value = moneyInput(parseMoney(e.target.value))));
  $('#customerSearch').oninput = renderCustomers;
}

async function init() {
  bind();
  await loadMeta();

  const params = new URLSearchParams(location.search);
  if (params.has('drive')) toast('Đã kết nối Google Drive');
  if (params.has('drive_error')) toast(params.get('drive_error'), { error: true, timeout: 8000 });
  if (params.size) history.replaceState(null, '', location.pathname + location.hash);
  $('.qr').src = apiUrl('/qr');

  $('#btnToday').href = `#/phieu/${state.meta.today}`;
  await Promise.all([loadProducts(), loadCustomers()]);
  await route();
}

/** Tự tải lại trang khi code thay đổi (xem server/livereload.js). */
function liveReload() {
  let boot = null;
  const es = new EventSource('/__reload');
  es.onmessage = (e) => {
    if (boot && boot !== e.data) location.reload(); // server vừa khởi động lại với code mới
    boot = e.data;
  };
  es.addEventListener('reload', () => location.reload());
}

if (!API) liveReload();
init().catch(fail);
