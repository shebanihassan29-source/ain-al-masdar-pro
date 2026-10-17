'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const createStore = require('./db');

/* ------------------------------- config ------------------------------- */
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT ? Number(process.env.PORT) || 0 : 3000; // PORT=0 lets the OS pick a free port (tests)
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) throw new Error('JWT_SECRET is required in production');
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[dev] JWT_SECRET not set — using a random one (sessions reset on restart).');
}
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const CFG = {
  price: Number(process.env.PRO_PRICE) || 30,
  currency: process.env.PRO_CURRENCY || 'د.ل',
  periodDays: Number(process.env.PRO_PERIOD_DAYS) || 30,
  trialDays: Number(process.env.TRIAL_DAYS) || 0,
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT) || 40,
  translateDailyLimit: Number(process.env.AI_TRANSLATE_DAILY_LIMIT) || 200,
  paymentInstructions: process.env.PAYMENT_INSTRUCTIONS || 'للاشتراك، تواصل مع إدارة المنصة لمعرفة طريقة الدفع المتاحة ثم أرسل رقم العملية هنا.',
  freeAppUrl: process.env.FREE_APP_URL || '',
  supportContact: process.env.SUPPORT_CONTACT || '',   // e.g. a WhatsApp number or e-mail shown on the account page
};
const AI = {
  key: process.env.AI_API_KEY || '',
  base: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  model: process.env.AI_MODEL || 'gpt-4o-mini',
};
// The Arabic->English query-expansion prompt is fixed HERE, so the 'translate' quota can never be used as a generic LLM proxy.
const TRANSLATE_SYSTEM = 'You are an academic search-query translator. Output ONLY the best short English academic search phrase (3-8 words) equivalent to the given Arabic research topic — no quotes, no explanation, no punctuation beyond spaces.';
const AI_MAX_TOKENS = { chat: 2500, translate: 40 };
// A dedicated, STABLE secret for licence fingerprints. Rotating JWT_SECRET must not break leak tracing.
const WATERMARK_SALT = process.env.WATERMARK_SALT || JWT_SECRET;
const COOKIE = 'am_session';
const DAY = 86400000;
const RESET_TTL_MS = 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const store = createStore();
const app = express();
app.set('trust proxy', 1); // Render terminates TLS in front of us
app.disable('x-powered-by');

/* ------------------------------ security ------------------------------ */
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const CSP_PAGES = "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const CSP_APP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; " +
  "connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
app.use((req, res, next) => { res.setHeader('Content-Security-Policy', req.path === '/app' ? CSP_APP : CSP_PAGES); next(); });

app.use(cookieParser());
const jsonSmall = express.json({ limit: '64kb' });
const jsonAi = express.json({ limit: '256kb' });
const jsonLib = express.json({ limit: '3mb' });

// CSRF defence: SameSite=Lax cookie + JSON-only bodies + same-origin check on state-changing requests.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch (e) { /* invalid */ }
    if (!ok) return res.status(403).json({ error: 'bad_origin' });
  }
  next();
});

const limiter = (opts) => rateLimit({ standardHeaders: 'draft-7', legacyHeaders: false, ...opts });
app.use('/api/', limiter({ windowMs: 15 * 60 * 1000, limit: 600 }));
const signupLimit = limiter({ windowMs: 60 * 60 * 1000, limit: 8, message: { error: 'too_many_requests' } });
const resetLimit = limiter({ windowMs: 60 * 60 * 1000, limit: 15, message: { error: 'too_many_requests' } });
const loginIpLimit = limiter({ windowMs: 15 * 60 * 1000, limit: 30, message: { error: 'too_many_requests' } });
const loginEmailLimit = limiter({
  windowMs: 15 * 60 * 1000, limit: 8, message: { error: 'too_many_attempts' },
  keyGenerator: (req) => 'e:' + String((req.body && req.body.email) || '').toLowerCase().slice(0, 254),
  skipSuccessfulRequests: true, validate: { keyGeneratorIpFallback: false },
});
const adminLimit = limiter({ windowMs: 15 * 60 * 1000, limit: 60, message: { error: 'too_many_requests' } });

