#!/usr/bin/env python3
"""
Applies the reviewed fixes to the Ain Al-Masdar HTML (free build OR generated pro.html).

    python3 tools/fix-pro.py private/pro.html            # patch in place
    python3 tools/fix-pro.py in.html out.html            # patch a copy

Every patch is an exact-text replacement that must match EXACTLY the expected number of times;
if the source changed so that a patch no longer applies, the script stops with an error instead of
silently skipping it. Patches tagged "pro" only exist in the generated PRO build (the PRO block
appended by tools/build-pro.py) — move those into build-pro.py so they survive `npm run build:pro`.
"""
import re, sys

PATCHES = []
def patch(name, scope, old, new, count=1):
    PATCHES.append((name, scope, old, new, count))

# ---------------------------------------------------------------- shared (free + pro)
patch('modals: close buttons actually close', 'shared',
 "btn.addEventListener('click', () => $('#' + btn.dataset.close).classList.remove('hidden'));",
 "btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));")

patch('modals: close with Esc', 'shared',
 "  document.getElementById('btnExport');\n}\n\nfunction init() {",
 "  document.addEventListener('keydown', (e) => {\n"
 "    if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach((m) => m.classList.add('hidden'));\n"
 "  });\n}\n\nfunction init() {")

patch('urls: only http(s) is ever rendered/opened', 'shared',
 "function recordUrl(r) { return r.url || (r.doi ? 'https://doi.org/' + r.doi : ''); }",
 "/* Records come from third-party APIs: a \"javascript:\" / \"data:\" URL must never reach href or window.open. */\n"
 "function safeUrl(u) { try { const x = new URL(String(u || ''), location.href); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; } }\n"
 "function recordUrl(r) { return safeUrl(r.url) || (r.doi ? 'https://doi.org/' + encodeURI(String(r.doi)) : ''); }")

patch('urls: library item open', 'shared',
 "if (it && it.record) window.open(recordUrl(it.record) || it.record.url, '_blank');",
 "if (it && it.record) { const u = recordUrl(it.record); if (u) window.open(u, '_blank', 'noopener'); }")

patch('urls: pdf link', 'shared',
 "const pdf = r.pdfUrl ? `<a class=\"btn-src\" href=\"${esc(r.pdfUrl)}\"",
 "const pdf = safeUrl(r.pdfUrl) ? `<a class=\"btn-src\" href=\"${esc(safeUrl(r.pdfUrl))}\"")

patch('urls: external-search buttons', 'shared',
 "<a class=\"ext-btn\" href=\"${esc(e.url)}\"",
 "<a class=\"ext-btn\" href=\"${esc(safeUrl(e.url) || '#')}\"")

patch('csv: neutralise spreadsheet formulas (=,+,-,@)', 'shared',
 "const q = (v) => '\"' + String(v == null ? '' : v).replace(/\"/g, '\"\"') + '\"';",
 "const q = (v) => {\n"
 "    let s = String(v == null ? '' : v);\n"
 "    if (/^[=+\\-@\\t\\r]/.test(s)) s = \"'\" + s;   // titles come from external sources: stop Excel running them as formulas\n"
 "    return '\"' + s.replace(/\"/g, '\"\"') + '\"';\n"
 "  };")

patch('arxiv: https (http is blocked as mixed content)', 'shared',
 "'http://export.arxiv.org/api/query", "'https://export.arxiv.org/api/query")

patch('filters: "clear all" also resets the Libyan-affiliation filter', 'shared',
 "state.filters = { oaOnly: false, pdfOnly: false, peerOnly: false, savedOnly: false, source: null, concept: null };\n    renderResults();",
 "state.filters = { oaOnly: false, pdfOnly: false, peerOnly: false, savedOnly: false, source: null, concept: null, libyaAffil: false };\n"
 "    const la = $('chkLibyaAffil'); if (la) la.checked = false;\n    renderResults();")

