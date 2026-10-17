'use strict';
const $ = (id) => document.getElementById(id);
let KEY = sessionStorage.getItem('am_admin') || '';
const ERR = {
  bad_admin_key: 'مفتاح الإدارة غير صحيح.',
  too_many_requests: 'طلبات كثيرة، انتظر قليلًا ثم أعد المحاولة.',
  not_pending: 'هذا الطلب عُولج من قبل (لم يُمنح شيء مرتين).',
  not_found: 'العنصر غير موجود.',
  invalid_id: 'معرّف غير صالح.',
  network: 'تعذّر الاتصال بالخادم.',
  server_error: 'خطأ في الخادم.',
};
const errText = (e) => ERR[e && e.message] || ('تعذّر تنفيذ الإجراء: ' + (e && e.message));
async function api(path, method, body) {
  let res;
  try {
    res = await fetch(path, { method: method || 'GET', credentials: 'same-origin',
      headers: Object.assign({ 'x-admin-key': KEY }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Error('network'); }
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || 'server_error');
  return data;
}
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ar-LY') : '—');
const say = (el, text, ok) => { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); };
function cell(tr, text) { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); return td; }
function btn(label, cls, fn) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm ' + cls; b.textContent = label; b.onclick = fn; return b;
}
/** An action button: asks for confirmation when needed, disables itself while running, reports failures, then reloads. */
function act(label, cls, { confirmMsg, run, done }) {
  return btn(label, cls, async (ev) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    const b = ev.currentTarget; b.disabled = true;
    try { const r = await run(); if (done) done(r); $('topMsg').className = 'msg'; }
    catch (e) { if (e.message !== 'cancelled') say($('topMsg'), errText(e), false); }
    load().catch((e) => say($('topMsg'), errText(e), false)).finally(() => { b.disabled = false; });
  });
}
const sp = () => document.createTextNode(' ');
let USERS = [];

function renderUsers() {
  const term = $('userSearch').value.trim().toLowerCase();
  const ub = $('userBody'); ub.textContent = '';
  USERS.filter((u) => !term || (u.email + ' ' + u.name + ' ' + u.institution).toLowerCase().includes(term)).forEach((u) => {
    const tr = document.createElement('tr');
    cell(tr, u.id); cell(tr, u.email); cell(tr, [u.name, u.institution].filter(Boolean).join(' / ') || '—');
    cell(tr, u.pro ? 'فعّال حتى ' + fmt(u.proUntil) : (u.proUntil ? 'منتهٍ ' + fmt(u.proUntil) : 'بدون'));
    const td = document.createElement('td');
    const days = () => parseInt($('days').value, 10) || 30;
    td.appendChild(act('+ أيام', '', {
      confirmMsg: null,
      run: () => { const d = days(); if (!confirm('منح ' + d + ' يومًا للمشترك ' + u.email + '؟')) throw new Error('cancelled'); return api('/api/admin/users/' + u.id + '/pro', 'POST', { days: d }); },
    })); td.appendChild(sp());
    td.appendChild(act('رابط استعادة', 'ghost', {
      run: () => api('/api/admin/users/' + u.id + '/reset-link', 'POST', {}),
      done: (r) => { const box = $('linkBox'); box.textContent = r.url; box.classList.remove('hidden'); $('linkNote').classList.remove('hidden'); box.focus(); },
    })); td.appendChild(sp());
    td.appendChild(act('إلغاء', 'danger', {
      confirmMsg: 'إلغاء اشتراك ' + u.email + '؟',
      run: () => api('/api/admin/users/' + u.id + '/pro', 'POST', { revoke: true }),
    }));
    tr.appendChild(td); ub.appendChild(tr);
  });
}

async function load() {
  const status = $('payFilter').value;
  const [{ payments }, { users }, { log }] = await Promise.all([
    api('/api/admin/payments' + (status ? '?status=' + status : '')), api('/api/admin/users'), api('/api/admin/audit')]);
  $('keyCard').classList.add('hidden'); $('panel').classList.remove('hidden'); $('logout').classList.remove('hidden');

  const pb = $('payBody'); pb.textContent = ''; $('payEmpty').classList.toggle('hidden', payments.length > 0);
  payments.forEach((p) => {
    const tr = document.createElement('tr');
    cell(tr, p.id); cell(tr, p.email); cell(tr, p.method); cell(tr, p.reference + (p.note ? ' — ' + p.note : ''));
    cell(tr, p.amount); cell(tr, fmt(p.createdAt));
    const td = document.createElement('td');
    if (p.status === 'pending') {
      td.appendChild(act('قبول', '', {
        confirmMsg: 'قبول الطلب #' + p.id + ' للمشترك ' + p.email + ' (' + p.reference + ')؟',
        run: () => { const d = parseInt($('days').value, 10); return api('/api/admin/payments/' + p.id + '/approve', 'POST', d ? { days: d } : {}); },
        done: (r) => say($('topMsg'), 'تم القبول ومُنح المشترك ' + r.days + ' يومًا.', true),
      })); td.appendChild(sp());
      td.appendChild(act('رفض', 'danger', {
        confirmMsg: 'رفض الطلب #' + p.id + ' نهائيًا؟ لا يمكن التراجع.',
        run: () => api('/api/admin/payments/' + p.id + '/reject', 'POST', {}),
      }));
    } else {
      const b = document.createElement('span');
      b.className = 'badge ' + p.status; b.textContent = p.status === 'approved' ? 'مقبول' : 'مرفوض'; td.appendChild(b);
      if (p.decidedAt) td.appendChild(document.createTextNode(' ' + fmt(p.decidedAt)));
    }
    tr.appendChild(td); pb.appendChild(tr);
  });

  USERS = users; renderUsers();

  const ab = $('auditBody'); ab.textContent = '';
  log.forEach((a) => { const tr = document.createElement('tr'); cell(tr, fmt(a.createdAt)); cell(tr, a.action); cell(tr, a.detail); ab.appendChild(tr); });
}

$('keyForm').onsubmit = async (ev) => {
  ev.preventDefault(); KEY = $('key').value;
  try { await load(); sessionStorage.setItem('am_admin', KEY); }
  catch (e) { say($('keyMsg'), e.message === 'bad_admin_key' ? 'المفتاح غير صحيح.' : errText(e), false); }
};
$('reload').onclick = () => load().catch((e) => say($('topMsg'), errText(e), false));
$('payFilter').onchange = () => load().catch((e) => say($('topMsg'), errText(e), false));
$('userSearch').oninput = renderUsers;
$('logout').onclick = () => { sessionStorage.removeItem('am_admin'); KEY = ''; location.reload(); };
if (KEY) load().catch(() => { sessionStorage.removeItem('am_admin'); KEY = ''; });