/* ------------------------------- helpers ------------------------------- */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isPro = (u) => !!(u && u.proUntil && u.proUntil.getTime() > Date.now());
const publicUser = (u) => ({
  email: u.email, name: u.name, institution: u.institution, pro: isPro(u),
  proUntil: u.proUntil ? u.proUntil.toISOString() : null,
});
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const validPassword = (p) => p.length >= 8 && Buffer.byteLength(p) <= 72;
/** Strict positive-integer id from a route param; anything else (NaN, "1abc", 0, -3) is a 400, not a 500. */
const parseId = (v) => (/^[0-9]{1,9}$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
const daysFrom = (v, fallback) => Math.min(Math.max(parseInt(v, 10) || fallback, 1), 366);

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, tv: user.tokenVersion }, JWT_SECRET, { expiresIn: '30d', algorithm: 'HS256' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * DAY, path: '/' });
}
async function loadUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const u = await store.userById(p.sub);
    return u && u.tokenVersion === p.tv ? u : null;
  } catch (e) { return null; }
}
const auth = wrap(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u) return res.status(401).json({ error: 'unauthenticated' });
  req.user = u; next();
});
const requirePro = (req, res, next) => (isPro(req.user) ? next() : res.status(402).json({ error: 'subscription_required' }));

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);
function adminOnly(req, res, next) {
  const given = Buffer.from(String(req.get('x-admin-key') || ''));
  const real = Buffer.from(ADMIN_KEY);
  if (!ADMIN_KEY || given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    return res.status(401).json({ error: 'bad_admin_key' });
  }
  next();
}

/* -------------------------------- auth -------------------------------- */
app.post('/api/auth/signup', signupLimit, jsonSmall, wrap(async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (!validPassword(password)) return res.status(400).json({ error: 'invalid_password' });
  const passHash = await bcrypt.hash(password, 12);
  const proUntil = CFG.trialDays > 0 ? new Date(Date.now() + CFG.trialDays * DAY) : null;
  try {
    const user = await store.createUser({
      email, name: clean(req.body.name, 100), institution: clean(req.body.institution, 150), passHash, proUntil });
    setSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    if (e.code === 'EXISTS') return res.status(409).json({ error: 'email_taken' });
    throw e;
  }
}));

app.post('/api/auth/login', loginIpLimit, jsonSmall, loginEmailLimit, wrap(async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const password = String(req.body.password || '');
  const user = await store.userByEmail(email);
  const ok = await bcrypt.compare(password, user ? user.passHash : DUMMY_HASH); // constant work either way
  if (!user || !ok) return res.status(401).json({ error: 'bad_credentials' });
  setSession(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
app.post('/api/auth/logout-all', auth, wrap(async (req, res) => {
  await store.logoutAll(req.user.id); res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true });
}));

// Password recovery without e-mail: the admin issues a one-time link (see /api/admin/users/:id/reset-link)
// and sends it to the subscriber over the usual channel (WhatsApp...). Only the token's hash is stored.
app.post('/api/auth/reset', resetLimit, jsonSmall, wrap(async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (!/^[0-9a-f]{48}$/.test(token)) return res.status(400).json({ error: 'invalid_token' });
  if (!validPassword(password)) return res.status(400).json({ error: 'invalid_password' });
  const user = await store.userByResetHash(sha256(token));
  if (!user) return res.status(400).json({ error: 'invalid_token' });
  await store.setPassword(user.id, await bcrypt.hash(password, 12));
  res.json({ ok: true });
}));

app.get('/api/me', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = await loadUser(req);
  const config = { price: CFG.price, currency: CFG.currency, periodDays: CFG.periodDays, trialDays: CFG.trialDays,
    freeAppUrl: CFG.freeAppUrl, aiDailyLimit: CFG.aiDailyLimit, supportContact: CFG.supportContact };
  if (!u) return res.json({ user: null, config });
  config.paymentInstructions = CFG.paymentInstructions; // only shown to signed-in users
  res.json({ user: publicUser(u), config, aiUsedToday: await store.aiUsedToday(u.id) });
}));

// Data-protection: let a subscriber download everything we hold about them, and delete the account.
app.get('/api/me/export', auth, wrap(async (req, res) => {
  const lib = await store.getLibrary(req.user.id);
  const out = {
    exportedAt: new Date().toISOString(),
    account: { ...publicUser(req.user), createdAt: req.user.createdAt },
    payments: await store.listPayments({ userId: req.user.id }),
    library: lib ? JSON.parse(lib.data) : null,
  };
  res.setHeader('Content-Disposition', 'attachment; filename="ain-al-masdar-my-data.json"');
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
}));
app.post('/api/me/delete', auth, jsonSmall, wrap(async (req, res) => {
  const ok = await bcrypt.compare(String(req.body.password || ''), req.user.passHash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });
  await store.deleteUser(req.user.id);
  await store.audit('user.delete', 'user #' + req.user.id);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}));