patch('link: malformed #q= no longer breaks start-up', 'shared',
 "if (m[1]) $('inputQ').value = decodeURIComponent(m[1]);",
 "if (m[1]) { try { $('inputQ').value = decodeURIComponent(m[1]); } catch (e) { /* malformed link: ignore */ } }")

patch('print: hide the app with display:none (no blank pages)', 'shared',
 "  body * { visibility: hidden !important; }\n  .print-area, .print-area * { visibility: visible !important; }\n  .print-area {\n    display: block; position: absolute; inset: 0; padding: 20mm;",
 "  body > *:not(.print-area) { display: none !important; }\n  .print-area {\n    display: block; position: static; padding: 8mm;")

patch('bibtex: keep accented Latin letters', 'shared',
 ".replace(/[^\\x20-\\x7E\\u0600-\\u06FF]/g, '')",
 ".replace(/[^\\x20-\\x7E\\u00C0-\\u024F\\u0600-\\u06FF]/g, '')")

patch('authors: surname particles (van der, de, al...)', 'shared',
 "  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' '), arabic: false };",
 "  let i = parts.length - 1;\n"
 "  while (i >= 2 && NAME_PARTICLES.has(parts[i - 1].toLowerCase())) i--;   // \"Jan van der Berg\" -> family \"van der Berg\"\n"
 "  return { family: parts.slice(i).join(' '), given: parts.slice(0, i).join(' '), arabic: false };")
patch('authors: particle list + initials for APA/Harvard', 'shared',
 "const invert = (n) => (n.arabic ? n.family : n.given ? `${n.family}, ${n.given}` : n.family);",
 "const NAME_PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'dos', 'das', 'le', 'la', 'el', 'al', 'bin', 'ibn', 'ter', 'ten']);\n"
 "const invert = (n) => (n.arabic ? n.family : n.given ? `${n.family}, ${n.given}` : n.family);\n"
 "/* APA / Harvard want initials: \"Smith, J. A.\" (Chicago/RIS keep the full given name via invert) */\n"
 "const invertInit = (n) => (n.arabic ? n.family : n.given ? `${n.family}, ${initialStr(n.given)}` : n.family);")
patch('authors: joinInvertedInit', 'shared',
 "function joinInvertedAmp(aNames) {",
 "function joinInvertedInit(aNames) {\n"
 "  if (!aNames.length) return t('yearUnknown') === 'n.d.' ? '[Author unknown]' : '[بلا مؤلف]';\n"
 "  const list = aNames.map(invertInit);\n"
 "  if (list.length === 1) return list[0];\n"
 "  if (list.length > 7) return list[0] + ' et al.';\n"
 "  return list.slice(0, -1).join(', ') + (LANG === 'ar' ? '، و ' : ' & ') + list[list.length - 1];\n"
 "}\nfunction joinInvertedAmp(aNames) {")
patch('authors: APA uses initials', 'shared',
 "  const authors = joinInverted(a);\n  const year = r.year ? String(r.year) : t('yearUnknown');",
 "  const authors = joinInvertedInit(a);\n  const year = r.year ? String(r.year) : t('yearUnknown');")
patch('authors: Harvard uses initials', 'shared',
 "  const authors = joinInverted(a);\n  const year = r.year || t('yearUnknown');",
 "  const authors = joinInvertedInit(a);\n  const year = r.year || t('yearUnknown');")

patch('text: resultsOf spelling', 'shared', "resultsOf: 'نتیجه من'", "resultsOf: 'نتيجة من'")
patch('text: 429 tooltip', 'shared',
 "'واجهة (التقنيات) تفرض حداً للطلبات — أعد المحاولة بعد قليل أو أضف مفتاحاً مجانياً في الإعدادات.'",
 "'هذا المصدر يفرض حدًّا لعدد الطلبات — أعد المحاولة بعد قليل أو أضف مفتاحًا مجانيًا في الإعدادات.'")
