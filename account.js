'use strict';
const $ = (id) => document.getElementById(id);
const ERR = {
  invalid_email: 'البريد الإلكتروني غير صالح.',
  invalid_password: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل (وأقل من 72 بايت).',
  email_taken: 'هذا البريد مسجَّل من قبل. جرّب تسجيل الدخول.',
  bad_credentials: 'البريد أو كلمة المرور غير صحيحة.',
  too_many_attempts: 'محاولات كثيرة. انتظر 15 دقيقة ثم أعد المحاولة.',
  too_many_requests: 'طلبات كثيرة. حاول لاحقًا.',
  invalid_payment: 'أدخل طريقة الدفع ورقم العملية (3 أحرف على الأقل).',
  too_many_pending: 'لديك 3 طلبات قيد المراجعة بالفعل. انتظر معالجتها.',
  duplicate_reference: 'رقم العملية هذا مُسجَّل مسبقًا. إن كان طلبك السابق مرفوضًا فتواصل مع الإدارة.',
  invalid_token: 'رابط الاستعادة غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا من الإدارة.',
  bad_origin: 'طلب مرفوض لأسباب أمنية.',
  payload_too_large: 'حجم البيانات كبير جدًا.',
  server_error: 'خطأ في الخادم. حاول لاحقًا.',
  network: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.',
};
const errText = (e) => ERR[e && e.message] || 'حدث خطأ. حاول مرة أخرى.';
async function api(path, method, body) {
  let res;
  try {
    res = await fetch(path, {
      method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
    });
  } catch (e) { throw new Error('network'); }
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || 'server_error');
  return data;
}
const say = (el, text, ok) => { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); };
const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('ar-LY', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
const STATUS = { pending: 'قيد المراجعة', approved: 'مقبول', rejected: 'مرفوض' };
const LOCAL_KEYS = ['am_library', 'am_collections', 'am_saved', 'am_settings', 'am_lib_dirty', 'am_lib_synced_at', 'am_lib_owner'];
/** Shared computers: signing out must not leave this subscriber's library or API keys in the browser. */
function leaveSafely() {
  let dirty = false; try { dirty = localStorage.getItem('am_lib_dirty') === '1'; } catch (e) { /* storage blocked */ }
  if (dirty && !confirm('توجد تعديلات في مكتبتك لم تُزامَن بعد، وستُفقد إن خرجت الآن. افتح المنصة أولًا لتكتمل المزامنة. هل تريد الخروج رغم ذلك؟')) return false;
  return true;
}
function wipeLocal() { LOCAL_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }
const daysAr = (n) => (n === 0 ? 'أقل من يوم' : n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n <= 10 ? n + ' أيام' : n + ' يومًا');
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s);

function showTab(login) {
  $('loginForm').classList.toggle('hidden', !login); $('signupForm').classList.toggle('hidden', login);
  $('tabLogin').classList.toggle('on', login); $('tabSignup').classList.toggle('on', !login);
  $('tabLogin').setAttribute('aria-selected', login); $('tabSignup').setAttribute('aria-selected', !login);
  $('authMsg').className = 'msg';
}
$('tabLogin').onclick = () => showTab(true);
$('tabSignup').onclick = () => showTab(false);
$('forgotBtn').onclick = () => $('forgotBox').classList.toggle('hidden');
document.querySelectorAll('[data-show]').forEach((b) => {
  b.onclick = () => {
    const i = $(b.dataset.show); const show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.textContent = show ? 'إخفاء' : 'إظهار';
  };
});
$('pMethod').onchange = () => $('pPlaceBox').classList.toggle('hidden', $('pMethod').value !== 'نقدًا');

/** Renders text; http(s) links inside it become clickable (WhatsApp links, bank pages...). Text is never parsed as HTML. */
function renderRich(el, text) {
  el.textContent = '';
  String(text || '').split(/(\s+)/).forEach((part) => {
    if (isUrl(part)) {
      const a = document.createElement('a'); a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = part;
      el.appendChild(a);
    } else el.appendChild(document.createTextNode(part));
  });
}