/* ------------------------------ payments ------------------------------ */
// Users pay outside the app (bank transfer, e-wallet, cash...) and submit the reference; an admin approves it.
app.post('/api/payments/request', auth, jsonSmall, wrap(async (req, res) => {
  const method = clean(req.body.method, 60);
  const reference = clean(req.body.reference, 120);
  if (!method || reference.length < 3) return res.status(400).json({ error: 'invalid_payment' });
  if ((await store.countPendingPayments(req.user.id)) >= 3) return res.status(429).json({ error: 'too_many_pending' });
  try {
    const p = await store.createPayment({ userId: req.user.id, method, reference, note: clean(req.body.note, 300), amount: CFG.price });
    res.status(201).json({ payment: p });
  } catch (e) {
    if (e.code === 'DUP_REF') return res.status(409).json({ error: 'duplicate_reference' });
    throw e;
  }
}));
app.get('/api/payments/mine', auth, wrap(async (req, res) => {
  res.json({ payments: await store.listPayments({ userId: req.user.id }) });
}));

/* --------------------------- cloud library (PRO) --------------------------- */
app.get('/api/library', auth, requirePro, wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const lib = await store.getLibrary(req.user.id);
  res.json(lib ? { data: JSON.parse(lib.data), updatedAt: lib.updatedAt } : { data: null, updatedAt: null });
}));
// `base` = the updatedAt the client last synced from. If another device saved since, we answer 409 with the
// current copy so the client can merge — a stale device can never silently wipe a newer library.
app.put('/api/library', auth, requirePro, jsonLib, wrap(async (req, res) => {
  const d = req.body && req.body.data;
  if (!d || !Array.isArray(d.library) || !Array.isArray(d.collections)) return res.status(400).json({ error: 'invalid_library' });
  if (d.library.length > 5000 || d.collections.length > 200) return res.status(413).json({ error: 'library_too_large' });
  const json = JSON.stringify({ library: d.library, collections: d.collections });
  if (Buffer.byteLength(json) > 2.5 * 1024 * 1024) return res.status(413).json({ error: 'library_too_large' });
  const base = typeof req.body.base === 'string' && req.body.base ? req.body.base : null;
  const r = await store.setLibrary(req.user.id, json, base);
  if (r.conflict) return res.status(409).json({ error: 'conflict', data: JSON.parse(r.current.data), updatedAt: r.current.updatedAt });
  res.json({ updatedAt: r.updatedAt });
}));

/* ------------------------------ AI proxy (PRO) ------------------------------ */
app.post('/api/ai', auth, requirePro, jsonAi, wrap(async (req, res) => {
  const body = req.body || {};
  // 'translate' = the automatic Arabic->English query expansion on every search; it has its own, larger daily budget.
  const kind = body.kind === 'translate' ? 'translate' : 'chat';
  const user = String(body.user || '');
  const system = kind === 'translate' ? TRANSLATE_SYSTEM : String(body.system || '');
  if (!user || system.length > 6000 || user.length > 30000) return res.status(400).json({ error: 'invalid_request' });
  if (kind === 'translate' && user.length > 500) return res.status(400).json({ error: 'invalid_request' });
  if (!AI.key) return res.status(503).json({ error: 'ai_not_configured' });
  const limit = kind === 'translate' ? CFG.translateDailyLimit : CFG.aiDailyLimit;
  const q = await store.bumpAi(req.user.id, kind, limit);
  if (!q.ok) return res.status(429).json({ error: 'daily_limit', limit, kind });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(AI.base + '/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI.key },
      body: JSON.stringify({ model: AI.model, temperature: 0.4, max_tokens: AI_MAX_TOKENS[kind], messages: [
        ...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }] }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) throw new Error('upstream_' + r.status);
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    res.json({ content, used: q.count, limit });
  } catch (e) {
    await store.refundAi(req.user.id, kind); // a failed upstream call must not burn the user's quota
    console.error('[ai] upstream failure:', e.message);
    res.status(502).json({ error: 'ai_upstream_failed' });
  } finally { clearTimeout(timer); }
}));