patch('text: summary prompt', 'shared', "ملخصاً شاملاً منظم اللّموضوع", "ملخصًا شاملًا ومنظّمًا حول الموضوع")
patch('text: word export caption', 'shared', "مستند Word (دعوة للنصوص المنسقة)", "مستند Word (نص منسَّق)")
patch('text: credit spelling', 'shared', "Dr. Hassan Al-Shebany", "Dr. Hassan Al-Shebani")
patch('css: undefined --err variable', 'shared', "color: var(--err);", "color: var(--warn);")
patch('head: title + self-hosted font', 'shared',
 "<title>عين المصدر | Ain Al-Masdar (ملف واحد) — Single-File — منصة",
 "<title>عين المصدر PRO | Ain Al-Masdar PRO — منصة")
patch('head: Cairo font was never loaded', 'shared',
 "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>",
 "<link rel=\"stylesheet\" href=\"/static/fonts.css\">")

# ---------------------------------------------------------------- PRO block only
patch('pro: sign-out flushes unsynced edits and wipes the local library', 'pro',
 "      out.addEventListener('click', async function () {\n"
 "        try { await fetch('/api/auth/logout', { method: 'POST', headers: JSON_HDR, credentials: 'same-origin', body: '{}' }); } catch (e) { /* ignore */ }\n"
 "        location.href = '/';\n      });",
 "      out.addEventListener('click', async function () {\n"
 "        if (localStorage.getItem('am_lib_dirty') === '1') await push();\n"
 "        if (localStorage.getItem('am_lib_dirty') === '1' && !confirm(AR() ? 'توجد تعديلات لم تُزامَن ولن تُحفظ إن خرجت الآن. هل تريد الخروج؟' : 'Some changes are not synced yet and will be lost. Sign out anyway?')) return;\n"
 "        try { await fetch('/api/auth/logout', { method: 'POST', headers: JSON_HDR, credentials: 'same-origin', body: '{}' }); } catch (e) { /* ignore */ }\n"
 "        wipeLocal();   // shared lab computers: the next person must not inherit this library or these keys\n"
 "        location.href = '/';\n      });")

