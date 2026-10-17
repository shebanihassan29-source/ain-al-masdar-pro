'use strict';
/**
 * Storage layer. Two interchangeable stores with the same async interface:
 *  - PostgreSQL (production)  -> set DATABASE_URL
 *  - JSON file  (local dev)   -> used automatically when DATABASE_URL is empty (NOT for production)
 */
const fs = require('fs');
const path = require('path');

const TZ = 'Africa/Tripoli';       // AI quotas reset at local midnight, not UTC midnight
const HISTORY_KEEP = 5;            // previous library versions kept per user
const d = (v) => (v ? new Date(v) : null);
function toUser(r) {
  if (!r) return null;
  return {
    id: r.id, email: r.email, name: r.name || '', institution: r.institution || '',
    passHash: r.pass_hash, proUntil: d(r.pro_until), createdAt: d(r.created_at),
    tokenVersion: r.token_version || 0,
  };
}
function toPayment(r) {
  if (!r) return null;
  return {
    id: r.id, userId: r.user_id, email: r.email || null, method: r.method, reference: r.reference,
    note: r.note || '', amount: Number(r.amount), status: r.status,
    createdAt: d(r.created_at), decidedAt: d(r.decided_at),
  };
}
const existsErr = () => Object.assign(new Error('exists'), { code: 'EXISTS' });
const dupRefErr = () => Object.assign(new Error('duplicate_reference'), { code: 'DUP_REF' });
const refKey = (method, reference) => String(method).toLowerCase() + '\u0000' + String(reference).toLowerCase();