/* ------------------------------ admin ------------------------------ */
app.get('/api/admin/payments', adminLimit, adminOnly, wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : undefined;
  res.json({ payments: await store.listPayments({ status }) });
}));
app.post('/api/admin/payments/:id/approve', adminLimit, adminOnly, jsonSmall, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const days = daysFrom(req.body && req.body.days, CFG.periodDays);
  // approval + granting the days happen in one DB transaction (see db.approvePayment)
  const r = await store.approvePayment(id, days);
  if (!r) return res.status(409).json({ error: 'not_pending' }); // double-click / already handled: never grants twice
  await store.audit('payment.approve', `payment #${id} (${r.payment.reference}) → user ${r.payment.userId}, +${days}d`);
  res.json({ payment: r.payment, user: publicUser(r.user), days });
}));
app.post('/api/admin/payments/:id/reject', adminLimit, adminOnly, jsonSmall, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const p = await store.decidePayment(id, 'rejected');
  if (!p) return res.status(409).json({ error: 'not_pending' });
  await store.audit('payment.reject', `payment #${id} (${p.reference})`);
  res.json({ payment: p });
}));
app.get('/api/admin/users', adminLimit, adminOnly, wrap(async (req, res) => {
  res.json({ users: (await store.listUsers(1000)).map((u) => ({ id: u.id, ...publicUser(u), createdAt: u.createdAt })) });
}));
app.post('/api/admin/users/:id/pro', adminLimit, adminOnly, jsonSmall, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const revoke = !!(req.body && req.body.revoke);
  const days = daysFrom(req.body && req.body.days, CFG.periodDays);
  const u = revoke ? await store.setProUntil(id, null) : await store.extendPro(id, days);
  if (!u) return res.status(404).json({ error: 'not_found' });
  await store.audit(revoke ? 'user.revoke' : 'user.extend', `user #${id}${revoke ? '' : ', +' + days + 'd'}`);
  res.json({ user: publicUser(u) });
}));
app.post('/api/admin/users/:id/reset-link', adminLimit, adminOnly, jsonSmall, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const u = await store.userById(id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const token = crypto.randomBytes(24).toString('hex');
  await store.setResetToken(id, sha256(token), new Date(Date.now() + RESET_TTL_MS));
  await store.audit('user.reset-link', `user #${id}`);
  res.json({ url: `${req.protocol}://${req.get('host')}/?reset=${token}`, expiresInMinutes: RESET_TTL_MS / 60000 });
}));
app.get('/api/admin/audit', adminLimit, adminOnly, wrap(async (req, res) => {
  res.json({ log: await store.listAudit(100) });
}));

/* --------------------- protected PRO application --------------------- */
const PRO_FILE = path.join(__dirname, 'private', 'pro.html');
const MARKER = '<!--AM_LICENSEE-->';
let proHtml = null;
const loadPro = () => {
  try { proHtml = fs.readFileSync(PRO_FILE, 'utf8'); } catch (e) { proHtml = null; }
  if (proHtml && !proHtml.includes(MARKER)) {
    // Without the marker neither the user data nor the licence fingerprint would be injected — fall back to <head>.
    console.error('[pro] WARNING: ' + MARKER + ' not found in private/pro.html — injecting after <head> instead. Re-run the build.');
  }
};
loadPro();
const licenseTag = (email) => crypto.createHash('sha256').update(email + ':' + WATERMARK_SALT).digest('hex').slice(0, 16);

app.get('/app', wrap(async (req, res) => {
  const u = await loadUser(req);
  if (!u) return res.redirect('/?need=login');
  if (!isPro(u)) return res.redirect('/?need=pro');
  if (!proHtml) return res.status(503).type('text').send('PRO application file is missing on the server.');
  const tag = licenseTag(u.email);
  const boot = JSON.stringify({ name: u.name, institution: u.institution, email: u.email, aiDailyLimit: CFG.aiDailyLimit })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const inject = `<!-- licensee:${tag} --><meta name="am-licensee" content="${tag}"><script>window.AM_USER=${boot};</script>`;
  res.setHeader('Cache-Control', 'no-store');
  // Replacer FUNCTIONS: a string replacement would interpret "$&", "$'" ... inside a subscriber's name/institution.
  const html = proHtml.includes(MARKER)
    ? proHtml.replace(MARKER, () => inject)
    : proHtml.replace(/<head[^>]*>/i, (m) => m + inject);
  res.type('html').send(html);
}));

/* ------------------------- public pages / static ------------------------- */
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.use('/static', express.static(path.join(__dirname, 'public', 'static'), { maxAge: '1h' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  console.error('[error]', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'server_error' });
});

/* -------------------------------- start -------------------------------- */
async function start() {
  await store.init();
  if (!ADMIN_KEY) console.warn('ADMIN_KEY is not set — the admin panel is disabled.');
  if (!AI.key) console.warn('AI_API_KEY is not set — /api/ai will return ai_not_configured.');
  if (!process.env.WATERMARK_SALT) console.warn('WATERMARK_SALT is not set — licence fingerprints depend on JWT_SECRET (rotating it would break leak tracing). Set a separate, permanent value.');
  if (!proHtml) console.warn('private/pro.html not found — run "npm run build:pro" (or copy the file) before serving /app.');
  const server = app.listen(PORT, () => console.log(`Ain Al-Masdar PRO listening on :${PORT} (store: ${store.kind})`));
  const stop = () => server.close(() => store.close().then(() => process.exit(0)));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}
if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start, store };