NEW_SYNC = r'''  var OWNER_KEY = 'am_lib_owner';
  var LOCAL_KEYS = ['am_library', 'am_collections', 'am_saved', 'am_settings', 'am_lib_dirty', 'am_lib_synced_at', OWNER_KEY];
  function wipeLocal() { LOCAL_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }
  function syncedBadge() { badge('☁️ ' + (AR() ? 'متزامن' : 'Synced')); }
  function failedBadge() { badge('⚠️ ' + (AR() ? 'تعذّرت المزامنة' : 'Sync failed')); }
  function mergeFromServer(data, updatedAt) {
    state.library = mergeLib(state.library, (data && data.library) || []);
    state.collections = Array.from(new Set(state.collections.concat((data && data.collections) || [])));
    state.saved = new Set(state.library.map(function (x) { return x.key; }));
    _persist(); localStorage.setItem('am_lib_synced_at', updatedAt);
  }
  /* The server rejects a save built on an outdated copy (409). We then merge by item key instead of overwriting the other device's work. */
  async function push(depth) {
    depth = depth || 0;
    try {
      var base = localStorage.getItem('am_lib_synced_at') || null;
      var r = await fetch('/api/library', { method: 'PUT', headers: JSON_HDR, credentials: 'same-origin',
        body: JSON.stringify({ data: { library: state.library, collections: state.collections }, base: base }) });
      if (r.status === 401) return gotoAccount('login');
      if (r.status === 402) return gotoAccount('pro');
      if (r.status === 409 && depth < 2) {
        var c = await r.json();
        mergeFromServer(c.data, c.updatedAt); renderResults();
        return push(depth + 1);
      }
      if (r.status === 413) { badge('⚠️ ' + (AR() ? 'المكتبة أكبر من حدّ المزامنة' : 'Library too large to sync')); return; }
      if (!r.ok) throw new Error('http ' + r.status);
      var j = await r.json();
      localStorage.setItem('am_lib_synced_at', j.updatedAt); localStorage.removeItem('am_lib_dirty');
      localStorage.setItem(OWNER_KEY, U.email || '');
      syncedBadge();
    } catch (e) { failedBadge(); }
  }
'''
NEW_PULL = r'''  async function pull() {
    try {
      var r = await fetch('/api/library', { credentials: 'same-origin' });
      if (r.status === 401) return gotoAccount('login');
      if (r.status === 402) return gotoAccount('pro');
      if (!r.ok) throw new Error('http ' + r.status);
      var j = await r.json();
      var owner = localStorage.getItem(OWNER_KEY);
      if (owner && U.email && owner !== U.email) {
        // another subscriber used this browser before: never carry their library or keys into this account
        wipeLocal(); state.library = []; state.collections = [AR() ? 'عام' : 'General'];
        state.activeCollection = state.collections[0]; state.saved = new Set(); _persist(); owner = null;
      }
      var dirty = localStorage.getItem('am_lib_dirty') === '1';
      var firstSync = !owner && state.library.length > 0;   // a local (e.g. free-edition) library meets this account for the first time: merge, don't replace
      if (!j.data) {
        if (state.library.length) await push(); else { localStorage.setItem(OWNER_KEY, U.email || ''); syncedBadge(); }
        renderResults(); return;
      }
      if (dirty || firstSync) {
        if (j.updatedAt !== localStorage.getItem('am_lib_synced_at')) {
          state.library = mergeLib(state.library, j.data.library);
          state.collections = Array.from(new Set(state.collections.concat(j.data.collections)));
        }
        state.saved = new Set(state.library.map(function (x) { return x.key; }));
        _persist(); await push(); renderResults(); return;
      }
      state.library = j.data.library; state.collections = j.data.collections;
      if (!state.collections.length) state.collections = [AR() ? 'عام' : 'General'];
      if (state.collections.indexOf(state.activeCollection) < 0) state.activeCollection = state.collections[0];
      state.saved = new Set(state.library.map(function (x) { return x.key; }));
      _persist(); localStorage.setItem('am_lib_synced_at', j.updatedAt); localStorage.setItem(OWNER_KEY, U.email || '');
      syncedBadge(); renderResults();
    } catch (e) { failedBadge(); }
  }
'''

def apply(text):
    for name, scope, old, new, count in PATCHES:
        n = text.count(old)
        if n != count:
            sys.exit(f'PATCH FAILED [{name}]: expected {count} match(es), found {n}. The source changed — update tools/fix-pro.py.')
        text = text.replace(old, new)
    # sync block: replace the whole push() ... and pull() ... functions
    a = text.index('  async function push() {')
    b = text.index('  var _persist = persistLibrary;')
    text = text[:a] + NEW_SYNC + text[b:]
    a = text.index('  async function pull() {')
    b = text.index('\n  /* ---- 3) Branded')
    text = text[:a] + NEW_PULL + text[b:]
    text = text.replace('/* ---- 2) Cloud library sync (last-write-wins, with a union merge on conflict) ---- */',
                        '/* ---- 2) Cloud library sync (optimistic concurrency: stale saves get a 409 and are merged by item key) ---- */')
    # libPayload is no longer used by push(); keep the helper harmlessly
    return text

if __name__ == '__main__':
    if len(sys.argv) < 2: sys.exit(__doc__)
    src = sys.argv[1]; dst = sys.argv[2] if len(sys.argv) > 2 else src
    out = apply(open(src, encoding='utf8').read())
    open(dst, 'w', encoding='utf8').write(out)
    print(f'OK: {len(PATCHES)} patches + sync block applied -> {dst}')
