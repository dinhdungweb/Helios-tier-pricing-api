'use strict';

/**
 * Staff page for the lucky wheel, served by GET /api/lucky-wheel.
 * Contains no data: everything is loaded after the staff member enters the
 * admin password (LUCKY_WHEEL_ADMIN_KEY), kept only in sessionStorage.
 */
module.exports = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Vòng quay – Quản trị</title>
<style>
  :root {
    --bg: #0d0d0d; --surface: #151515; --surface-2: #1d1d1d; --border: #2a2a2a;
    --text: #f2f2f2; --muted: #8c8c8c; --gold: #f5c45a; --green: #3ecf8e; --red: #ef5b5b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  a { color: var(--gold); }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; letter-spacing: .02em; }
  h1 span { color: var(--gold); }
  h2 { margin: 0 0 12px; font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); padding: 18px; margin-bottom: 16px; }
  .btn { height: 36px; padding: 0 14px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; font: inherit; font-weight: 600; }
  .btn:hover { border-color: #555; }
  .btn--gold { background: var(--gold); border-color: var(--gold); color: #1b1203; }
  .btn--sm { height: 30px; padding: 0 10px; font-size: 12px; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn--danger { background: transparent; border-color: rgba(239,91,91,.5); color: var(--red); }
  .btn--danger:hover { border-color: var(--red); background: rgba(239,91,91,.08); }
  .danger { border-color: rgba(239,91,91,.35); }
  .danger h2 { color: var(--red); }
  .danger p { margin: 0 0 12px; color: var(--muted); }
  .row-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
  input, select { height: 36px; padding: 0 10px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font: inherit; }
  .login { max-width: 360px; margin: 12vh auto; text-align: center; }
  .login input { width: 100%; margin: 14px 0 10px; }
  .login .btn { width: 100%; }
  .err { color: var(--red); min-height: 20px; margin-top: 8px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .stat { background: var(--surface-2); border: 1px solid var(--border); padding: 14px; }
  .stat b { display: block; font-size: 24px; color: var(--gold); font-variant-numeric: tabular-nums; }
  .stat small { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; }
  tr:hover td { background: rgba(255,255,255,.02); }
  .bar { height: 6px; background: var(--surface-2); margin-top: 6px; min-width: 80px; }
  .bar i { display: block; height: 100%; background: var(--gold); }
  .pill { display: inline-block; padding: 2px 8px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); white-space: nowrap; }
  .pill--win { color: var(--gold); border-color: rgba(245,196,90,.4); }
  .pill--card { color: #b9b9ff; border-color: rgba(185,185,255,.35); }
  .pill--sent { color: var(--green); border-color: rgba(62,207,142,.4); }
  .pill--pending { color: var(--text); }
  .pill--expired { color: var(--muted); }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .toolbar input { flex: 1 1 220px; }
  .muted { color: var(--muted); }
  .table-wrap { overflow-x: auto; }
  .times { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .times span { font-size: 12px; padding: 2px 6px; border: 1px solid var(--border); }
  .times span.done { color: var(--muted); text-decoration: line-through; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <section class="login card" id="login">
    <h1>Vòng quay <span>Quản trị</span></h1>
    <input type="password" id="key" placeholder="Mật khẩu quản trị" autocomplete="current-password">
    <button class="btn btn--gold" id="loginBtn">Đăng nhập</button>
    <div class="err" id="loginErr"></div>
  </section>

  <main id="app" hidden>
    <header>
      <h1>Vòng quay <span>Quản trị</span></h1>
      <div class="toolbar" style="margin:0">
        <button class="btn" id="refresh">Tải lại</button>
        <button class="btn" id="logout">Đăng xuất</button>
      </div>
    </header>

    <section class="card">
      <h2>Tổng quan</h2>
      <div class="stats" id="stats"></div>
      <div class="times" id="times"></div>
    </section>

    <section class="card">
      <h2>Tồn kho quà</h2>
      <div class="table-wrap"><table id="stock"></table></div>
    </section>

    <section class="card">
      <h2>Danh sách quà đã phát</h2>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Tìm tên, email, SĐT, mã khách…">
        <select id="fType">
          <option value="">Tất cả loại</option>
          <option value="win">Quà 1–9</option>
          <option value="card">Thẻ chương</option>
        </select>
        <select id="fStatus">
          <option value="">Tất cả trạng thái</option>
          <option value="pending">Chưa gửi</option>
          <option value="sent">Đã gửi</option>
          <option value="expired">Hết hạn (chưa gửi)</option>
        </select>
        <button class="btn" id="csv">Xuất CSV</button>
      </div>
      <div class="muted" id="count" style="margin-bottom:8px"></div>
      <div class="table-wrap"><table id="list"></table></div>
    </section>

    <section class="card danger">
      <h2>Vùng nguy hiểm</h2>
      <p>Xoá toàn bộ dữ liệu của chiến dịch hiện tại: lượt quay, sổ quà, quà trong tài khoản khách và bộ đếm tồn kho. Dùng để dọn dữ liệu quay thử trước khi chạy thật. <b>Không thể hoàn tác.</b></p>
      <div class="toolbar" style="margin:0">
        <input type="text" id="resetConfirm" placeholder="Gõ XOA để xác nhận" autocomplete="off" style="flex:0 1 220px">
        <button class="btn btn--danger" id="resetBtn">Xoá toàn bộ dữ liệu chiến dịch</button>
      </div>
    </section>
  </main>
</div>

<script>
(function () {
  var API = location.pathname;
  var KEY_STORE = 'lw_admin_key';
  var key = '';
  try { key = sessionStorage.getItem(KEY_STORE) || ''; } catch (e) {}
  var entries = [];
  var shop = '';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (iso) { return iso ? new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : ''; };
  var fmtDay = function (iso) { return iso ? new Date(iso).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : ''; };

  function call(action, extra) {
    var body = Object.assign({ action: action, admin_key: key }, extra || {});
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Lỗi'); e.code = d.code; throw e; } return d; }); });
  }

  function login() {
    key = $('key').value.trim();
    $('loginErr').textContent = '';
    load().then(function () {
      try { sessionStorage.setItem(KEY_STORE, key); } catch (e) {}
    }).catch(function (e) {
      $('loginErr').textContent = e.message;
      key = '';
    });
  }

  function load() {
    return Promise.all([call('admin_overview'), call('admin_list')]).then(function (res) {
      $('login').hidden = true;
      $('app').hidden = false;
      entries = res[1].entries || [];
      shop = res[1].shop || '';
      renderOverview(res[0]);
      renderList();
    });
  }

  function renderOverview(o) {
    var c = o.campaign || {};
    var statusText = { active: 'Đang chạy', not_started: 'Chưa bắt đầu', ended: 'Đã kết thúc', disabled: 'Đang tắt' }[c.status] || c.status;
    var totalStock = 0, totalAwarded = 0;
    (o.prizes || []).forEach(function (p) { totalStock += p.stock; totalAwarded += p.awarded; });
    $('stats').innerHTML =
      stat(statusText, 'Trạng thái · ' + esc(fmtDay(c.start_at)) + ' → ' + esc(fmtDay(c.end_at))) +
      stat(o.today.spins, 'Lượt quay hôm nay') +
      stat(o.today.wins + ' / ' + c.wins_per_day, 'Lượt trúng quà hôm nay') +
      stat(totalAwarded + ' / ' + totalStock, 'Quà 1–9 đã phát') +
      stat(entries.filter(function (e) { return e.status !== 'sent'; }).length, 'Quà chờ gửi');
    var now = Date.now();
    $('times').innerHTML = '<span class="muted" style="border:0;padding-left:0">Mốc trúng hôm nay (tỉ lệ trúng tại mốc: ' + Math.round((c.win_chance || 1) * 100) + '%):</span>' +
      (o.today.win_times || []).map(function (t, i) {
        return '<span class="' + (i < o.today.wins ? 'done' : '') + '">' + new Date(t).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false }) +
          (new Date(t).getTime() > now ? '' : (i < o.today.wins ? '' : ' (đang mở)')) + '</span>';
      }).join('') + (o.today.win_times && o.today.win_times.length ? '' : '<span>Chưa tạo (tạo ở lượt quay đầu tiên trong ngày)</span>');

    $('stock').innerHTML = '<thead><tr><th>#</th><th>Quà</th><th>Tổng</th><th>Đã phát</th><th>Còn lại</th></tr></thead><tbody>' +
      (o.prizes || []).map(function (p, i) {
        var pct = p.stock ? Math.round(p.awarded / p.stock * 100) : 0;
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(p.name) + '<div class="bar"><i style="width:' + pct + '%"></i></div></td><td>' + p.stock + '</td><td>' + p.awarded + '</td><td><b style="color:' + (p.left ? 'var(--text)' : 'var(--red)') + '">' + p.left + '</b></td></tr>';
      }).join('') +
      '<tr><td>10</td><td>' + esc((o.consolation || {}).name || 'Thẻ chương') + ' <span class="muted">(lượt không trúng)</span></td><td>∞</td><td>' +
        entries.filter(function (e) { return e.type === 'card'; }).length + '</td><td>∞</td></tr></tbody>';
  }

  function stat(value, label) {
    return '<div class="stat"><b>' + esc(value) + '</b><small>' + label + '</small></div>';
  }

  function statusOf(e) {
    if (e.status === 'sent') return 'sent';
    return new Date(e.expires_at).getTime() < Date.now() ? 'expired' : 'pending';
  }

  function filtered() {
    var q = $('q').value.trim().toLowerCase();
    var t = $('fType').value, st = $('fStatus').value;
    return entries.filter(function (e) {
      if (t && e.type !== t) return false;
      if (st && statusOf(e) !== st) return false;
      if (!q) return true;
      var c = e.customer || {};
      return [c.name, c.email, c.phone, e.customer_id, e.name].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderList() {
    var rows = filtered();
    $('count').textContent = rows.length + ' / ' + entries.length + ' mục';
    $('list').innerHTML = '<thead><tr><th>Thời gian</th><th>Khách hàng</th><th>Quà</th><th>Hạn</th><th>Trạng thái</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (e) {
        var c = e.customer || {};
        var st = statusOf(e);
        var stLabel = { sent: 'Đã gửi ' + fmtDay(e.sent_at), pending: 'Chưa gửi', expired: 'Hết hạn' }[st];
        var custUrl = shop ? 'https://admin.shopify.com/store/' + shop.replace('.myshopify.com', '') + '/customers/' + e.customer_id : '#';
        return '<tr>' +
          '<td>' + esc(fmt(e.at)) + '</td>' +
          '<td><a href="' + custUrl + '" target="_blank" rel="noopener">' + esc(c.name || ('#' + e.customer_id)) + '</a><br><span class="muted">' + esc(c.email || '') + (c.phone ? ' · ' + esc(c.phone) : '') + '</span></td>' +
          '<td><span class="pill pill--' + e.type + '">' + (e.type === 'win' ? 'Quà' : 'Thẻ') + '</span> ' + esc(e.name) + '</td>' +
          '<td>' + esc(fmtDay(e.expires_at)) + '</td>' +
          '<td><span class="pill pill--' + st + '">' + esc(stLabel) + '</span></td>' +
          '<td><div class="row-actions">' + (e.status === 'sent'
            ? '<button class="btn btn--sm" data-mark="' + esc(e.id) + '" data-status="pending">Bỏ đánh dấu</button>'
            : '<button class="btn btn--sm btn--gold" data-mark="' + esc(e.id) + '" data-status="sent">Đã gửi</button>') +
            '<button class="btn btn--sm btn--danger" data-delete="' + esc(e.id) + '">Xoá</button></div></td>' +
          '</tr>';
      }).join('') : '<tr><td colspan="6" class="muted">Chưa có dữ liệu.</td></tr>') + '</tbody>';
  }

  function mark(btn) {
    var id = btn.getAttribute('data-mark'), status = btn.getAttribute('data-status');
    btn.disabled = true;
    call('admin_mark', { id: id, status: status }).then(function (res) {
      entries.forEach(function (e) { if (e.id === id && res.entry) { e.status = res.entry.status; e.sent_at = res.entry.sent_at; } });
      renderList();
    }).catch(function (e) { alert(e.message); btn.disabled = false; });
  }

  function del(btn) {
    var id = btn.getAttribute('data-delete');
    var e = entries.filter(function (x) { return x.id === id; })[0] || {};
    var who = (e.customer && e.customer.name) || ('#' + e.customer_id);
    if (!confirm('Xoá lượt quay "' + (e.name || '') + '" của ' + who + '? Quà 1–9 sẽ được trả lại kho, khách được quay lại trong ngày đó. Không thể hoàn tác.')) return;
    btn.disabled = true;
    call('admin_delete', { id: id }).then(function () { return load(); }).catch(function (err) { alert(err.message); btn.disabled = false; });
  }

  function reset() {
    if ($('resetConfirm').value.trim() !== 'XOA') { alert('Gõ XOA vào ô xác nhận trước.'); return; }
    if (!confirm('Xoá TOÀN BỘ dữ liệu chiến dịch hiện tại? Không thể hoàn tác.')) return;
    $('resetBtn').disabled = true;
    call('admin_reset', { confirm: 'XOA' }).then(function (r) {
      $('resetConfirm').value = '';
      alert('Đã xoá ' + r.deleted_metafields + ' bản ghi (' + r.customers + ' khách).');
      return load();
    }).catch(function (err) { alert(err.message); }).then(function () { $('resetBtn').disabled = false; });
  }

  function csv() {
    var rows = [['Thời gian', 'Mã khách', 'Tên', 'Email', 'SĐT', 'Loại', 'Quà', 'Hạn', 'Trạng thái', 'Ngày gửi']];
    filtered().forEach(function (e) {
      var c = e.customer || {};
      rows.push([fmt(e.at), e.customer_id, c.name || '', c.email || '', c.phone || '', e.type === 'win' ? 'Quà' : 'Thẻ chương', e.name, fmtDay(e.expires_at), statusOf(e), fmtDay(e.sent_at)]);
    });
    var text = '\\ufeff' + rows.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','); }).join('\\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = 'vong-quay-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
  }

  $('loginBtn').addEventListener('click', login);
  $('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
  $('refresh').addEventListener('click', function () { load().catch(function (e) { alert(e.message); }); });
  $('logout').addEventListener('click', function () { try { sessionStorage.removeItem(KEY_STORE); } catch (e) {} location.reload(); });
  ['q', 'fType', 'fStatus'].forEach(function (id) { $(id).addEventListener('input', renderList); });
  $('csv').addEventListener('click', csv);
  $('list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mark]'); if (b) return mark(b);
    var d = e.target.closest('[data-delete]'); if (d) del(d);
  });
  $('resetBtn').addEventListener('click', reset);

  if (key) load().catch(function () { try { sessionStorage.removeItem(KEY_STORE); } catch (e) {} key = ''; });
})();
</script>
</body>
</html>`;