/* ------------------------------ PostgreSQL ------------------------------ */
function pgStore(url) {
  const { Pool } = require('pg');
  const host = new URL(url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 10 });
  // An error on an idle client (common with serverless Postgres that sleeps) must never crash the process.
  pool.on('error', (e) => console.error('[pg] idle client error:', e.message));
  const q = (text, params) => pool.query(text, params);
  const today = "(now() at time zone '" + TZ + "')::date";

  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
      throw e;
    } finally { c.release(); }
  }

  return {
    kind: 'postgres',
    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS users (
          id            SERIAL PRIMARY KEY,
          email         TEXT UNIQUE NOT NULL,
          name          TEXT NOT NULL DEFAULT '',
          institution   TEXT NOT NULL DEFAULT '',
          pass_hash     TEXT NOT NULL,
          pro_until     TIMESTAMPTZ,
          token_version INT NOT NULL DEFAULT 0,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_hash TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ;
        CREATE TABLE IF NOT EXISTS payments (
          id         SERIAL PRIMARY KEY,
          user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          method     TEXT NOT NULL,
          reference  TEXT NOT NULL,
          note       TEXT NOT NULL DEFAULT '',
          amount     NUMERIC NOT NULL,
          status     TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          decided_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);
        CREATE TABLE IF NOT EXISTS libraries (
          user_id    INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          data       TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS library_history (
          id       SERIAL PRIMARY KEY,
          user_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          data     TEXT NOT NULL,
          saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS library_history_user_idx ON library_history(user_id, id);
        CREATE TABLE IF NOT EXISTS ai_usage (
          user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          day     DATE NOT NULL,
          kind    TEXT NOT NULL DEFAULT 'chat',
          count   INT NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, day, kind)
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id         SERIAL PRIMARY KEY,
          action     TEXT NOT NULL,
          detail     TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );`);
      // The same transfer reference must not be submitted twice (rejected requests may be re-submitted).
      try {
        await q(`CREATE UNIQUE INDEX IF NOT EXISTS payments_ref_uniq
                 ON payments (lower(method), lower(reference)) WHERE status <> 'rejected'`);
      } catch (e) {
        console.warn('[db] could not create the unique payment-reference index (existing duplicates?):', e.message);
      }
    },
    async createUser({ email, name, institution, passHash, proUntil }) {
      try {
        const r = await q(
          'INSERT INTO users(email,name,institution,pass_hash,pro_until) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [email, name, institution, passHash, proUntil || null]);
        return toUser(r.rows[0]);
      } catch (e) { if (e.code === '23505') throw existsErr(); throw e; }
    },
    async userByEmail(email) { return toUser((await q('SELECT * FROM users WHERE email=$1', [email])).rows[0]); },
    async userById(id) { return toUser((await q('SELECT * FROM users WHERE id=$1', [id])).rows[0]); },
    async listUsers(limit = 200) {
      return (await q('SELECT * FROM users ORDER BY id DESC LIMIT $1', [limit])).rows.map(toUser);
    },
    async logoutAll(id) { await q('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [id]); },
    async deleteUser(id) { await q('DELETE FROM users WHERE id=$1', [id]); },
    async extendPro(id, days) {
      const r = await q(
        `UPDATE users SET pro_until = GREATEST(COALESCE(pro_until, now()), now()) + make_interval(days => $2::int)
         WHERE id=$1 RETURNING *`, [id, days]);
      return toUser(r.rows[0]);
    },
    async setProUntil(id, date) {
      return toUser((await q('UPDATE users SET pro_until=$2 WHERE id=$1 RETURNING *', [id, date])).rows[0]);
    },
    /* password reset (admin issues a one-time token; only its hash is stored) */
    async setResetToken(id, hash, expires) {
      await q('UPDATE users SET reset_hash=$2, reset_expires=$3 WHERE id=$1', [id, hash, expires]);
    },
    async userByResetHash(hash) {
      return toUser((await q('SELECT * FROM users WHERE reset_hash=$1 AND reset_expires > now()', [hash])).rows[0]);
    },
    /** Sets a new password, clears the reset token and invalidates every existing session. */
    async setPassword(id, passHash) {
      await q(`UPDATE users SET pass_hash=$2, reset_hash=NULL, reset_expires=NULL, token_version=token_version+1
               WHERE id=$1`, [id, passHash]);
    },
    async createPayment({ userId, method, reference, note, amount }) {
      try {
        const r = await q(
          'INSERT INTO payments(user_id,method,reference,note,amount) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [userId, method, reference, note, amount]);
        return toPayment(r.rows[0]);
      } catch (e) { if (e.code === '23505') throw dupRefErr(); throw e; }
    },
    async countPendingPayments(userId) {
      return Number((await q("SELECT count(*) c FROM payments WHERE user_id=$1 AND status='pending'", [userId])).rows[0].c);
    },
    async listPayments({ status, userId } = {}) {
      const where = []; const p = [];
      if (status) { p.push(status); where.push(`p.status=$${p.length}`); }
      if (userId) { p.push(userId); where.push(`p.user_id=$${p.length}`); }
      const r = await q(
        `SELECT p.*, u.email FROM payments p JOIN users u ON u.id=p.user_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 200`, p);
      return r.rows.map(toPayment);
    },
    /** Atomically moves a *pending* payment to a final status. Returns null if it was not pending. */
    async decidePayment(id, status) {
      const r = await q(
        "UPDATE payments SET status=$2, decided_at=now() WHERE id=$1 AND status='pending' RETURNING *", [id, status]);
      return toPayment(r.rows[0]);
    },
    /**
     * Approve + grant days in ONE transaction: either both happen or neither does,
     * and a payment that is no longer pending is never approved twice. Returns {payment, user} or null.
     */
    async approvePayment(id, days) {
      return tx(async (c) => {
        const r = await c.query(
          "UPDATE payments SET status='approved', decided_at=now() WHERE id=$1 AND status='pending' RETURNING *", [id]);
        if (!r.rows[0]) return null;
        const u = await c.query(
          `UPDATE users SET pro_until = GREATEST(COALESCE(pro_until, now()), now()) + make_interval(days => $2::int)
           WHERE id=$1 RETURNING *`, [r.rows[0].user_id, days]);
        return { payment: toPayment(r.rows[0]), user: toUser(u.rows[0]) };
      });
    },
    async getLibrary(userId) {
      const r = (await q('SELECT data, updated_at FROM libraries WHERE user_id=$1', [userId])).rows[0];
      return r ? { data: r.data, updatedAt: new Date(r.updated_at).toISOString() } : null;
    },
    /**
     * Optimistic concurrency: if `base` (the updatedAt the client last saw) is given and no longer matches,
     * nothing is written and {conflict:true, current} is returned so the client can merge.
     * Every overwritten version is kept in library_history (last HISTORY_KEEP).
     */
    async setLibrary(userId, data, base) {
      return tx(async (c) => {
        const cur = (await c.query('SELECT data, updated_at FROM libraries WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
        if (cur) {
          const curAt = new Date(cur.updated_at).toISOString();
          if (base && base !== curAt) return { conflict: true, current: { data: cur.data, updatedAt: curAt } };
          await c.query('INSERT INTO library_history(user_id,data) VALUES($1,$2)', [userId, cur.data]);
          await c.query(
            `DELETE FROM library_history WHERE user_id=$1 AND id NOT IN
             (SELECT id FROM library_history WHERE user_id=$1 ORDER BY id DESC LIMIT ${HISTORY_KEEP})`, [userId]);
        }
        const r = await c.query(
          `INSERT INTO libraries(user_id,data,updated_at) VALUES($1,$2,now())
           ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now() RETURNING updated_at`, [userId, data]);
        return { updatedAt: new Date(r.rows[0].updated_at).toISOString() };
      });
    },
    /** Atomically consumes one AI request. Returns {ok, count}. */
    async bumpAi(userId, kind, limit) {
      const r = await q(
        `INSERT INTO ai_usage(user_id, day, kind, count) VALUES($1, ${today}, $2, 1)
         ON CONFLICT (user_id, day, kind) DO UPDATE SET count = ai_usage.count + 1 WHERE ai_usage.count < $3
         RETURNING count`, [userId, kind, limit]);
      return r.rows[0] ? { ok: true, count: r.rows[0].count } : { ok: false, count: limit };
    },
    async refundAi(userId, kind) {
      await q(`UPDATE ai_usage SET count = GREATEST(count-1,0) WHERE user_id=$1 AND day=${today} AND kind=$2`, [userId, kind]);
    },
    async aiUsedToday(userId, kind = 'chat') {
      const r = (await q(`SELECT count FROM ai_usage WHERE user_id=$1 AND day=${today} AND kind=$2`, [userId, kind])).rows[0];
      return r ? r.count : 0;
    },
    async audit(action, detail) {
      try { await q('INSERT INTO audit_log(action,detail) VALUES($1,$2)', [action, String(detail || '').slice(0, 500)]); }
      catch (e) { console.error('[audit] failed:', e.message); }
    },
    async listAudit(limit = 100) {
      return (await q('SELECT id, action, detail, created_at FROM audit_log ORDER BY id DESC LIMIT $1', [limit]))
        .rows.map((r) => ({ id: r.id, action: r.action, detail: r.detail, createdAt: d(r.created_at) }));
    },
    async close() { await pool.end(); },
  };
}

/* ------------------------------ JSON file (dev) ------------------------------ */
function jsonStore(file) {
  let db = { seq: { users: 0, payments: 0, audit: 0 }, users: [], payments: [], libraries: {}, history: {}, ai: {}, audit: [] };
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(db));
    fs.renameSync(file + '.tmp', file);
  };
  const day = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const row = (u) => u && ({
    id: u.id, email: u.email, name: u.name, institution: u.institution, pass_hash: u.pass_hash,
    pro_until: u.pro_until, created_at: u.created_at, token_version: u.token_version,
  });
  const pay = (p) => {
    if (!p) return null;
    const u = db.users.find((x) => x.id === p.user_id);
    return toPayment({ ...p, email: u ? u.email : null });
  };
  const extend = (u, days) => {
    const base = Math.max(Date.now(), u.pro_until ? new Date(u.pro_until).getTime() : 0);
    u.pro_until = new Date(base + days * 86400000).toISOString();
  };
  return {
    kind: 'json-file (DEV ONLY)',
    async init() {
      if (fs.existsSync(file)) db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8')));
      db.history = db.history || {}; db.audit = db.audit || []; db.seq.audit = db.seq.audit || 0;
    },
    async createUser({ email, name, institution, passHash, proUntil }) {
      if (db.users.some((u) => u.email === email)) throw existsErr();
      const u = { id: ++db.seq.users, email, name, institution, pass_hash: passHash,
        pro_until: proUntil ? proUntil.toISOString() : null, created_at: new Date().toISOString(), token_version: 0 };
      db.users.push(u); save(); return toUser(row(u));
    },
    async userByEmail(email) { return toUser(row(db.users.find((u) => u.email === email))); },
    async userById(id) { return toUser(row(db.users.find((u) => u.id === id))); },
    async listUsers(limit = 200) { return db.users.slice().reverse().slice(0, limit).map((u) => toUser(row(u))); },
    async logoutAll(id) { const u = db.users.find((x) => x.id === id); if (u) { u.token_version++; save(); } },
    async deleteUser(id) {
      db.users = db.users.filter((u) => u.id !== id);
      db.payments = db.payments.filter((p) => p.user_id !== id);
      delete db.libraries[id]; delete db.history[id];
      Object.keys(db.ai).forEach((k) => { if (k.startsWith(id + ':')) delete db.ai[k]; });
      save();
    },
    async extendPro(id, days) {
      const u = db.users.find((x) => x.id === id); if (!u) return null;
      extend(u, days); save(); return toUser(row(u));
    },
    async setProUntil(id, date) {
      const u = db.users.find((x) => x.id === id); if (!u) return null;
      u.pro_until = date ? date.toISOString() : null; save(); return toUser(row(u));
    },
    async setResetToken(id, hash, expires) {
      const u = db.users.find((x) => x.id === id); if (!u) return;
      u.reset_hash = hash; u.reset_expires = expires.toISOString(); save();
    },
    async userByResetHash(hash) {
      const u = db.users.find((x) => x.reset_hash === hash && new Date(x.reset_expires).getTime() > Date.now());
      return toUser(row(u));
    },
    async setPassword(id, passHash) {
      const u = db.users.find((x) => x.id === id); if (!u) return;
      u.pass_hash = passHash; u.reset_hash = null; u.reset_expires = null; u.token_version++; save();
    },
    async createPayment({ userId, method, reference, note, amount }) {
      const k = refKey(method, reference);
      if (db.payments.some((p) => p.status !== 'rejected' && refKey(p.method, p.reference) === k)) throw dupRefErr();
      const p = { id: ++db.seq.payments, user_id: userId, method, reference, note, amount,
        status: 'pending', created_at: new Date().toISOString(), decided_at: null };
      db.payments.push(p); save(); return pay(p);
    },
    async countPendingPayments(userId) { return db.payments.filter((p) => p.user_id === userId && p.status === 'pending').length; },
    async listPayments({ status, userId } = {}) {
      return db.payments.filter((p) => (!status || p.status === status) && (!userId || p.user_id === userId))
        .slice().reverse().slice(0, 200).map(pay);
    },
    async decidePayment(id, status) {
      const p = db.payments.find((x) => x.id === id);
      if (!p || p.status !== 'pending') return null;
      p.status = status; p.decided_at = new Date().toISOString(); save(); return pay(p);
    },
    async approvePayment(id, days) {
      const p = db.payments.find((x) => x.id === id);
      if (!p || p.status !== 'pending') return null;
      const u = db.users.find((x) => x.id === p.user_id);
      p.status = 'approved'; p.decided_at = new Date().toISOString();
      if (u) extend(u, days);
      save(); return { payment: pay(p), user: toUser(row(u)) };
    },
    async getLibrary(userId) { return db.libraries[userId] || null; },
    async setLibrary(userId, data, base) {
      const cur = db.libraries[userId];
      if (cur) {
        if (base && base !== cur.updatedAt) return { conflict: true, current: cur };
        const h = (db.history[userId] = db.history[userId] || []);
        h.push({ data: cur.data, savedAt: cur.updatedAt });
        while (h.length > HISTORY_KEEP) h.shift();
      }
      let updatedAt = new Date().toISOString();
      if (cur && updatedAt === cur.updatedAt) updatedAt = new Date(Date.now() + 1).toISOString();
      db.libraries[userId] = { data, updatedAt }; save(); return { updatedAt };
    },
    async bumpAi(userId, kind, limit) {
      const k = userId + ':' + kind + ':' + day(); const c = db.ai[k] || 0;
      if (c >= limit) return { ok: false, count: c };
      db.ai[k] = c + 1; save(); return { ok: true, count: c + 1 };
    },
    async refundAi(userId, kind) { const k = userId + ':' + kind + ':' + day(); if (db.ai[k] > 0) { db.ai[k]--; save(); } },
    async aiUsedToday(userId, kind = 'chat') { return db.ai[userId + ':' + kind + ':' + day()] || 0; },
    async audit(action, detail) {
      db.audit.push({ id: ++db.seq.audit, action, detail: String(detail || '').slice(0, 500), createdAt: new Date().toISOString() });
      if (db.audit.length > 1000) db.audit.shift();
      save();
    },
    async listAudit(limit = 100) {
      return db.audit.slice().reverse().slice(0, limit).map((a) => ({ ...a, createdAt: new Date(a.createdAt) }));
    },
    async close() {},
  };
}

module.exports = function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) return pgStore(url);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production (the JSON-file store is for local development only).');
  }
  return jsonStore(path.join(__dirname, 'data', 'db.json'));
};