async function refresh() {
  const me = await api('/api/me');
  const c = me.config;
  $('price').textContent = c.price; $('currency').textContent = c.currency; $('aiLimit').textContent = c.aiDailyLimit;
  if (c.trialDays > 0) $('trialNote').textContent = `تجربة مجانية ${c.trialDays} أيام عند إنشاء الحساب`;
  if (c.freeAppUrl) { $('freeLink').href = c.freeAppUrl; $('freeLink').classList.remove('hidden'); }
  if (c.supportContact) renderRich($('contactLine'), 'التواصل: ' + c.supportContact);
  if (c.paymentInstructions) renderRich($('payInstr'), c.paymentInstructions);

  const need = new URLSearchParams(location.search).get('need');
  const n = $('needNotice');
  if (need === 'pro' && me.user) { n.textContent = 'اشتراكك غير فعّال. جدّد الاشتراك ليعود الوصول إلى المنصة الاحترافية.'; n.classList.remove('hidden'); }
  else if (need === 'login' && !me.user) { n.textContent = 'سجّل الدخول للوصول إلى المنصة الاحترافية.'; n.classList.remove('hidden'); }

  $('authCard').classList.toggle('hidden', !!me.user);
  $('accountCard').classList.toggle('hidden', !me.user);
  if (!me.user) return;
  const u = me.user;
  $('hello').textContent = 'مرحبًا ' + (u.name || u.email);
  $('statusBadge').textContent = u.pro ? 'اشتراك فعّال' : 'بدون اشتراك';
  $('statusBadge').className = 'badge ' + (u.pro ? 'pro' : 'free');
  const line = $('statusLine'); line.className = 'small';
  if (u.pro) {
    const days = Math.max(0, Math.ceil((new Date(u.proUntil).getTime() - Date.now()) / 86400000));
    line.textContent = 'ينتهي اشتراكك في ' + fmt(u.proUntil) + ' (بقي ' + daysAr(days) + ') • استخدمت اليوم ' +
      me.aiUsedToday + ' من ' + c.aiDailyLimit + ' طلب ذكاء اصطناعي.';
    if (days <= 3) line.className = 'small warn-text';
  } else {
    line.textContent = u.proUntil ? 'انتهى اشتراكك في ' + fmt(u.proUntil) + '.' : 'اشترك للوصول إلى المنصة الاحترافية.';
  }
  $('openApp').classList.toggle('hidden', !u.pro);
  $('payBlock').classList.remove('hidden');
  await loadPayments();
}
async function loadPayments() {
  const { payments } = await api('/api/payments/mine');
  $('reqBlock').classList.toggle('hidden', !payments.length);
  const body = $('reqBody'); body.textContent = '';
  payments.forEach((p) => {
    const tr = document.createElement('tr');
    [fmt(p.createdAt), p.method, p.reference].forEach((t) => { const td = document.createElement('td'); td.textContent = t; tr.appendChild(td); });
    const td = document.createElement('td'); const b = document.createElement('span');
    b.className = 'badge ' + p.status; b.textContent = STATUS[p.status] || p.status; td.appendChild(b); tr.appendChild(td);
    body.appendChild(tr);
  });
}
/** Reload the page state; a failure here is shown globally and never reported as a failure of the action that just succeeded. */
const reload = () => refresh().catch((e) => say($('globalMsg'), errText(e), false));

async function submit(form, msgEl, work) {
  const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
  let ok = false;
  try { await work(); ok = true; } catch (e) { say(msgEl, errText(e), false); }
  finally { btn.disabled = false; }
  if (ok) { msgEl.className = 'msg'; await reload(); }   // success: only now refresh, outside the try
}
$('loginForm').onsubmit = (ev) => { ev.preventDefault(); submit(ev.target, $('authMsg'), () =>
  api('/api/auth/login', 'POST', { email: $('lEmail').value, password: $('lPass').value })); };
$('signupForm').onsubmit = (ev) => { ev.preventDefault(); submit(ev.target, $('authMsg'), () =>
  api('/api/auth/signup', 'POST', { email: $('sEmail').value, password: $('sPass').value, name: $('sName').value, institution: $('sInst').value })); };

$('payForm').onsubmit = async (ev) => {
  ev.preventDefault(); const btn = ev.target.querySelector('button[type=submit]'); btn.disabled = true;
  const parts = [];
  if ($('pDate').value) parts.push('تاريخ التحويل: ' + $('pDate').value);
  if ($('pMethod').value === 'نقدًا' && $('pPlace').value.trim()) parts.push('مكان التسليم: ' + $('pPlace').value.trim());
  if ($('pNote').value.trim()) parts.push($('pNote').value.trim());
  let ok = false;
  try {
    await api('/api/payments/request', 'POST', { method: $('pMethod').value, reference: $('pRef').value, note: parts.join(' — ') });
    ok = true;
  } catch (e) { say($('payMsg'), errText(e), false); }
  finally { btn.disabled = false; }
  if (!ok) return;
  $('pRef').value = ''; $('pNote').value = ''; $('pDate').value = ''; $('pPlace').value = '';
  say($('payMsg'), 'تم استلام طلبك وهو الآن قيد المراجعة. سيُفعَّل اشتراكك بعد التحقق من الدفع، وستجد حالة الطلب في «طلباتي».', true);
  await reload();
};

$('resetForm').onsubmit = (ev) => {
  ev.preventDefault();
  const token = new URLSearchParams(location.search).get('reset') || '';
  submit(ev.target, $('resetMsg'), async () => {
    await api('/api/auth/reset', 'POST', { token, password: $('rPass').value });
    $('rPass').value = '';
    history.replaceState(null, '', '/');
    $('resetCard').classList.add('hidden');
    say($('globalMsg'), 'تم تعيين كلمة المرور الجديدة. سجّل الدخول الآن.', true);
  });
};
$('deleteForm').onsubmit = (ev) => {
  ev.preventDefault();
  if (!confirm('سيُحذف حسابك ومكتبتك السحابية وطلباتك نهائيًا ولا يمكن التراجع. هل أنت متأكد؟')) return;
  const btn = ev.target.querySelector('button[type=submit]'); btn.disabled = true;
  api('/api/me/delete', 'POST', { password: $('dPass').value })
    .then(() => { wipeLocal(); location.href = '/'; })
    .catch((e) => { say($('delMsg'), errText(e), false); btn.disabled = false; });
};

$('logoutBtn').onclick = async () => {
  if (!leaveSafely()) return;
  try { await api('/api/auth/logout', 'POST', {}); } catch (e) { /* cookie is cleared on next load anyway */ }
  wipeLocal(); location.href = '/';
};
$('logoutAllBtn').onclick = async () => {
  if (!confirm('سيتم تسجيل خروجك من جميع الأجهزة، بما فيها هذا الجهاز. متابعة؟')) return;
  if (!leaveSafely()) return;
  try { await api('/api/auth/logout-all', 'POST', {}); wipeLocal(); location.href = '/'; } catch (e) { say($('globalMsg'), errText(e), false); }
};

$('year').textContent = new Date().getFullYear();
if (new URLSearchParams(location.search).get('reset')) $('resetCard').classList.remove('hidden');
reload();
