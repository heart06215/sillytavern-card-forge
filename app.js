/*
 * app.js —— 世界观卡工坊 界面逻辑
 * 依赖：png-card.js（PNGCard）、card-model.js（CardModel）
 */
(function () {
  'use strict';

  var M = CardModel;
  var $ = function (sel) { return document.querySelector(sel); };
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  var LS_AI = 'stCardMakerAI_v1';
  var LS_SAVE = 'stCardMakerSave_v1';
  var LS_TAB = 'stCardMakerTab_v3';
  var LS_CUSTOM = 'stCardMakerCustomTpl_v3';
  var LS_WORKS = 'stCardMakerWorks_v1';
  var LS_DRAFT = 'stCardMakerDraft_v1';
  var DB_NAME = 'stCardMaker';
  var BOOK_PAGE = 30;
  var MAX_AVATAR_SIDE = 1024;
  var FORM_TABS = ['tab-overview', 'tab-world', 'tab-rules', 'tab-open', 'tab-book', 'tab-lib', 'tab-ui'];

  /* ================= 状态 ================= */

  // 作品库：{ activeId, items: [{id, name, card, updatedAt}] }
  var works = { activeId: '', items: [] };
  var card = M.emptyCard();
  var avatarBytes = null;
  var avatarIsPng = false;
  var avatarUrl = null;
  var previewIdx = 0;
  var pendingGenerate = false;
  var archiveDirHandle = null;
  var bookViews = {
    card: { query: '', cat: '', limit: BOOK_PAGE },
    lib: { query: '', cat: '', limit: BOOK_PAGE }
  };
  function bv() { return bookViews[bkMode] || bookViews.card; }
  function resetBookView(mode) {
    bookViews[mode || bkMode] = { query: '', cat: '', limit: BOOK_PAGE };
  }
  var editingRuleId = null;
  var saveSettings = (function () {
    try {
      var s = JSON.parse(localStorage.getItem(LS_SAVE) || '{}') || {};
      return { savePng: s.savePng !== false, saveJson: s.saveJson !== false, alsoDownload: !!s.alsoDownload };
    } catch (e) { return { savePng: true, saveJson: true, alsoDownload: false }; }
  })();

  function currentWork() {
    return works.items.filter(function (w) { return w.id === works.activeId; })[0] || null;
  }

  function newWorkId() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ================= 小工具 ================= */

  function toast(msg, type, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, ms || 2800);
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function timestampForFile() {
    var t = new Date();
    return '' + t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate()) + '_' + pad2(t.getHours()) + pad2(t.getMinutes()) + pad2(t.getSeconds());
  }
  function shortTime(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function sanitizeFilename(s) {
    var name = M.str(s).replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_');
    return name || '世界卡';
  }

  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  /* ================= IndexedDB ================= */

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
  }
  function idbRun(mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', mode);
        var rq = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { resolve(rq ? rq.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbSet(key, val) { return idbRun('readwrite', function (s) { s.put(val, key); return null; }); }
  function idbDel(key) { return idbRun('readwrite', function (s) { s.delete(key); return null; }); }
  function idbGet(key) { return idbRun('readonly', function (s) { return s.get(key); }); }

  /* ================= 作品库存取 ================= */

  var saveWorks = debounce(function () {
    var w = currentWork();
    if (w) { w.card = card; w.updatedAt = Date.now(); }
    var payload = { activeId: works.activeId, items: works.items };
    idbSet('works', payload).catch(function () {
      try { localStorage.setItem(LS_WORKS, JSON.stringify(payload)); } catch (e) {
        toast('保存失败：浏览器存储已满，请及时导出 PNG / JSON 备份', 'err', 6000);
      }
    });
  }, 400);

  function touch() { saveWorks(); scheduleSide(); }

  function migrateOldDraft(obj) {
    if (!obj || !obj.card) return null;
    try {
      var c = M.fromInternalCard(obj.card);
      return { id: newWorkId(), name: c.name || '未命名作品', card: c, updatedAt: obj.savedAt || Date.now() };
    } catch (e) { return null; }
  }

  function loadWorks() {
    return idbGet('works').catch(function () { return null; }).then(function (obj) {
      if (!obj) {
        try { obj = JSON.parse(localStorage.getItem(LS_WORKS) || 'null'); } catch (e) { obj = null; }
      }
      if (!obj || !Array.isArray(obj.items) || !obj.items.length) {
        // 兼容旧版单卡草稿
        var old = null;
        try { old = JSON.parse(localStorage.getItem(LS_DRAFT) || 'null'); } catch (e) { old = null; }
        var migrated = migrateOldDraft(old);
        if (migrated) {
          works = { activeId: migrated.id, items: [migrated] };
          return true;
        }
        return false;
      }
      var items = [];
      obj.items.forEach(function (w) {
        try {
          items.push({ id: w.id || newWorkId(), name: M.str(w.name), card: M.fromInternalCard(w.card), updatedAt: w.updatedAt || Date.now() });
        } catch (e) { /* 跳过损坏条目 */ }
      });
      if (!items.length) return false;
      var active = items.filter(function (w) { return w.id === obj.activeId; })[0] || items[0];
      works = { activeId: active.id, items: items };
      return true;
    }).then(function (restored) {
      // 首次使用或旧数据不可用时，建一个默认作品
      if (!works.items.length) {
        var c = M.emptyCard();
        c.rules = M.defaultRules();
        works = { activeId: '', items: [{ id: newWorkId(), name: '未命名作品', card: c, updatedAt: Date.now() }] };
        works.activeId = works.items[0].id;
      }
      return restored;
    });
  }

  function switchWork(id) {
    if (id === works.activeId) return;
    var target = works.items.filter(function (w) { return w.id === id; })[0];
    if (!target) return;
    saveWorks();
    works.activeId = id;
    card = target.card;
    afterWorkSwitch();
    saveWorks();
    toast('已切换到「' + (card.name.trim() || '未命名作品') + '」', 'ok');
  }

  function afterWorkSwitch() {
    invalidateHelper();
    previewIdx = 0;
    resetBookView('card');
    $('#bookSearch').value = '';
    editingRuleId = null;
    $('#ruleEditor').hidden = true;
    bkMode = 'card';
    renderAll();
  }

  function createWork(dup) {
    invalidateHelper();
    var c = M.emptyCard();
    if (dup) {
      c = M.clone(card);
      c.name = c.name ? c.name + '（副本）' : '副本';
    }
    var w = { id: newWorkId(), name: c.name || '未命名作品', card: c, updatedAt: Date.now() };
    works.items.push(w);
    works.activeId = w.id;
    card = c;
    afterWorkSwitch();
    saveWorks();
    setFormTab('tab-overview');
    toast(dup ? '已复制当前作品' : '已新建作品', 'ok');
  }

  function deleteWork() {
    var w = currentWork();
    if (!w) return;
    if (!confirm('删除作品「' + (card.name.trim() || w.name || '未命名作品') + '」？此操作不可撤销。')) return;
    var idx = works.items.indexOf(w);
    works.items.splice(idx, 1);
    if (!works.items.length) {
      var c = M.emptyCard();
      works.items.push({ id: newWorkId(), name: '未命名作品', card: c, updatedAt: Date.now() });
    }
    var next = works.items[Math.max(0, idx - 1)];
    works.activeId = next.id;
    card = next.card;
    afterWorkSwitch();
    saveWorks();
    toast('作品已删除', 'ok');
  }

  function renderWorks() {
    var wrap = $('#worksList');
    wrap.innerHTML = '';
    if (!works.items.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="es-icon">📁</div><div class="es-title">还没有作品</div><div class="es-text">点「新建作品」开始，或导入一张 PNG / JSON 世界卡。</div></div>';
      $('#worksHint').textContent = '';
      return;
    }
    works.items.forEach(function (w) {
      var item = document.createElement('div');
      item.className = 'work-item' + (w.id === works.activeId ? ' active' : '');
      var name = document.createElement('span');
      name.className = 'w-name';
      name.textContent = w.card.name.trim() || '未命名作品';
      var meta = document.createElement('span');
      meta.className = 'w-meta';
      var bk = w.card.character_book.entries.length;
      meta.textContent = '世界书 ' + bk + ' · ' + shortTime(w.updatedAt);
      item.appendChild(name);
      item.appendChild(meta);
      item.addEventListener('click', function () { switchWork(w.id); });
      wrap.appendChild(item);
    });
    $('#worksHint').textContent = '共 ' + works.items.length + ' 个作品';
  }

  /* ================= 表单绑定 ================= */

  // 文本框自动增高：编辑现成卡时，长内容不会被压在几行高的小框里
  function autoGrow(ta, max) {
    if (!ta) return;
    max = max || 600;
    try {
      // 记录初始高度作为下限：隐藏元素测不到 scrollHeight，避免被压成 0
      if (ta.__minH == null) {
        var r = ta.rows || 3;
        ta.__minH = r * 22 + 18;
      }
      var prev = ta.style.height;
      ta.style.height = "auto";
      var h = ta.scrollHeight;
      if (!h) h = ta.__minH;                 // 隐藏或空内容
      h = Math.max(h, ta.__minH);
      ta.style.height = Math.min(h, max) + "px";
      ta.style.overflowY = h > max ? "auto" : "hidden";
      if (prev === ta.style.height) ta.style.height = prev;
    } catch (e) { /* ignore */ }
  }
  // 给文本框绑定自动增高
  function bindAutoGrow(ta, max) {
    if (!ta || ta.__autoGrow) return;
    ta.__autoGrow = true;
    ta.__autoGrowMax = max || 600;
    ta.addEventListener("input", function () { autoGrow(ta, ta.__autoGrowMax); });
    autoGrow(ta, ta.__autoGrowMax);
  }
  // 页签切换后重新计算（隐藏元素测不到 scrollHeight）
  function refreshAutoGrow(sel) {
    var list = document.querySelectorAll(sel + " textarea");
    Array.prototype.forEach.call(list, function (ta) {
      if (ta.__autoGrow) autoGrow(ta, ta.__autoGrowMax);
    });
  }
  function updateCount(el) {
    if (!el.hasAttribute('data-count')) return;
    var hint = el.nextElementSibling;
    if (!hint || !hint.classList.contains('count-hint')) {
      hint = document.createElement('span');
      hint.className = 'count-hint';
      el.parentNode.insertBefore(hint, el.nextSibling);
    }
    hint.textContent = M.str(el.value).length + ' 字';
  }

  function bindFields() {
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!t.hasAttribute || !t.hasAttribute('data-field')) return;
      card[t.getAttribute('data-field')] = t.value;
      if (t.getAttribute('data-field') === 'name') refreshWorkName();
      updateCount(t);
      touch();
    });
    $('#f-tags').addEventListener('input', function () { card.tags = M.toList(this.value); touch(); });
    $('#f-spec').addEventListener('change', function () {
      card.spec = this.value;
      touch();
      renderJsonIfVisible();
      toast('导出规范已切换为 ' + (this.value === 'chara_card_v3' ? 'V3' : 'V2'), 'ok');
    });
    $('#f-book-name').addEventListener('input', function () { card.character_book.name = this.value; touch(); });
    $('#f-book-scan').addEventListener('input', function () { card.character_book.scan_depth = M.num(this.value, 2); touch(); });
    $('#f-book-budget').addEventListener('input', function () { card.character_book.token_budget = M.num(this.value, 500); touch(); });
    $('#f-book-recursive').addEventListener('change', function () { card.character_book.recursive_scanning = this.checked; touch(); });
    $('#dp-prompt').addEventListener('input', function () { card.extensions.depth_prompt.prompt = this.value; touch(); });
    $('#dp-depth').addEventListener('input', function () { card.extensions.depth_prompt.depth = M.num(this.value, 4); touch(); });
    $('#dp-role').addEventListener('change', function () { card.extensions.depth_prompt.role = this.value; touch(); });
  }

  function refreshWorkName() {
    var w = currentWork();
    if (w) { w.name = card.name.trim() || '未命名作品'; }
    renderWorks();
  }

  function syncFieldsToForm() {
    $$('[data-field]').forEach(function (el) {
      var v = card[el.getAttribute('data-field')];
      el.value = v == null ? '' : v;
      updateCount(el);
      if (el.tagName === 'TEXTAREA') bindAutoGrow(el, 600);
    });
    $('#f-tags').value = card.tags.join(', ');
    $('#f-spec').value = card.spec;
    var bk = card.character_book;
    $('#f-book-name').value = bk.name || '';
    $('#f-book-scan').value = bk.scan_depth;
    $('#f-book-budget').value = bk.token_budget;
    $('#f-book-recursive').checked = !!bk.recursive_scanning;
    var dp = card.extensions.depth_prompt;
    $('#dp-prompt').value = dp.prompt || '';
    $('#dp-depth').value = dp.depth;
    $('#dp-role').value = dp.role;
    syncToneToForm();
    syncRawExtrasToForm();
  }

  /* ================= 世界书（卡内 / 世界书库共用） ================= */

  // 世界书库：非内嵌世界书，导出为独立 .json 供酒馆「世界书」面板导入
  var libBooks = { activeId: '', items: [] };
  var bkMode = 'card'; // 'card' = 当前作品的卡内世界书；'lib' = 世界书库当前书

  function activeLibBook() {
    return libBooks.items.filter(function (b) { return b.id === libBooks.activeId; })[0] || null;
  }
  function currentBook() {
    return bkMode === 'lib' ? (activeLibBook() || M.emptyBook()) : card.character_book;
  }
  // 各模式对应的 DOM 容器
  var BK_DOM = {
    card: { wrap: '#bookEntries', stats: '#bookStats', cat: '#catFilter', search: '#bookSearch', collapse: '#bookCollapseAll', tText: '#tester-text', tRes: '#tester-result', newCat: '#newEntryCat', tpl: '#btnAddFromTpl' },
    lib: { wrap: '#libEntries', stats: '#libStats', cat: '#libCatFilter', search: '#libSearch', collapse: '#libCollapseAll', tText: '#libTesterText', tRes: '#libTesterResult', newCat: '#libNewCat', tpl: '#btnLibAddFromTpl' }
  };
  function dom() { return BK_DOM[bkMode]; }

  function renderBookStats() {
    var stats = M.bookStats(currentBook());
    if (bkMode === 'card') {
      var el = document.getElementById('badge-book');
      if (el) { el.textContent = stats.total; el.setAttribute('data-zero', stats.total ? '0' : '1'); }
    }
    var wrap = $(dom().stats);
    if (!wrap) return;
    var parts = [['条目', stats.total], ['启用', stats.enabled], ['常驻', stats.constant], ['分类', Object.keys(stats.byCategory).length]];
    wrap.innerHTML = '';
    parts.forEach(function (p) {
      var s = document.createElement('span');
      s.className = 'stat';
      s.innerHTML = '<b></b><i></i>';
      s.querySelector('b').textContent = p[1];
      s.querySelector('i').textContent = p[0];
      wrap.appendChild(s);
    });
  }

  function categoryCounts() {
    var counts = {};
    currentBook().entries.forEach(function (e) {
      var c = M.categoryOf(e.comment) || '未分类';
      counts[c] = (counts[c] || 0) + 1;
    });
    return counts;
  }

  function renderCatFilter() {
    var wrap = $(dom().cat);
    if (!wrap) return;
    var counts = categoryCounts();
    wrap.innerHTML = '';
    if (!currentBook().entries.length) return;
    function chip(label, value, n) {
      var b = document.createElement('button');
      b.className = 'cat-chip' + (bv().cat === value ? ' active' : '');
      b.textContent = label + ' ' + n;
      b.addEventListener('click', function () { bv().cat = value; bv().limit = BOOK_PAGE; renderBookList(); renderCatFilter(); });
      wrap.appendChild(b);
    }
    chip('全部', '', currentBook().entries.length);
    M.CATEGORIES.forEach(function (c) { if (counts[c]) chip(c, c, counts[c]); });
    var extra = Object.keys(counts).filter(function (c) { return M.CATEGORIES.indexOf(c) === -1; });
    extra.forEach(function (c) { chip(c, c, counts[c]); });
  }

  function entryHaystack(e) {
    return ((e.comment || '') + ' ' + (e.name || '') + ' ' + e.keys.join(' ') + ' ' + e.secondary_keys.join(' ') + ' ' + e.content).toLowerCase();
  }
  function entryMatchesCat(e, cat) {
    if (!cat) return true;
    var c = M.categoryOf(e.comment);
    return cat === '未分类' ? !c : c === cat;
  }

  function renderBookList() {
    var wrap = $(dom().wrap);
    if (!wrap) return;
    wrap.innerHTML = '';
    var book = currentBook();
    renderBookStats();
    if (!book.entries.length) {
      var emptyTxt = bkMode === 'lib'
        ? '这本世界书还是空的。独立世界书导出后可在酒馆「世界书」面板导入，挂到任意角色卡上。'
        : '把地点、势力、人物、物品、规则拆成一条条碎片设定：命中关键词时才注入，比全部写进总纲更省 token。可用「模板新建」快速起步。';
      wrap.innerHTML = '<div class="empty-state"><div class="es-icon">' + (bkMode === 'lib' ? '📕' : '📚') + '</div><div class="es-title">还没有条目</div><div class="es-text">' + emptyTxt + '</div></div>';
      return;
    }
    var q = bv().query;
    var matched = [];
    book.entries.forEach(function (e, i) {
      if (entryMatchesCat(e, bv().cat) && (!q || entryHaystack(e).indexOf(q) !== -1)) matched.push(i);
    });
    if (!matched.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="es-icon">🔍</div><div class="es-title">没有匹配的条目</div><div class="es-text">换个关键词，或切换到「全部」分类。</div></div>';
      return;
    }
    var shown = matched.slice(0, bv().limit);
    shown.forEach(function (i) { wrap.appendChild(buildEntryEl(book.entries[i], i)); });
    var foot = document.createElement('div');
    foot.className = 'book-foot';
    var info = document.createElement('span');
    info.textContent = '显示 ' + shown.length + ' / ' + matched.length + ' 条' + (matched.length !== book.entries.length ? '（已筛选，共 ' + book.entries.length + ' 条）' : '');
    foot.appendChild(info);
    if (matched.length > shown.length) {
      var more = document.createElement('button');
      more.className = 'btn small';
      more.textContent = '加载更多（+' + Math.min(BOOK_PAGE, matched.length - shown.length) + '）';
      more.addEventListener('click', function () { bv().limit += BOOK_PAGE; renderBookList(); });
      foot.appendChild(more);
    }
    wrap.appendChild(foot);
  }

  function renderTester() {
    var d = dom();
    var text = $(d.tText).value;
    var out = $(d.tRes);
    if (!out) return;
    if (!text.trim()) { out.innerHTML = '<span class="hint">输入文本后，这里会列出会被注入的条目。</span>'; return; }
    var hits = M.scanEntries(currentBook().entries, text);
    out.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'hint';
    head.textContent = '将注入 ' + hits.length + ' 条（常驻条目始终注入）';
    out.appendChild(head);
    hits.slice(0, 40).forEach(function (h) {
      var row = document.createElement('div');
      row.className = 'hit-row';
      var t = document.createElement('span');
      t.className = 'hit-title';
      t.textContent = h.entry.comment || ('条目 #' + (h.index + 1));
      var r = document.createElement('span');
      r.className = 'hit-reason';
      r.textContent = h.reason;
      row.appendChild(t);
      row.appendChild(r);
      row.addEventListener('click', function () { focusEntry(h.index); });
      out.appendChild(row);
    });
  }

  function focusEntry(index) {
    bv().cat = ''; bv().query = ''; bv().limit = Math.max(BOOK_PAGE, index + 1);
    $(dom().search).value = '';
    setFormTab(bkMode === 'lib' ? 'tab-lib' : 'tab-book');
    renderCatFilter();
    renderBookList();
    var el = document.querySelector(dom().wrap + ' .entry[data-idx="' + index + '"]');
    if (el) {
      var d = el.querySelector('.entry-adv');
      if (d) d.open = true;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(function () { el.classList.remove('flash'); }, 1400);
    }
  }

  function iconBtn(text, title, onclick, extra) {
    var b = document.createElement('button');
    b.className = 'icon-btn' + (extra ? ' ' + extra : '');
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', onclick);
    return b;
  }

  function textField(label, value, onInput) {
    var l = document.createElement('label');
    l.className = 'field';
    var s = document.createElement('span');
    s.className = 'label';
    s.textContent = label;
    l.appendChild(s);
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = value == null ? '' : value;
    inp.addEventListener('input', function () { onInput(this.value); });
    l.appendChild(inp);
    return l;
  }
  function numField(label, value, onInput, min) {
    var l = document.createElement('label');
    l.className = 'field';
    var s = document.createElement('span');
    s.className = 'label';
    s.textContent = label;
    l.appendChild(s);
    var inp = document.createElement('input');
    inp.type = 'number';
    if (min != null) inp.min = min;
    inp.value = value == null ? '' : value;
    inp.addEventListener('input', function () { onInput(this.value); });
    l.appendChild(inp);
    return l;
  }
  // null = 继承全局设置；空输入表示继承
  function nullableNumField(label, value, onInput) {
    var l = document.createElement('label');
    l.className = 'field';
    var s = document.createElement('span');
    s.className = 'label';
    s.textContent = label;
    l.appendChild(s);
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.placeholder = '继承';
    inp.value = value == null ? '' : value;
    inp.addEventListener('input', function () { onInput(this.value === '' ? null : M.num(this.value, 0)); });
    l.appendChild(inp);
    return l;
  }
  // 三态开关：继承(null) / 开 / 关
  function triBoolField(label, value, onChange) {
    var l = document.createElement('label');
    l.className = 'field';
    var s = document.createElement('span');
    s.className = 'label';
    s.textContent = label;
    l.appendChild(s);
    var sel = document.createElement('select');
    [['inherit', '继承'], ['on', '开'], ['off', '关']].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.value = value === null || value === undefined ? 'inherit' : (value ? 'on' : 'off');
    sel.addEventListener('change', function () {
      onChange(sel.value === 'inherit' ? null : sel.value === 'on');
    });
    l.appendChild(sel);
    return l;
  }
  function selectField(label, options, value, onChange) {
    var l = document.createElement('label');
    l.className = 'field';
    var s = document.createElement('span');
    s.className = 'label';
    s.textContent = label;
    l.appendChild(s);
    var sel = document.createElement('select');
    options.forEach(function (op) {
      var o = document.createElement('option');
      o.value = op.v; o.textContent = op.t;
      sel.appendChild(o);
    });
    sel.value = value;
    sel.addEventListener('change', function () { onChange(this.value); });
    l.appendChild(sel);
    return l;
  }
  function checkField(label, checked, onChange) {
    var l = document.createElement('label');
    l.className = 'checkbox-field';
    l.innerHTML = '<input type="checkbox"><span></span>';
    l.querySelector('span').textContent = label;
    var cb = l.querySelector('input');
    cb.checked = !!checked;
    cb.addEventListener('change', function () { onChange(this.checked); });
    return l;
  }
  function grid(cls, children) {
    var g = document.createElement('div');
    g.className = cls;
    children.forEach(function (c) { if (c) g.appendChild(c); });
    return g;
  }

  function buildEntryEl(entry, i) {
    var box = document.createElement('div');
    box.className = 'entry' + (entry.enabled ? '' : ' is-off');
    box.setAttribute('data-idx', i);

    var head = document.createElement('div');
    head.className = 'entry-head';
    var num = document.createElement('span');
    num.className = 'e-num';
    num.textContent = '#' + (i + 1);
    head.appendChild(num);

    var catSel = document.createElement('select');
    catSel.className = 'e-cat';
    catSel.title = '条目分类（写入 comment 的【】前缀）';
    var curCat = M.categoryOf(entry.comment);
    var cats = [''].concat(M.CATEGORIES);
    if (curCat && cats.indexOf(curCat) === -1) cats.push(curCat);
    cats.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c || '无分类';
      catSel.appendChild(o);
    });
    catSel.value = curCat;
    head.appendChild(catSel);

    var title = document.createElement('input');
    title.type = 'text';
    title.className = 'e-title';
    title.placeholder = '条目标题，如：北境钟楼';
    title.value = M.titleOf(entry.comment);
    head.appendChild(title);

    function recompose() { entry.comment = M.withCategory(catSel.value, title.value); bookChanged(); }
    catSel.addEventListener('change', function () { recompose(); renderCatFilter(); });
    title.addEventListener('input', recompose);

    var pos = document.createElement('span');
    pos.className = 'e-pos';
    pos.textContent = entry.constant ? '常驻' : (entry.keys.length ? M.posLabel(entry.position) : '无关键词');
    head.appendChild(pos);

    var enLabel = document.createElement('label');
    enLabel.className = 'checkbox-field';
    enLabel.innerHTML = '<input type="checkbox"><span>启用</span>';
    var enBox = enLabel.querySelector('input');
    enBox.checked = entry.enabled;
    enBox.addEventListener('change', function () { entry.enabled = this.checked; box.classList.toggle('is-off', !entry.enabled); bookChanged(); });
    head.appendChild(enLabel);

    head.appendChild(iconBtn('↑', '上移', function () { moveEntry(i, -1); }));
    head.appendChild(iconBtn('↓', '下移', function () { moveEntry(i, 1); }));
    head.appendChild(iconBtn('⎘', '复制', function () { duplicateEntry(i); }));
    head.appendChild(iconBtn('✕', '删除', function () { deleteEntry(i); }, 'danger'));
    box.appendChild(head);

    var row = document.createElement('div');
    row.className = 'grid2';
    row.appendChild(textField('关键词 keys（逗号分隔，命中即注入）', entry.keys.join(', '), function (v) {
      entry.keys = M.toList(v);
      pos.textContent = entry.constant ? '常驻' : (entry.keys.length ? M.posLabel(entry.position) : '无关键词');
      bookChanged();
    }));
    row.appendChild(textField('次级关键词 secondary_keys（配合「选择性」）', entry.secondary_keys.join(', '), function (v) {
      entry.secondary_keys = M.toList(v); bookChanged();
    }));
    box.appendChild(row);

    var content = document.createElement('label');
    content.className = 'field';
    content.innerHTML = '<span class="label">内容 content（命中后注入给模型的设定文本）</span>';
    var ta = document.createElement('textarea');
    ta.rows = 4;
    ta.value = entry.content;
    bindAutoGrow(ta, 600);
    ta.addEventListener('input', function () { entry.content = this.value; bookChanged(); });
    content.appendChild(ta);
    box.appendChild(content);

    box.appendChild(buildAdvanced(entry, pos));
    return box;
  }

  function buildAdvanced(entry, posTag) {
    var details = document.createElement('details');
    details.className = 'entry-adv';
    var sum = document.createElement('summary');
    sum.textContent = '高级设置：位置 / 深度 / 概率 / 递归 / 冷却 / 分组';
    details.appendChild(sum);
    var body = document.createElement('div');
    body.className = 'adv-body';
    details.appendChild(body);
    var filled = false;

    function refreshPos() { posTag.textContent = entry.constant ? '常驻' : (entry.keys.length ? M.posLabel(entry.position) : '无关键词'); }

    function fill() {
      if (filled) return;
      filled = true;
      body.appendChild(grid('grid4', [
        selectField('插入位置 position', M.POSITIONS, entry.position, function (v) { entry.position = M.num(v, 0); refreshPos(); bookChanged(); }),
        numField('插入深度 depth（按深度时）', entry.depth, function (v) { entry.depth = M.num(v, 4); bookChanged(); }, 0),
        selectField('消息身份 role（按深度时）', M.ROLE_OPTIONS, entry.role, function (v) { entry.role = v; entry.roleRaw = v; bookChanged(); }),
        numField('插入顺序 insertion_order（小者优先）', entry.insertion_order, function (v) { entry.insertion_order = M.num(v, 100); bookChanged(); })
      ]));
      body.appendChild(grid('grid4', [
        numField('优先级 priority（预算不足时先丢大者）', entry.priority, function (v) { entry.priority = M.num(v, 10); bookChanged(); }),
        numField('触发概率 probability %', entry.probability, function (v) { entry.probability = M.num(v, 100); bookChanged(); }, 0),
        nullableNumField('扫描深度 scanDepth（空=继承）', entry.scanDepth, function (v) { entry.scanDepth = v; bookChanged(); }),
        selectField('次级逻辑 selectiveLogic', M.SELECTIVE_LOGIC, entry.selectiveLogic, function (v) { entry.selectiveLogic = M.num(v, 0); bookChanged(); })
      ]));
      body.appendChild(grid('grid4', [
        nullableNumField('粘性 sticky（空=继承）', entry.sticky, function (v) { entry.sticky = v; bookChanged(); }),
        nullableNumField('冷却 cooldown（空=继承）', entry.cooldown, function (v) { entry.cooldown = v; bookChanged(); }),
        nullableNumField('延迟 delay（空=继承）', entry.delay, function (v) { entry.delay = v; bookChanged(); }),
        textField('分组 group（同名互斥）', entry.group, function (v) { entry.group = v; bookChanged(); })
      ]));
      body.appendChild(grid('grid4', [
        numField('分组权重 groupWeight', entry.groupWeight, function (v) { entry.groupWeight = M.num(v, 100); bookChanged(); }),
        numField('条目 id（uid，留空自动）', entry.id == null ? '' : entry.id, function (v) { entry.id = v === '' ? null : M.num(v, null); bookChanged(); }),
        nullableNumField('显示序号 displayIndex', entry.displayIndex, function (v) { entry.displayIndex = v; bookChanged(); }),
        textField('内部名 name（可选）', entry.name, function (v) { entry.name = v; bookChanged(); })
      ]));
      body.appendChild(grid('grid4 flags', [
        checkField('常驻 constant（始终注入）', entry.constant, function (v) { entry.constant = v; refreshPos(); bookChanged(); }),
        checkField('选择性 selective', entry.selective, function (v) { entry.selective = v; bookChanged(); }),
        triBoolField('区分大小写 caseSensitive', entry.case_sensitive, function (v) { entry.case_sensitive = v; bookChanged(); }),
        triBoolField('全词匹配 matchWholeWords', entry.matchWholeWords, function (v) { entry.matchWholeWords = v; bookChanged(); }),
        checkField('正则匹配 use_regex', entry.use_regex, function (v) { entry.use_regex = v; bookChanged(); }),
        checkField('按概率触发', entry.useProbability, function (v) { entry.useProbability = v; bookChanged(); }),
        checkField('忽略预算 ignoreBudget', entry.ignoreBudget, function (v) { entry.ignoreBudget = v; bookChanged(); }),
        triBoolField('分组评分 useGroupScoring', entry.useGroupScoring, function (v) { entry.useGroupScoring = v; bookChanged(); }),
        checkField('加入备忘录 addMemo', entry.addMemo, function (v) { entry.addMemo = v; bookChanged(); })
      ]));
      body.appendChild(grid('grid4 flags', [
        checkField('排除递归', entry.excludeRecursion, function (v) { entry.excludeRecursion = v; bookChanged(); }),
        checkField('阻止递归', entry.preventRecursion, function (v) { entry.preventRecursion = v; bookChanged(); }),
        checkField('延迟至递归', entry.delayUntilRecursion, function (v) { entry.delayUntilRecursion = v; entry.delayRaw = v; bookChanged(); }),
        checkField('分组覆盖', entry.groupOverride, function (v) { entry.groupOverride = v; bookChanged(); }),
        checkField('向量化 vectorized', entry.vectorized, function (v) { entry.vectorized = v; bookChanged(); })
      ]));

      // 酒馆原生匹配来源（独立世界书常用）
      var nat = document.createElement('div');
      nat.className = 'adv-sub';
      nat.textContent = '匹配来源（酒馆原生世界书）';
      body.appendChild(nat);
      body.appendChild(grid('grid4 flags', [
        checkField('用户描述 persona', entry.matchPersonaDescription, function (v) { entry.matchPersonaDescription = v; bookChanged(); }),
        checkField('角色描述', entry.matchCharacterDescription, function (v) { entry.matchCharacterDescription = v; bookChanged(); }),
        checkField('角色性格', entry.matchCharacterPersonality, function (v) { entry.matchCharacterPersonality = v; bookChanged(); }),
        checkField('深度提示', entry.matchCharacterDepthPrompt, function (v) { entry.matchCharacterDepthPrompt = v; bookChanged(); }),
        checkField('场景 scenario', entry.matchScenario, function (v) { entry.matchScenario = v; bookChanged(); }),
        checkField('作者备注', entry.matchCreatorNotes, function (v) { entry.matchCreatorNotes = v; bookChanged(); })
      ]));
      body.appendChild(grid('grid4', [
        textField('触发词 triggers（逗号分隔）', (entry.triggers || []).join(', '), function (v) { entry.triggers = M.toList(v); bookChanged(); }),
        textField('自动化 automationId', entry.automationId, function (v) { entry.automationId = v; bookChanged(); }),
        textField('出口 outletName', entry.outletName, function (v) { entry.outletName = v; bookChanged(); })
      ]));

      var keys = Object.keys(entry.extra || {});
      if (keys.length) {
        var note = document.createElement('p');
        note.className = 'kept-note';
        note.textContent = '已保留酒馆原生字段（导出时原样写回）：' + keys.join('、');
        body.appendChild(note);
      }
    }

    details.addEventListener('toggle', function () { if (details.open) fill(); });
    var cb = $(dom().collapse);
    if (!cb || !cb.checked) details.open = true;
    if (details.open) fill();
    return details;
  }

  function moveEntry(i, dir) {
    var arr = currentBook().entries;
    var j = i + dir;
    if (j < 0 || j >= arr.length) return;
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    renderBookList(); bookChanged();
  }
  function duplicateEntry(i) {
    var arr = currentBook().entries;
    var copy = M.normalizeEntry(M.clone(M.entryToCharBook(arr[i])));
    copy.id = null;
    copy.comment = (copy.comment || '未命名') + '（副本）';
    arr.splice(i + 1, 0, copy);
    renderBookList(); bookChanged();
    toast('已复制条目', 'ok');
  }
  function deleteEntry(i) {
    var e = currentBook().entries[i];
    if (e.content.length > 60 && !confirm('删除条目「' + (M.titleOf(e.comment) || '未命名') + '」？内容将不可恢复。')) return;
    currentBook().entries.splice(i, 1);
    renderBookList(); bookChanged();
  }
  function addEntry(category, title, content, extra) {
    var list = currentBook().entries;
    var e = M.newEntry(category, title, list.length + 1);
    if (content) e.content = content;
    if (extra && extra.keys) e.keys = M.toList(extra.keys);
    if (extra && extra.constant) e.constant = true;
    list.push(e);
    bv().cat = ''; bv().query = ''; $(dom().search).value = '';
    bv().limit = Math.max(BOOK_PAGE, list.length);
    renderCatFilter();
    renderBookList();
    bookChanged();
    var last = document.querySelector(dom().wrap + ' .entry:last-of-type .e-title');
    if (last) { last.scrollIntoView({ block: 'center', behavior: 'smooth' }); last.focus(); }
  }

  var ENTRY_TEMPLATES = [
    { id: 'rule', cat: '规则', title: '世界规则', constant: true, keys: '', content: '【世界规则】\n1. （核心法则一：它如何运作、有什么代价）\n2. （核心法则二）\n3. （不可违背的底线）' },
    { id: 'place', cat: '地理', title: '（地点名）', constant: false, keys: '地点名, 别称', content: '【地点】（名称）\n位置：（方位与距离）\n氛围：（气味、光线、温度等感官细节）\n现状：（谁控制、正在发生什么）\n传闻：（玩家可能听到的说法，真假参半）' },
    { id: 'faction', cat: '势力', title: '（势力名）', constant: false, keys: '势力名, 别称', content: '【势力】（名称）\n立场：（对外宣称的目标 vs 实际利益）\n结构：（领导者、主要成员）\n与玩家的关系：（初始态度与可被改变的条件）' },
    { id: 'person', cat: '人物', title: '（NPC 名）', constant: false, keys: 'NPC名, 绰号', content: '【人物】（姓名）\n身份：（职业、阵营）\n外貌：（特征）\n性格与目标：（想要什么、害怕什么）\n说话方式：（语气与口癖）\n与玩家的关系：（初始态度）' },
    { id: 'item', cat: '物品', title: '（物品名）', constant: false, keys: '物品名', content: '【物品】（名称）\n来历：（从哪里来、谁制作）\n效果：（具体作用与限制）\n代价：（使用后的副作用或世界反应）' },
    { id: 'history', cat: '历史', title: '（历史事件）', constant: false, keys: '事件名, 年份', content: '【历史】（事件名，年份）\n起因：\n经过：\n结果：\n留下的痕迹：（今天哪些地方、人物仍受影响）' },
    { id: 'event', cat: '事件', title: '（可触发事件）', constant: false, keys: '触发词', content: '【事件】（名称）\n触发条件：（什么情况下发生）\n发展：（分几个阶段，每阶段的变化）\n结局分支：（不同选择导致的不同结果）' }
  ];

  function openTemplatePicker() {
    var d = dom();
    var existing = document.getElementById('tplPicker');
    if (existing) { existing.remove(); return; }
    var box = document.createElement('div');
    box.id = 'tplPicker';
    box.className = 'tpl-picker';
    var title = document.createElement('div');
    title.className = 'tp-title';
    title.textContent = '选择条目模板（会新建一条并填入骨架）';
    box.appendChild(title);
    ENTRY_TEMPLATES.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = '【' + t.cat + '】' + t.title.replace(/[（(].*[）)]/, '…');
      b.addEventListener('click', function () {
        addEntry(t.cat, t.title, t.content, { keys: t.keys, constant: t.constant });
        box.remove();
      });
      box.appendChild(b);
    });
    var anchor = $(d.tpl);
    anchor.parentNode.insertBefore(box, anchor.nextSibling);
  }

  // 卡内世界书与原生世界书互导
  function importNativeBookIntoCurrent(parsed) {
    var bk = currentBook();
    var replace = !bk.entries.length || confirm('当前世界书已有 ' + bk.entries.length + ' 条：\n确定 = 覆盖，取消 = 追加到末尾');
    if (replace) bk.entries = parsed.entries; else bk.entries = bk.entries.concat(parsed.entries);
    if (parsed.name && (replace || !bk.name)) bk.name = parsed.name;
    if (replace && parsed.raw && typeof parsed.raw === 'object') bk.raw = parsed.raw;
    if (bkMode === 'lib') {
      var lb = activeLibBook();
      if (lb) {
        lb.entries = bk.entries;
        lb.name = bk.name || lb.name;
        lb.raw = bk.raw || lb.raw || {};
      }
      syncLibToForm();
    } else {
      syncFieldsToForm();
    }
    bv().cat = ''; bv().limit = BOOK_PAGE;
    renderBookList(); renderCatFilter();
    bookChanged();
    toast('世界书导入成功：' + parsed.entries.length + ' 条（' + (replace ? '已覆盖' : '已追加') + '）', 'ok', 4200);
  }

  // 独立世界书 JSON → 世界书库（粘贴解析 / 顶栏导入共用）
  function importNativeBookList(parsed) {
    if (!parsed || !parsed.entries || !parsed.entries.length) {
      toast('世界书为空，无法导入', 'err');
      return;
    }
    bkMode = 'lib';
    if (!activeLibBook()) {
      var nb = M.emptyBook();
      libBooks.items.push({
        id: newWorkId(), name: parsed.name || '未命名世界书',
        scan_depth: nb.scan_depth, token_budget: nb.token_budget, recursive_scanning: false,
        entries: [], extensions: {}, raw: {}, updatedAt: Date.now()
      });
      libBooks.activeId = libBooks.items[libBooks.items.length - 1].id;
    }
    importNativeBookIntoCurrent(parsed);
    renderLibList();
    setFormTab('tab-lib');
  }

  function exportCurrentBook() {
    var bk = currentBook();
    if (!bk.entries.length) { toast('世界书暂无条目，无法导出', 'err'); return; }
    var obj = M.buildNativeBook(bk.name || (bkMode === 'lib' ? '' : card.name), bk.entries, bk.raw);
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    download(blob, sanitizeFilename(bk.name || card.name || '世界书') + '_世界书.json');
    toast('世界书已导出（SillyTavern 原生格式，可在酒馆「世界书」面板导入）', 'ok', 4200);
  }

  // 条目变化后的持久化与联动
  function bookChanged() {
    if (bkMode === 'card') {
      // 有条目但世界书还没命名时，按作品名自动补一个（否则导入酒馆后关联不上）
      var bk = card.character_book;
      if (!bk.name.trim() && bk.entries.length && card.name.trim()) {
        bk.name = card.name.trim() + ' 世界书';
        var nm = $('#f-book-name');
        if (nm) nm.value = bk.name;
      }
      touch();
      renderBookStats();
    } else {
      saveLibBooks();
      renderBookStats();
    }
  }

  function bindBook() {
    $('#btnAddEntry').addEventListener('click', function () { bkMode = 'card'; addEntry($('#newEntryCat').value, '新条目', ''); });
    $('#btnAddFromTpl').addEventListener('click', function () { bkMode = 'card'; openTemplatePicker(); });
    $('#btnImportBook').addEventListener('click', function () { bkMode = 'card'; $('#bookFile').click(); });
    $('#btnExportBook').addEventListener('click', function () { bkMode = 'card'; exportCurrentBook(); });
    $('#bookFile').addEventListener('change', async function () {
      bkMode = 'card';
      if (!this.files || !this.files[0]) return;
      try {
        var o = JSON.parse(await this.files[0].text());
        var parsed = M.parseNativeBook(o);
        if (!parsed) throw new Error('未找到世界书条目（应为 {entries:{...}} 或 {entries:[...]}）');
        importNativeBookIntoCurrent(parsed);
      } catch (e) { toast('世界书导入失败：' + e.message, 'err', 5200); }
      this.value = '';
    });
    $('#bookSearch').addEventListener('input', debounce(function () {
      bkMode = 'card';
      bv().query = this.value.trim().toLowerCase();
      bv().limit = BOOK_PAGE;
      renderBookList();
    }, 150));
    $('#bookCollapseAll').addEventListener('change', function () {
      bkMode = 'card';
      $$('#bookEntries .entry-adv').forEach(function (d) { d.open = !$('#bookCollapseAll').checked; });
    });
    $('#tester-text').addEventListener('input', debounce(function () { bkMode = 'card'; renderTester(); }, 120));
    document.addEventListener('click', function (e) {
      var pk = document.getElementById('tplPicker');
      if (pk && !pk.contains(e.target) && e.target.id !== 'btnAddFromTpl' && e.target.id !== 'btnLibAddFromTpl') pk.remove();
    });
  }

  /* ================= 世界书库（非内嵌世界书） ================= */

  var saveLibBooks = debounce(function () {
    var b = activeLibBook();
    if (b) b.updatedAt = Date.now();
    var payload = { activeId: libBooks.activeId, items: libBooks.items };
    idbSet('libbooks', payload).catch(function () {
      try { localStorage.setItem('stCardMakerLibBooks_v1', JSON.stringify(payload)); } catch (e) { /* ignore */ }
    });
  }, 400);

  function loadLibBooks() {
    return idbGet('libbooks').catch(function () { return null; }).then(function (obj) {
      if (!obj) { try { obj = JSON.parse(localStorage.getItem('stCardMakerLibBooks_v1') || 'null'); } catch (e) { obj = null; } }
      if (!obj || !Array.isArray(obj.items)) return false;
      var items = [];
      obj.items.forEach(function (b) {
        try {
          items.push({
            id: b.id || newWorkId(),
            name: M.str(b.name),
            scan_depth: M.num(b.scan_depth, 2),
            token_budget: M.num(b.token_budget, 500),
            recursive_scanning: !!b.recursive_scanning,
            entries: (Array.isArray(b.entries) ? b.entries : []).map(M.normalizeEntry),
            extensions: b.extensions || {},
            raw: b.raw || {},
            updatedAt: b.updatedAt || Date.now()
          });
        } catch (e) { /* 跳过损坏条目 */ }
      });
      libBooks = { activeId: (items.filter(function (b) { return b.id === obj.activeId; })[0] || items[0] || {}).id || '', items: items };
      return items.length > 0;
    });
  }

  function renderLibList() {
    var wrap = $('#libList');
    wrap.innerHTML = '';
    if (!libBooks.items.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="es-icon">📕</div><div class="es-title">世界书库为空</div><div class="es-text">新建一本独立世界书，或导入酒馆原生世界书 JSON。</div></div>';
      $('#libHint').textContent = '';
      return;
    }
    libBooks.items.forEach(function (b) {
      var item = document.createElement('div');
      item.className = 'work-item' + (b.id === libBooks.activeId ? ' active' : '');
      var name = document.createElement('span');
      name.className = 'w-name';
      name.textContent = b.name || '未命名世界书';
      var meta = document.createElement('span');
      meta.className = 'w-meta';
      meta.textContent = b.entries.length + ' 条 · ' + shortTime(b.updatedAt);
      item.appendChild(name);
      item.appendChild(meta);
      item.addEventListener('click', function () { switchLib(b.id); });
      wrap.appendChild(item);
    });
    $('#libHint').textContent = '共 ' + libBooks.items.length + ' 本';
  }

  function switchLib(id) {
    if (id === libBooks.activeId) return;
    saveLibBooks();
    libBooks.activeId = id;
    bkMode = 'lib';
    resetBookView('lib');
    $('#libSearch').value = '';
    syncLibToForm();
    renderLibList();
    renderBookList();
    renderCatFilter();
    var b = activeLibBook();
    toast('已切换到「' + ((b && b.name) || '未命名世界书') + '」', 'ok');
  }

  function syncLibToForm() {
    var b = activeLibBook();
    if (!b) {
      $('#lib-name').value = '';
      $('#lib-scan').value = 2;
      $('#lib-budget').value = 500;
      $('#lib-recursive').checked = false;
      var prev0 = bkMode;
      bkMode = 'lib';
      renderBookStats();
      renderBookList();
      renderCatFilter();
      bkMode = prev0;
      return;
    }
    $('#lib-name').value = b.name || '';
    $('#lib-scan').value = b.scan_depth;
    $('#lib-budget').value = b.token_budget;
    $('#lib-recursive').checked = !!b.recursive_scanning;
    var prev = bkMode;
    bkMode = 'lib';
    renderBookStats();
    renderBookList();
    renderCatFilter();
    bkMode = prev;
  }

  function createLib(dup) {
    var b = dup && activeLibBook() ? M.cloneBook(activeLibBook()) : M.emptyBook();
    if (dup) b.name = (b.name || '未命名世界书') + '（副本）';
    var item = { id: newWorkId(), name: b.name || '未命名世界书', scan_depth: b.scan_depth, token_budget: b.token_budget, recursive_scanning: b.recursive_scanning, entries: b.entries, extensions: b.extensions, raw: b.raw, updatedAt: Date.now() };
    libBooks.items.push(item);
    libBooks.activeId = item.id;
    bkMode = 'lib';
    resetBookView('lib');
    $('#libSearch').value = '';
    syncLibToForm();
    renderLibList();
    renderBookList();
    renderCatFilter();
    saveLibBooks();
    setFormTab('tab-lib');
    toast(dup ? '已复制世界书' : '已新建世界书', 'ok');
  }

  function deleteLib() {
    var b = activeLibBook();
    if (!b) { toast('世界书库还是空的', 'err'); return; }
    if (!confirm('删除世界书「' + (b.name || '未命名世界书') + '」？共 ' + b.entries.length + ' 条，不可恢复。')) return;
    var idx = libBooks.items.indexOf(b);
    libBooks.items.splice(idx, 1);
    if (!libBooks.items.length) {
      var nb = M.emptyBook();
      libBooks.items.push({ id: newWorkId(), name: '未命名世界书', scan_depth: nb.scan_depth, token_budget: nb.token_budget, recursive_scanning: false, entries: nb.entries, extensions: {}, raw: {}, updatedAt: Date.now() });
    }
    libBooks.activeId = libBooks.items[Math.max(0, idx - 1)].id;
    bkMode = 'lib';
    syncLibToForm();
    renderLibList();
    renderBookList();
    renderCatFilter();
    saveLibBooks();
    toast('世界书已删除', 'ok');
  }

  function bindLib() {
    $('#btnNewLib').addEventListener('click', function () { createLib(false); });
    $('#btnDupLib').addEventListener('click', function () { createLib(true); });
    $('#btnDelLib').addEventListener('click', deleteLib);
    $('#btnLibExport').addEventListener('click', function () { bkMode = 'lib'; exportCurrentBook(); });
    $('#btnLibImport').addEventListener('click', function () { bkMode = 'lib'; $('#libFile').click(); });
    $('#libFile').addEventListener('change', async function () {
      bkMode = 'lib';
      if (!this.files || !this.files[0]) return;
      try {
        var o = JSON.parse(await this.files[0].text());
        var parsed = M.parseNativeBook(o);
        if (!parsed) throw new Error('未找到世界书条目');
        importNativeBookIntoCurrent(parsed);
      } catch (e) { toast('导入失败：' + e.message, 'err', 5200); }
      this.value = '';
    });
    $('#lib-name').addEventListener('input', function () {
      var b = activeLibBook();
      if (b) { b.name = this.value; renderLibList(); saveLibBooks(); }
    });
    $('#lib-scan').addEventListener('input', function () {
      var b = activeLibBook();
      if (b) { b.scan_depth = M.num(this.value, 2); saveLibBooks(); }
    });
    $('#lib-budget').addEventListener('input', function () {
      var b = activeLibBook();
      if (b) { b.token_budget = M.num(this.value, 500); saveLibBooks(); }
    });
    $('#lib-recursive').addEventListener('change', function () {
      var b = activeLibBook();
      if (b) { b.recursive_scanning = this.checked; saveLibBooks(); }
    });
    $('#btnLibAddEntry').addEventListener('click', function () { bkMode = 'lib'; addEntry($('#libNewCat').value, '新条目', ''); });
    $('#btnLibAddFromTpl').addEventListener('click', function () { bkMode = 'lib'; openTemplatePicker(); });
    $('#libSearch').addEventListener('input', debounce(function () {
      bkMode = 'lib';
      bv().query = this.value.trim().toLowerCase();
      bv().limit = BOOK_PAGE;
      renderBookList();
    }, 150));
    $('#libCollapseAll').addEventListener('change', function () {
      bkMode = 'lib';
      $$('#libEntries .entry-adv').forEach(function (d) { d.open = !$('#libCollapseAll').checked; });
    });
    $('#libTesterText').addEventListener('input', debounce(function () { bkMode = 'lib'; renderTester(); }, 120));

    // 与卡内世界书互转
    $('#btnLibToCard').addEventListener('click', function () {
      var b = activeLibBook();
      if (!b || !b.entries.length) { toast('当前世界书是空的', 'err'); return; }
      if (card.character_book.entries.length && !confirm('当前作品的卡内世界书已有 ' + card.character_book.entries.length + ' 条，设为「' + (b.name || '未命名') + '」会覆盖，继续？')) return;
      card.character_book = M.normalizeBook({
        name: b.name, scan_depth: b.scan_depth, token_budget: b.token_budget,
        recursive_scanning: b.recursive_scanning, entries: b.entries.map(function (e) { return M.entryToCharBook(e); })
      });
      bkMode = 'card';   // 必须切回卡内模式，否则渲染会写进世界书库容器
      syncFieldsToForm();
      renderBookList(); renderCatFilter();
      touch();
      setFormTab('tab-book');
      toast('已设为卡内世界书：' + b.entries.length + ' 条', 'ok', 4200);
    });
    $('#btnCardToLib').addEventListener('click', function () {
      var bk = card.character_book;
      if (!bk.entries.length) { toast('当前作品的卡内世界书是空的', 'err'); return; }
      var item = {
        id: newWorkId(), name: bk.name || (card.name + ' 世界书') || '未命名世界书',
        scan_depth: bk.scan_depth, token_budget: bk.token_budget, recursive_scanning: bk.recursive_scanning,
        entries: bk.entries.map(function (e) { return M.entryToCharBook(e); }),
        extensions: {}, raw: {}, updatedAt: Date.now()
      };
      libBooks.items.push(item);
      libBooks.activeId = item.id;
      bkMode = 'lib';
      saveLibBooks();
      renderLibList();
      syncLibToForm();
      renderBookList();
      renderCatFilter();
      setFormTab('tab-lib');
      toast('已存入世界书库：' + item.name + '（' + item.entries.length + ' 条）', 'ok', 4200);
    });
  }

  /* ================= 条例 ================= */

  function renderRules() {
    var wrap = $('#rulesList');
    var rules = card.rules || [];
    var badge = document.getElementById('badge-rules');
    if (badge) { badge.textContent = rules.filter(function (r) { return r.enabled; }).length; badge.setAttribute('data-zero', rules.length ? '0' : '1'); }
    wrap.innerHTML = '';
    if (!rules.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="es-icon">📜</div><div class="es-title">还没有条例</div><div class="es-text">条例是约束模型输出的规则，会追加到指定字段末尾。可从内置条例库添加，也可以自己写。</div></div>';
      return;
    }
    rules.forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'rule-item' + (r.enabled ? '' : ' is-off');
      var enable = document.createElement('label');
      enable.className = 'checkbox-field';
      enable.innerHTML = '<input type="checkbox"><span>启用</span>';
      var cb = enable.querySelector('input');
      cb.checked = r.enabled;
      cb.addEventListener('change', function () { r.enabled = cb.checked; item.classList.toggle('is-off', !r.enabled); touch(); });
      item.appendChild(enable);

      var main = document.createElement('div');
      main.className = 'rule-main';
      var title = document.createElement('div');
      title.className = 'rule-title';
      title.textContent = r.title;
      var body = document.createElement('div');
      body.className = 'rule-body';
      body.textContent = r.body;
      main.appendChild(title);
      main.appendChild(body);
      item.appendChild(main);

      var tgt = document.createElement('span');
      tgt.className = 'rule-target';
      tgt.textContent = '→ ' + (M.RULE_TARGETS.filter(function (t) { return t.v === r.target; })[0] || { t: r.target }).t;
      item.appendChild(tgt);

      item.appendChild(iconBtn('✎', '编辑', function () { openRuleEditor(r); }));
      item.appendChild(iconBtn('✕', '删除', function () {
        if (!confirm('删除条例「' + r.title + '」？')) return;
        card.rules = card.rules.filter(function (x) { return x.id !== r.id; });
        renderRules(); touch();
      }, 'danger'));
      wrap.appendChild(item);
    });
  }

  function renderRuleLibrary() {
    var box = $('#ruleLib');
    box.innerHTML = '';
    box.hidden = true;
  }

  function toggleRuleLibrary() {
    var box = $('#ruleLib');
    if (!box.hidden) { box.hidden = true; return; }
    box.innerHTML = '';
    var used = {};
    (card.rules || []).forEach(function (r) { if (r.key) used[r.key] = true; });
    M.RULE_LIBRARY.forEach(function (lib) {
      var b = document.createElement('button');
      b.className = 'btn small rule-lib-btn';
      b.disabled = !!used[lib.key];
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = used[lib.key] ? lib.title + '（已添加）' : lib.title;
      b.querySelector('span').textContent = '→ ' + (M.RULE_TARGETS.filter(function (t) { return t.v === lib.target; })[0] || {}).t;
      b.title = lib.body;
      b.addEventListener('click', function () {
        var r = M.libraryRule(lib.key);
        card.rules.push(r);
        renderRules();
        touch();
        toast('已添加条例「' + lib.title + '」', 'ok');
        toggleRuleLibrary();
      });
      box.appendChild(b);
    });
    box.hidden = false;
  }

  function openRuleEditor(rule) {
    editingRuleId = rule ? rule.id : null;
    $('#ruleEditor').hidden = false;
    $('#rule-title').value = rule ? rule.title : '';
    $('#rule-body').value = rule ? rule.body : '';
    $('#rule-target').value = rule ? rule.target : 'description';
    $('#rule-title').focus();
    $('#ruleEditor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function closeRuleEditor() {
    editingRuleId = null;
    $('#ruleEditor').hidden = true;
  }

  function saveRuleFromEditor() {
    var title = $('#rule-title').value.trim();
    var body = $('#rule-body').value.trim();
    var target = $('#rule-target').value;
    if (!title) { toast('请先填写条例标题', 'err'); return; }
    if (!body) { toast('请先填写条例内容', 'err'); return; }
    if (editingRuleId) {
      var r = (card.rules || []).filter(function (x) { return x.id === editingRuleId; })[0];
      if (r) { r.title = title; r.body = body; r.target = target; }
      toast('条例已更新', 'ok');
    } else {
      card.rules.push(M.newRule(title, body, target));
      toast('条例已添加', 'ok');
    }
    closeRuleEditor();
    renderRules();
    touch();
  }

  function bindRules() {
    $('#btnAddRule').addEventListener('click', function () { openRuleEditor(null); });
    $('#btnRuleLib').addEventListener('click', toggleRuleLibrary);
    $('#rule-save').addEventListener('click', saveRuleFromEditor);
    $('#rule-cancel').addEventListener('click', closeRuleEditor);
    renderRuleLibrary();
  }

  /* ================= 文风基调 ================= */

  function fillSelect(sel, options, value) {
    sel.innerHTML = '';
    options.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o; op.textContent = o;
      sel.appendChild(op);
    });
    if (options.indexOf(value) !== -1) sel.value = value;
  }

  function renderTonePresets() {
    var wrap = $('#tonePresets');
    wrap.innerHTML = '';
    M.TONE_PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tone-chip' + (card.tone.presets.indexOf(p.id) !== -1 ? ' active' : '');
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = p.t;
      b.querySelector('span').textContent = p.d;
      b.addEventListener('click', function () {
        var idx = card.tone.presets.indexOf(p.id);
        if (idx === -1) card.tone.presets.push(p.id); else card.tone.presets.splice(idx, 1);
        renderTonePresets();
        touch();
      });
      wrap.appendChild(b);
    });
  }

  function syncToneToForm() {
    renderTonePresets();
    fillSelect($('#tone-person'), M.TONE_OPTIONS.person, card.tone.person);
    fillSelect($('#tone-tense'), M.TONE_OPTIONS.tense, card.tone.tense);
    fillSelect($('#tone-length'), M.TONE_OPTIONS.length, card.tone.length);
    fillSelect($('#tone-dialogue'), M.TONE_OPTIONS.dialogue, card.tone.dialogue);
    fillSelect($('#tone-pace'), M.TONE_OPTIONS.pace, card.tone.pace);
    $('#tone-custom').value = card.tone.custom || '';
    $('#tonePreviewHint').textContent = '预览：' + M.toneText(card.tone).split('\n')[0];
  }

  function bindTone() {
    $('#tone-person').addEventListener('change', function () { card.tone.person = this.value; touch(); });
    $('#tone-tense').addEventListener('change', function () { card.tone.tense = this.value; touch(); });
    $('#tone-length').addEventListener('change', function () { card.tone.length = this.value; touch(); });
    $('#tone-dialogue').addEventListener('change', function () { card.tone.dialogue = this.value; touch(); });
    $('#tone-pace').addEventListener('change', function () { card.tone.pace = this.value; touch(); });
    $('#tone-custom').addEventListener('input', function () { card.tone.custom = this.value; touch(); });
    $('#btnToneApply').addEventListener('click', function () {
      card.personality = M.toneText(card.tone);
      syncFieldsToForm();
      touch();
      toast('文风基调已生成到「叙事基调」，可继续手改', 'ok', 3600);
    });
  }

  /* ================= 统一前端（世界面板） ================= */

  function uiTplOptions() {
    var sel = $('#ui-template');
    sel.innerHTML = '';
    M.UI_TEMPLATES.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.t + ' — ' + t.d;
      sel.appendChild(o);
    });
    var th = $('#ui-theme');
    th.innerHTML = '';
    M.UI_THEMES.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.id; o.textContent = t.t;
      th.appendChild(o);
    });
  }

  function renderUiEditor() {
    var has = !!card.ui;
    $('#uiEmpty').hidden = has;
    $('#uiEditor').hidden = !has;
    if (!has) { $('#uiHtmlOut').textContent = ''; return; }
    var ui = card.ui;
    $('#ui-template').value = ui.template;
    $('#ui-theme').value = ui.theme;
    $('#ui-title').value = ui.title || '';
    $('#ui-subtitle').value = ui.subtitle || '';
    $('#ui-layout').value = ui.layout;
    $('#ui-displayOnly').checked = ui.displayOnly !== false;
    $('#ui-inGreetings').checked = !!ui.inGreetings;
    ['from', 'to', 'border', 'text', 'accent'].forEach(function (k) {
      $('#ui-c-' + k).value = /^#[0-9a-f]{6}$/i.test(ui.colors[k]) ? ui.colors[k] : '#000000';
    });
    // 按模板显示对应编辑区
    var isStatus = ui.template === 'status' || ui.template === 'minimal';
    var isOpening = ui.template === 'opening';
    var isWorld = ui.template === 'world';
    $('#ui-fields-wrap').hidden = !isStatus;
    $('#ui-options-wrap').hidden = !isOpening;
    $('#ui-sections-wrap').hidden = !isWorld;
    $('#ui-layout-wrap').style.display = ui.template === 'status' ? '' : 'none';
    $('#ui-subtitle-wrap').style.display = isOpening ? '' : 'none';

    if (isStatus) renderUiFields();
    if (isOpening) $('#ui-options').value = ui.options.join('\n');
    if (isWorld) renderUiSections();
    $('#uiHtmlOut').textContent = M.uiReplaceString(ui);
  }

  function renderUiFields() {
    var wrap = $('#uiFields');
    wrap.innerHTML = '';
    card.ui.fields.forEach(function (f, i) {
      var row = document.createElement('div');
      row.className = 'ui-row';
      var ic = document.createElement('input');
      ic.type = 'text'; ic.className = 'ui-ic'; ic.placeholder = '图标'; ic.value = f.icon; ic.title = '图标';
      ic.addEventListener('input', function () { card.ui.fields[i].icon = this.value; });
      var lb = document.createElement('input');
      lb.type = 'text'; lb.className = 'ui-lb'; lb.placeholder = '标签'; lb.value = f.label; lb.title = '标签';
      lb.addEventListener('input', function () { card.ui.fields[i].label = this.value; });
      var vl = document.createElement('input');
      vl.type = 'text'; vl.className = 'ui-vl'; vl.placeholder = '内容，可用宏'; vl.value = f.value; vl.title = '内容';
      vl.addEventListener('input', function () { card.ui.fields[i].value = this.value; });
      var del = iconBtn('✕', '删除字段', function () { card.ui.fields.splice(i, 1); renderUiFields(); }, 'danger');
      row.appendChild(ic); row.appendChild(lb); row.appendChild(vl); row.appendChild(del);
      wrap.appendChild(row);
    });
  }

  function renderUiSections() {
    var wrap = $('#uiSections');
    wrap.innerHTML = '';
    card.ui.sections.forEach(function (s, i) {
      var box = document.createElement('div');
      box.className = 'ui-section';
      var head = document.createElement('div');
      head.className = 'entry-head';
      var t = document.createElement('input');
      t.type = 'text'; t.className = 'e-title'; t.placeholder = '区块标题'; t.value = s.title;
      t.addEventListener('input', function () { card.ui.sections[i].title = this.value; });
      head.appendChild(t);
      head.appendChild(iconBtn('↑', '上移', function () { if (i > 0) { swap(card.ui.sections, i, i - 1); renderUiSections(); } }));
      head.appendChild(iconBtn('↓', '下移', function () { if (i < card.ui.sections.length - 1) { swap(card.ui.sections, i, i + 1); renderUiSections(); } }));
      head.appendChild(iconBtn('✕', '删除区块', function () { card.ui.sections.splice(i, 1); renderUiSections(); }, 'danger'));
      box.appendChild(head);
      var ta = document.createElement('textarea');
      ta.rows = 3;
      ta.placeholder = '每行一条内容';
      ta.value = s.lines.join('\n');
      ta.addEventListener('input', function () { card.ui.sections[i].lines = this.value.split('\n'); });
      box.appendChild(ta);
      wrap.appendChild(box);
    });
  }

  // 读取表单 → card.ui（颜色以输入框为准，无效则回落到主题色）
  function readUiForm() {
    if (!card.ui) return;
    var ui = card.ui;
    ui.template = $('#ui-template').value;
    ui.theme = $('#ui-theme').value;
    var theme = M.uiTheme(ui.theme).c;
    ['from', 'to', 'border', 'text', 'accent'].forEach(function (k) {
      var v = $('#ui-c-' + k).value;
      ui.colors[k] = (/^#[0-9a-f]{6}$/i.test(v) && v !== '#000000') ? v : theme[k];
    });
    ui.title = $('#ui-title').value;
    ui.subtitle = $('#ui-subtitle').value;
    ui.layout = $('#ui-layout').value;
    ui.displayOnly = $('#ui-displayOnly').checked;
    ui.inGreetings = $('#ui-inGreetings').checked;
    if (ui.template === 'opening') {
      ui.options = $('#ui-options').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    }
  }

  function applyUi() {
    if (!card.ui) return;
    readUiForm();
    M.syncUi(card);
    var inserted = M.ensureUiPlaceholder(card);
    syncFieldsToForm();
    renderRegex();
    renderGreetings();
    renderUiEditor();
    touch();
    $('#uiHint').textContent = '已应用：占位符' + (inserted ? '已插入开局' : '已在开局中') + '，正则已更新';
    toast('前端已应用到卡片：占位符 + 渲染正则均已更新', 'ok', 4200);
  }

  function removeUi() {
    if (!card.ui) return;
    if (!confirm('移除前端？将删除占位符与对应的渲染正则（不影响你的其他正则）。')) return;
    card.ui = null;
    card.extensions.regex_scripts = card.extensions.regex_scripts.filter(function (s) { return s.id !== M.UI_REGEX_ID; });
    card.first_mes = card.first_mes.split(M.UI_PLACEHOLDER).join('').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    card.alternate_greetings = card.alternate_greetings.map(function (g) {
      return g.split(M.UI_PLACEHOLDER).join('').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    });
    syncFieldsToForm();
    renderRegex();
    renderGreetings();
    renderUiEditor();
    touch();
    toast('前端已移除', 'ok');
  }

  function bindUi() {
    uiTplOptions();
    var startSel = $('#uiStartTpl');
    startSel.innerHTML = '';
    M.UI_TEMPLATES.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.id; o.textContent = t.t;
      startSel.appendChild(o);
    });
    startSel.value = 'status';
    $('#btnUiStart').addEventListener('click', function () {
      card.ui = M.normalizeUi(M.defaultUi(startSel.value));
      M.syncUi(card);
      M.ensureUiPlaceholder(card);
      syncFieldsToForm();
      renderRegex();
      renderUiEditor();
      touch();
      toast('前端已创建：占位符已插入主开局，渲染正则已生成', 'ok', 4200);
    });
    $('#uiApply').addEventListener('click', applyUi);
    $('#uiRemove').addEventListener('click', removeUi);
    $('#uiAddField').addEventListener('click', function () {
      card.ui.fields.push({ icon: '🔹', label: '新字段', value: '（内容）' });
      renderUiFields();
    });
    $('#uiAddSection').addEventListener('click', function () {
      card.ui.sections.push({ title: '新区块', lines: ['（内容）'] });
      renderUiSections();
    });
    $('#ui-template').addEventListener('change', function () {
      // 换模板：保留配色，其余用新模板默认值（含「是否仅显示」的推荐值）
      var keep = { colors: card.ui.colors, inGreetings: card.ui.inGreetings };
      card.ui = M.normalizeUi(Object.assign({}, M.defaultUi(this.value), keep));
      renderUiEditor();
    });
    $('#ui-theme').addEventListener('change', function () {
      var c = M.uiTheme(this.value).c;
      ['from', 'to', 'border', 'text', 'accent'].forEach(function (k) { card.ui.colors[k] = c[k]; $('#ui-c-' + k).value = c[k]; });
      $('#uiHtmlOut').textContent = M.uiReplaceString(card.ui);
    });
    $('#uiPreview').addEventListener('click', function () {
      readUiForm();
      document.querySelector('[data-tab="tab-preview"]').click();
      renderChatPreview();
      $('#uiHint').textContent = '已生成 HTML，右侧「预览」页签可查看效果';
    });
    ['from', 'to', 'border', 'text', 'accent'].forEach(function (k) {
      $('#ui-c-' + k).addEventListener('input', function () {
        if (!card.ui) return;
        if (/^#[0-9a-f]{6}$/i.test(this.value) && this.value !== '#000000') card.ui.colors[k] = this.value;
        $('#uiHtmlOut').textContent = M.uiReplaceString(card.ui);
      });
    });
    $('#ui-title').addEventListener('input', function () { if (card.ui) $('#uiHtmlOut').textContent = M.uiReplaceString(card.ui); });
  }

  /* ================= 原生扩展 ================= */

  // 助手脚本（tavern_helper）：结构化编辑，保留原始形态与未知字段
  // 助手脚本列表缓存：界面事件直接修改这些对象，
  // 若每次保存都重新从 extensions 归一化，用户的编辑会被旧值覆盖
  var helperCache = null;
  function helperList() {
    if (!helperCache) helperCache = M.helperScripts(card.extensions);
    return helperCache;
  }
  function invalidateHelper() { helperCache = null; }

  function renderHelper() {
    var wrap = $('#helperList');
    var list = helperList();
    var badge = document.getElementById('badge-helper');
    if (badge) { badge.textContent = list.length; badge.setAttribute('data-zero', list.length ? '0' : '1'); }
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="es-icon">🧪</div><div class="es-title">还没有助手脚本</div><div class="es-text">变量表、开局面板、EJS 注入都靠它。可从模板起步，或粘贴已有的脚本内容。</div></div>';
      return;
    }
    list.forEach(function (s, i) {
      var box = document.createElement('div');
      box.className = 'entry' + (s.enabled ? '' : ' is-off');
      var head = document.createElement('div');
      head.className = 'entry-head';
      var num = document.createElement('span');
      num.className = 'e-num';
      num.textContent = '#' + (i + 1);
      head.appendChild(num);

      var name = document.createElement('input');
      name.type = 'text';
      name.className = 'e-title';
      name.placeholder = '脚本名称，如：变量表';
      name.value = s.name;
      name.addEventListener('input', function () { s.name = this.value; saveHelper(); });
      head.appendChild(name);

      var type = document.createElement('select');
      type.className = 'e-cat';
      type.title = '脚本类型';
      ['script', 'event', 'mvu'].forEach(function (t) {
        var o = document.createElement('option');
        o.value = t; o.textContent = t;
        type.appendChild(o);
      });
      type.value = s.type || 'script';
      type.addEventListener('change', function () { s.type = this.value; saveHelper(); });
      head.appendChild(type);

      head.appendChild(checkField('启用', s.enabled, function (v) { s.enabled = v; box.classList.toggle('is-off', !v); saveHelper(); }));
      head.appendChild(iconBtn('↑', '上移', function () { moveHelper(i, -1); }));
      head.appendChild(iconBtn('↓', '下移', function () { moveHelper(i, 1); }));
      head.appendChild(iconBtn('⎘', '复制', function () {
        var copy = M.normalizeHelperScript(Object.assign({}, M.clone(s)));
        copy.id = 'hs' + Date.now().toString(36);
        var l = helperList();
        l.splice(i + 1, 0, copy);
        commitHelper(l);
        toast('已复制脚本', 'ok');
      }));
      head.appendChild(iconBtn('✕', '删除', function () {
        if (!confirm('删除脚本「' + (s.name || '未命名') + '」？')) return;
        var l = helperList();
        l.splice(i, 1);
        commitHelper(l);
      }, 'danger'));
      box.appendChild(head);

      var body = document.createElement('label');
      body.className = 'field';
      body.innerHTML = '<span class="label">脚本内容 content（JavaScript）</span>';
      var ta = document.createElement('textarea');
      ta.rows = 10;
      ta.className = 'mono';
      ta.spellcheck = false;
      ta.value = s.content;
      bindAutoGrow(ta, 420);
      ta.addEventListener('input', function () { s.content = this.value; saveHelper(); });
      body.appendChild(ta);
      box.appendChild(body);

      var extraKeys = Object.keys(s.extra || {});
      if (extraKeys.length) {
        var note = document.createElement('p');
        note.className = 'kept-note';
        note.textContent = '已保留其他字段：' + extraKeys.join('、');
        box.appendChild(note);
      }
      wrap.appendChild(box);
    });
  }

  // 防抖保存（仅更新 DOM 统计，不整页重绘，避免打断输入）
  var saveHelper = debounce(function () {
    var list = helperList();
    M.setHelperScripts(card.extensions, list);
    var badge = document.getElementById('badge-helper');
    if (badge) { badge.textContent = list.length; badge.setAttribute('data-zero', list.length ? '0' : '1'); }
    touch();
  }, 400);

  function commitHelper(list) {
    helperCache = list;
    M.setHelperScripts(card.extensions, list);
    renderHelper();
    touch();
  }

  function moveHelper(i, dir) {
    var l = M.helperScripts(card.extensions);
    var j = i + dir;
    if (j < 0 || j >= l.length) return;
    var t = l[i]; l[i] = l[j]; l[j] = t;
    commitHelper(l);
  }

  var HELPER_TEMPLATES = [
    {
      name: 'MVU 变量表（Zod）',
      body: "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\n\nconst schema = z.object({\n  时间: z.string().prefault(''),\n  地点: z.string().prefault(''),\n  局势: z.string().prefault('')\n});\n\n$('body').on('mvu:ready', () => {\n  registerMvuSchema(schema);\n});"
    },
    {
      name: '开局面板（HTML 注入）',
      body: "$('body').on('click', '#start-btn', () => {\n  // 在这里响应开局界面按钮，向酒馆发送消息\n  // triggerSlash('/send 我选择 A');\n});"
    },
    {
      name: 'EJS 动态条目',
      body: "<%_\n// 在世界书条目内容中使用：按当前变量输出不同文本\nvar v = getvariables('stat_data') || {};\n_%>\n<%_ if (v.已开局) { _%>\n（当前局势：<%= v.局势 %>）\n<%_ } else { _%>\n（尚未开局）\n<%_ } _%>"
    },
    {
      name: '空脚本（自行填写）',
      body: ''
    }
  ];

  function renderHelperTemplates() {
    var box = $('#helperTplBox');
    if (!box.hidden) { box.hidden = true; return; }
    box.innerHTML = '';
    HELPER_TEMPLATES.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'btn small rule-lib-btn';
      b.innerHTML = '<b></b>';
      b.querySelector('b').textContent = t.name;
      b.addEventListener('click', function () {
        var l = M.helperScripts(card.extensions);
        l.push(M.normalizeHelperScript({ name: t.name, content: t.body, type: 'script', enabled: true }));
        commitHelper(l);
        box.hidden = true;
        toast('已添加脚本「' + t.name + '」', 'ok');
      });
      box.appendChild(b);
    });
    box.hidden = false;
  }

  function bindHelper() {
    $('#btnAddHelper').addEventListener('click', function () {
      var l = M.helperScripts(card.extensions);
      l.push(M.normalizeHelperScript({ name: '新脚本', content: '', type: 'script', enabled: true }));
      commitHelper(l);
    });
    $('#btnHelperTpl').addEventListener('click', renderHelperTemplates);
  }

  function syncRawExtrasToForm() {
    var ta = $('#rawExtras');
    var raw = M.rawExtras(card.extensions);
    var keys = Object.keys(raw);
    ta.value = keys.length ? JSON.stringify(raw, null, 2) : '';
    ta.placeholder = keys.length ? '' : '（当前没有其他扩展键，可粘贴 JSON 添加，例如 {"tavern_helper": {...}}）';
  }

  function saveRawExtras() {
    var text = $('#rawExtras').value.trim();
    if (!text) {
      M.applyRawExtras(card, {});
      $('#extrasHint').textContent = '已清空其他扩展键';
      syncRawExtrasToForm();
      touch();
      return;
    }
    var obj;
    try { obj = JSON.parse(text); } catch (e) {
      toast('不是合法的 JSON：' + e.message, 'err', 5000);
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      toast('扩展必须是 JSON 对象（{...}）', 'err');
      return;
    }
    M.applyRawExtras(card, obj);
    syncRawExtrasToForm();
    touch();
    $('#extrasHint').textContent = '已保存 ' + Object.keys(obj).length + ' 个扩展键';
    toast('扩展已保存，导入的键会原样写回', 'ok', 3600);
  }

  /* ================= 开局 ================= */

  function swap(arr, a, b) { var t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

  function renderGreetList(list, wrapSel, placeholder, emptyHint, badgeId) {
    var wrap = $(wrapSel);
    wrap.innerHTML = '';
    if (badgeId) {
      var b = document.getElementById(badgeId);
      if (b) { b.textContent = list.length; b.setAttribute('data-zero', list.length ? '0' : '1'); }
    }
    if (!list.length) {
      wrap.innerHTML = '<p class="hint" style="margin:2px 0 10px">' + emptyHint + '</p>';
      return;
    }
    list.forEach(function (g, i) {
      var div = document.createElement('div');
      div.className = 'greet-item';
      var idx = document.createElement('span');
      idx.className = 'e-num';
      idx.textContent = '#' + (i + 1);
      var ta = document.createElement('textarea');
      ta.rows = 4;
      ta.placeholder = placeholder + ' ' + (i + 1);
      ta.value = g;
      bindAutoGrow(ta, 220);
      ta.addEventListener('input', function () { list[i] = this.value; touch(); });
      var btns = document.createElement('div');
      btns.className = 'greet-btns';
      btns.appendChild(iconBtn('↑', '上移', function () { if (i > 0) { swap(list, i, i - 1); renderGreetings(); touch(); } }));
      btns.appendChild(iconBtn('↓', '下移', function () { if (i < list.length - 1) { swap(list, i, i + 1); renderGreetings(); touch(); } }));
      btns.appendChild(iconBtn('✕', '删除', function () { list.splice(i, 1); renderGreetings(); touch(); }, 'danger'));
      div.appendChild(idx);
      div.appendChild(ta);
      div.appendChild(btns);
      wrap.appendChild(div);
    });
  }

  function renderGreetings() {
    renderGreetList(card.alternate_greetings, '#greetingsList', '备用开局', '（暂无。备用开局让玩家在不同故事入口之间切换。）', 'badge-greet');
    renderGreetList(card.group_only_greetings, '#groupGreetingsList', '群聊开局', '（暂无。群聊开局只在群聊中作为可选开场出现。）', null);
  }

  /* ================= 正则 ================= */

  function renderRegex() {
    var wrap = $('#regexScripts');
    var list = card.extensions.regex_scripts;
    var b = $('#badge-regex');
    b.textContent = list.length;
    b.setAttribute('data-zero', list.length ? '0' : '1');
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="es-icon">🖥</div><div class="es-title">还没有正则脚本</div><div class="es-text">正则可以隐藏标签、把状态栏渲染成好看的样式。见下方模板。</div></div>';
      return;
    }
    list.forEach(function (s, i) { wrap.appendChild(buildRegexEl(s, i)); });
  }

  function buildRegexEl(s, i) {
    var box = document.createElement('div');
    box.className = 'entry' + (s.disabled ? ' is-off' : '');
    var head = document.createElement('div');
    head.className = 'entry-head';
    var num = document.createElement('span');
    num.className = 'e-num';
    num.textContent = '#' + (i + 1);
    head.appendChild(num);
    var name = document.createElement('input');
    name.type = 'text';
    name.className = 'e-title';
    name.placeholder = '脚本名称，如：隐藏状态栏标签';
    name.value = s.scriptName;
    name.addEventListener('input', function () { s.scriptName = this.value; touch(); });
    head.appendChild(name);
    head.appendChild(checkField('启用', !s.disabled, function (v) { s.disabled = !v; box.classList.toggle('is-off', s.disabled); touch(); }));
    head.appendChild(iconBtn('↑', '上移', function () { moveRegex(i, -1); }));
    head.appendChild(iconBtn('↓', '下移', function () { moveRegex(i, 1); }));
    head.appendChild(iconBtn('✕', '删除', function () { card.extensions.regex_scripts.splice(i, 1); renderRegex(); touch(); }, 'danger'));
    box.appendChild(head);

    var find = textField('查找 findRegex（如 /<tag>[\\s\\S]*?<\\/tag>/gi）', s.findRegex, function (v) { s.findRegex = v; touch(); });
    find.classList.add('mono');
    box.appendChild(find);
    var rep = document.createElement('label');
    rep.className = 'field';
    rep.innerHTML = '<span class="label">替换 replaceString（支持 $1 捕获组，留空即删除匹配内容）</span>';
    var ta = document.createElement('textarea');
    ta.rows = 3;
    ta.className = 'mono';
    ta.value = s.replaceString;
    ta.addEventListener('input', function () { s.replaceString = this.value; touch(); });
    rep.appendChild(ta);
    box.appendChild(rep);

    box.appendChild(grid('grid4 flags', [
      checkField('作用于用户输入 (1)', s.placement.indexOf(1) !== -1, function (v) { setPlacement(s, 1, v); }),
      checkField('作用于 AI 输出 (2)', s.placement.indexOf(2) !== -1, function (v) { setPlacement(s, 2, v); }),
      checkField('仅影响显示 markdownOnly', s.markdownOnly, function (v) { s.markdownOnly = v; touch(); }),
      checkField('仅影响提示词 promptOnly', s.promptOnly, function (v) { s.promptOnly = v; touch(); }),
      checkField('编辑时运行 runOnEdit', s.runOnEdit, function (v) { s.runOnEdit = v; touch(); })
    ]));
    var others = s.placement.filter(function (p) { return p !== 1 && p !== 2; });
    if (others.length) {
      var note = document.createElement('p');
      note.className = 'kept-note';
      note.textContent = '已保留其他 placement：' + others.join('、') + '（酒馆内部值，原样写回）';
      box.appendChild(note);
    }
    return box;
  }

  function setPlacement(s, n, on) {
    var set = s.placement.filter(function (x) { return x !== n; });
    if (on) set.push(n);
    set.sort(function (a, b) { return a - b; });
    s.placement = set.length ? set : [2];
    touch();
  }
  function moveRegex(i, dir) {
    var arr = card.extensions.regex_scripts;
    var j = i + dir;
    if (j < 0 || j >= arr.length) return;
    swap(arr, i, j);
    renderRegex(); touch();
  }

  /* ================= 粘贴智能解析 ================= */

  var pasteResult = null;
  var FIELD_NAMES = {
    name: '作品/世界名', description: '世界总纲', personality: '叙事基调', scenario: '世界当前情况',
    first_mes: '主开局', mes_example: '叙事示例', creator_notes: '作者备注',
    system_prompt: '系统提示', post_history_instructions: '历史后指令', creator: '作者',
    character_version: '版本号', tags: '标签'
  };

  function openPasteModal() {
    $('#pasteModal').hidden = false;
    refreshAutoGrow("#pasteModal");
    renderPasteResult(null);
    setTimeout(function () { $('#pasteText').focus(); }, 50);
  }
  function closePasteModal() {
    $('#pasteModal').hidden = true;
    pasteResult = null;
    $('#btnPasteApply').disabled = true;
  }

  function runPasteParse() {
    var text = $('#pasteText').value;
    if (!text.trim()) { toast('请先粘贴文本', 'err'); return; }
    var r = M.parsePastedText(text, { splitLong: $('#pasteSplitLong').checked });
    pasteResult = r.ok ? r : null;
    renderPasteResult(r);
    $('#btnPasteApply').disabled = !r.ok;
    $('#pasteHint').textContent = r.ok ? ('识别类型：' + r.kind) : '';
  }

  function renderPasteResult(r) {
    var box = $('#pasteResult');
    box.innerHTML = '';
    if (!r) return;
    if (!r.ok) {
      box.innerHTML = '<div class="empty-state"><div class="es-icon">🧩</div><div class="es-title">无法解析</div><div class="es-text">' + M.str(r.error) + '。请带上 【标签】、“标签：”、# 标题 等标记再试。</div></div>';
      return;
    }
    // JSON 直接导入：没有 fields/entries 结构，单独提示
    if (r.kind === 'json') {
      var jc = r.card && (r.card.data || r.card);
      var jn = document.createElement('div');
      jn.className = 'paste-sum';
      var c1 = document.createElement('span'); c1.className = 'chip ok';
      c1.textContent = 'JSON 角色卡';
      var c2 = document.createElement('span'); c2.className = 'chip ok';
      c2.textContent = '作品：' + (M.str(jc && jc.name) || '未命名');
      jn.appendChild(c1); jn.appendChild(c2);
      box.appendChild(jn);
      var jp = document.createElement('p'); jp.className = 'tip';
      jp.textContent = '将直接按 JSON 导入逻辑读取（支持 V1 / V2 / V3），不会覆盖已有字段以外的其他内容。';
      box.appendChild(jp);
      return;
    }
    if (r.kind === 'book' && r.nativeBook) {
      var bn = document.createElement('div');
      bn.className = 'paste-sum';
      var b1 = document.createElement('span'); b1.className = 'chip ok'; b1.textContent = 'JSON 世界书';
      var b2 = document.createElement('span'); b2.className = 'chip ok'; b2.textContent = r.nativeBook.entries.length + ' 条条目';
      bn.appendChild(b1); bn.appendChild(b2);
      box.appendChild(bn);
      var bp = document.createElement('p'); bp.className = 'tip';
      bp.textContent = '将导入到世界书库（非内嵌），你可以再把它设为某个作品的卡内世界书。';
      box.appendChild(bp);
      return;
    }
    // 概览
    var sum = document.createElement('div');
    sum.className = 'paste-sum';
    var f = r.fields || {};
    var cardKeys = Object.keys(f).filter(function (k) { return k !== "__greetings" && M.str(f[k]).trim(); });
    var chip = function (cls, txt) { var s = document.createElement('span'); s.className = 'chip ' + cls; s.textContent = txt; sum.appendChild(s); };
    chip('ok', '卡片字段 ' + cardKeys.length);
    if ((f.__greetings || []).length) chip('ok', '备用开局 ' + f.__greetings.length);
    chip((r.entries || []).length ? 'ok' : 'warn', '世界书条目 ' + r.entries.length);
    box.appendChild(sum);
    // 字段明细
    cardKeys.forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'paste-row';
      var nm = document.createElement('span');
      nm.className = 'pr-field';
      nm.textContent = (FIELD_NAMES[k] || k) + (k === 'first_mes' ? '（主开局）' : '');
      var vl = document.createElement('span');
      vl.className = 'pr-val';
      vl.textContent = M.str(f[k]).replace(/\s+/g, ' ').slice(0, 90);
      vl.title = M.str(f[k]);
      row.appendChild(nm); row.appendChild(vl);
      box.appendChild(row);
    });
    (f.__greetings || []).forEach(function (g, i) {
      var row = document.createElement('div');
      row.className = 'paste-row';
      var nm = document.createElement('span');
      nm.className = 'pr-field';
      nm.textContent = '备用开局 ' + (i + 1);
      var vl = document.createElement('span');
      vl.className = 'pr-val';
      vl.textContent = M.str(g).replace(/\s+/g, ' ').slice(0, 90);
      row.appendChild(nm); row.appendChild(vl);
      box.appendChild(row);
    });
    // 条目明细
    (r.entries || []).slice(0, 30).forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'paste-row';
      var nm = document.createElement('span');
      nm.className = 'pr-field pr-entry';
      nm.textContent = e.comment || '未命名条目';
      var vl = document.createElement('span');
      vl.className = 'pr-val';
      vl.textContent = '关键词：' + (e.keys.join(', ') || '无') + ' · ' + e.content.replace(/\s+/g, ' ').slice(0, 70);
      row.appendChild(nm); row.appendChild(vl);
      box.appendChild(row);
    });
    if ((r.entries || []).length > 30) {
      var more = document.createElement('p'); more.className = 'hint'; more.textContent = '…只显示前 30 条，共 ' + (r.entries || []).length + ' 条'; box.appendChild(more);
    }
    (r.notes || []).forEach(function (n) {
      var p2 = document.createElement('p'); p2.className = 'tip'; p2.textContent = n; box.appendChild(p2);
    });
  }

  function applyPasteResult() {
    if (!pasteResult || !pasteResult.ok) return;
    var r = pasteResult;
    var toNew = $('#pasteToNew').checked;
    // JSON 直接走 adoptCard
    if (r.kind === 'json' && r.card) {
      if (toNew) createWork(false);
      adoptCard(r.card);
      closePasteModal(); toast('已导入 JSON 角色卡', 'ok'); return;
    }
    if (r.kind === 'book' && r.nativeBook) {
      bkMode = 'lib';
      if (toNew) createLib(false);
      importNativeBookList(r.nativeBook);
      setFormTab('tab-lib');
      closePasteModal(); toast('已导入世界书：' + r.nativeBook.entries.length + ' 条', 'ok'); return;
    }
    // 文本解析结果
    if (toNew) createWork(false);
    var f = r.fields || {};
    var written = [];
    Object.keys(f).forEach(function (k) {
      if (k === '__greetings' || k === 'tags') return;
      if (!M.str(f[k]).trim()) return;
      if (!M.str(card[k]).trim()) { card[k] = f[k]; written.push(FIELD_NAMES[k] || k); }
    });
    if (f.tags && f.tags.length && !card.tags.length) { card.tags = f.tags; written.push('标签'); }
    if ((f.__greetings || []).length) {
      f.__greetings.forEach(function (g) { card.alternate_greetings.push(g); });
      written.push('备用开局 ' + f.__greetings.length + ' 条');
    }
    if (r.entries.length) {
      var bk = card.character_book;
      var replace = !bk.entries.length || confirm('当前作品的卡内世界书已有 ' + bk.entries.length + ' 条：\n确定 = 覆盖，取消 = 追加到末尾');
      if (replace) bk.entries = r.entries; else bk.entries = bk.entries.concat(r.entries);
      written.push('世界书 ' + r.entries.length + ' 条');
    }
    syncFieldsToForm();
    renderAll();
    touch();
    closePasteModal();
    toast(written.length ? ('已应用：' + written.join('、')) : '没有可写入的内容', 'ok', 5200);
  }

  function bindPasteParse() {
    $('#btnPasteParse').addEventListener('click', openPasteModal);
    $('#btnPasteRun').addEventListener('click', runPasteParse);
    $('#btnPasteApply').addEventListener('click', applyPasteResult);
    $('#btnPasteClear').addEventListener('click', function () {
      $('#pasteText').value = '';
      renderPasteResult(null);
      $('#btnPasteApply').disabled = true;
      $('#pasteHint').textContent = '';
    });
    document.querySelectorAll('#pasteModal [data-close]').forEach(function (el) {
      el.addEventListener('click', closePasteModal);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#pasteModal').hidden) closePasteModal();
    });
  }
  /* ================= 模板片段 ================= */

  var TPL = {
    'world-frame': [
      '# 世界总纲', '',
      '## 基本定位',
      '- 这是一个（类型）世界，时代为（时间）。', '',
      '## 世界法则',
      '1. （核心规则一：它如何运作、有什么代价）',
      '2. （核心规则二）', '',
      '## 地理与局势',
      '- （主要区域与当前局势）', '',
      '## 主要势力',
      '- （势力名）：（立场、目标、与玩家的关系）', '',
      '## 禁区与底线',
      '- （世界中不可违背的设定）'
    ].join('\n'),
    'narrator-frame': [
      '# {{char}} 设定', '',
      '基本信息：',
      '- {{char}} 不是角色，也不出现在故事中，而是在场外为 {{user}} 构建世界的讲述者。', '',
      '讲述者职责：',
      '- 以小说式的叙述还原世界，描写 {{user}} 所见所闻，刻画世界中的人们。',
      '- 客观描述，不替 {{user}} 做选择，不代写 {{user}} 的行动与对白。',
      '- NPC 拥有自己的立场与行动逻辑，不因玩家的意愿无条件让步。', '',
      '叙述节奏：',
      '- 每次只推进一小段剧情，结尾留出 {{user}} 的反应空间。'
    ].join('\n'),
    'mes-example': [
      '<START>',
      '{{user}}: （引出世界观的一个提问）',
      '{{char}}: （以讲述者口吻给出环境描写与 NPC 的反应）', '',
      '<START>',
      '{{user}}: （一次具体行动）',
      '{{char}}: （行动的后果与新的线索）'
    ].join('\n'),
    'status-html': [
      '<div style="background:#121212;border:1px solid #E9E9E4;border-left:4px solid #2BD576;border-radius:4px;padding:14px 16px;margin-top:14px;color:#E9E9E4;font-size:0.92em;line-height:1.8;">',
      '  <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 16px;">',
      '    <span>⏰ 时间：{{date}} {{time}}</span>',
      '    <span>📍 地点：（当前位置）</span>',
      '  </div>',
      '  <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 16px;margin-top:4px;">',
      '    <span>🧭 局势：（当前态势）</span>',
      '    <span>⚠️ 危险度：（低 / 中 / 高）</span>',
      '  </div>',
      '  <div style="border-top:1px dashed #E9E9E4;margin-top:8px;padding-top:8px;color:#6EE7A8;">🎯 当前目标：（玩家眼前的任务或线索）</div>',
      '</div>'
    ].join('\n'),
    'status-lite': [
      '⏰ {{date}} {{time}}　📍 （当前位置）',
      '🧭 局势：（当前态势）　⚠️ 危险度：（低 / 中 / 高）'
    ].join('\n'),
    'opening-menu': [
      '【开局选择】',
      'A. （场景一：身份与处境）',
      'B. （场景二：另一个时间点或阵营）',
      'C. （自定义：输入你想要的开局）'
    ].join('\n')
  };

  var TARGET_NAMES = {
    description: '世界总纲', scenario: '世界当前情况', personality: '叙事基调', mes_example: '叙事示例',
    first_mes: '主开局', post_history_instructions: '历史后指令', system_prompt: '系统提示', creator_notes: '作者备注'
  };
  var editingTplId = null;

  function loadCustomTpls() {
    try {
      var list = JSON.parse(localStorage.getItem(LS_CUSTOM) || '[]');
      return Array.isArray(list) ? list.filter(function (t) { return t && t.id && t.name && t.target && typeof t.content === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function saveCustomTpls(list) {
    try { localStorage.setItem(LS_CUSTOM, JSON.stringify(list)); } catch (e) { toast('保存片段失败：浏览器存储不可用', 'err'); }
  }
  function appendToCard(key, text, msg) {
    var cur = M.str(card[key]).replace(/\s+$/, '');
    card[key] = (cur ? cur + '\n\n' : '') + text;
    syncFieldsToForm();
    touch();
    if (msg) toast(msg, 'ok', 3600);
  }

  function renderCustomButtons(list) {
    $$('.ct-inline-btn').forEach(function (b) { b.remove(); });
    list.forEach(function (t) {
      var field = document.querySelector('[data-field="' + t.target + '"]');
      if (!field) return;
      var wrap = field.closest('.field');
      if (!wrap) return;
      var row = wrap.querySelector('.inline-tools');
      if (!row) {
        row = document.createElement('div');
        row.className = 'inline-tools';
        wrap.insertBefore(row, wrap.firstChild);
      }
      var b = document.createElement('button');
      b.className = 'btn small ct-inline-btn';
      b.textContent = '🧩 ' + t.name;
      b.title = '插入片段「' + t.name + '」';
      b.addEventListener('click', function () { insertCustomTpl(t.id); });
      row.appendChild(b);
    });
  }

  function renderCustomTplList() {
    var list = loadCustomTpls();
    renderCustomButtons(list);
    var wrap = $('#customTplList');
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<p class="hint" style="margin:6px 0 0">（还没有片段。把常用段落存下来，之后一键插入。）</p>';
      return;
    }
    list.forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'custom-tpl-item';
      item.innerHTML = '<span class="ct-name"></span><span class="ct-target"></span><span class="ct-preview"></span>';
      item.querySelector('.ct-name').textContent = t.name;
      item.querySelector('.ct-target').textContent = '→ ' + (TARGET_NAMES[t.target] || t.target);
      var pv = item.querySelector('.ct-preview');
      pv.textContent = t.content.replace(/\s+/g, ' ').slice(0, 60);
      pv.title = t.content;
      var ins = document.createElement('button');
      ins.className = 'btn small';
      ins.textContent = '插入';
      ins.addEventListener('click', function () { insertCustomTpl(t.id); });
      item.appendChild(ins);
      item.appendChild(iconBtn('✎', '编辑', function () { openTplEditor(t); }));
      item.appendChild(iconBtn('✕', '删除', function () {
        if (!confirm('删除片段「' + t.name + '」？')) return;
        saveCustomTpls(loadCustomTpls().filter(function (x) { return x.id !== t.id; }));
        renderCustomTplList();
        toast('片段已删除', 'ok');
      }, 'danger'));
      wrap.appendChild(item);
    });
  }

  function insertCustomTpl(id) {
    var t = loadCustomTpls().filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    appendToCard(t.target, t.content, '已插入片段「' + t.name + '」');
  }

  function openTplEditor(tpl) {
    $('#customTplEditor').hidden = false;
    editingTplId = tpl ? tpl.id : null;
    $('#ct-name').value = tpl ? tpl.name : '';
    $('#ct-target').value = tpl ? tpl.target : 'description';
    $('#ct-content').value = tpl ? tpl.content : '';
    $('#ct-editing').textContent = tpl ? '正在编辑：' + tpl.name : '';
    $('#ct-name').focus();
  }

  function bindCustomTpl() {
    $$('[data-tpl]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        appendToCard(btn.getAttribute('data-target'), TPL[btn.getAttribute('data-tpl')], '已插入模板，请替换括号里的占位文字');
      });
    });
    // 清除按钮：逐个字段确认后清空
    $$('[data-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-clear');
        var ta = document.querySelector('[data-field="' + key + '"]');
        if (!ta) return;
        var label = TARGET_NAMES[key] || key;
        if (!M.str(ta.value).trim()) { toast('「' + label + '」已经是空的', 'info'); return; }
        if (!confirm('确定清除「' + label + '」的全部内容？\n此操作不可撤销。')) return;
        ta.value = '';
        card[key] = '';
        updateCount(ta);
        touch();
        toast('已清除「' + label + '」', 'ok');
      });
    });
    $('#btnNewTpl').addEventListener('click', function () { openTplEditor(null); });
    $('#ct-cancel').addEventListener('click', function () { $('#customTplEditor').hidden = true; editingTplId = null; });
    $('#ct-save').addEventListener('click', function () {
      var name = $('#ct-name').value.trim();
      var target = $('#ct-target').value;
      var content = $('#ct-content').value;
      if (!name) { toast('请先填写片段名称', 'err'); return; }
      if (!content.trim()) { toast('片段内容不能为空', 'err'); return; }
      var list = loadCustomTpls();
      if (editingTplId) {
        list = list.map(function (t) { return t.id === editingTplId ? { id: t.id, name: name, target: target, content: content } : t; });
      } else {
        list.push({ id: 'ct' + Date.now(), name: name, target: target, content: content });
      }
      saveCustomTpls(list);
      renderCustomTplList();
      $('#customTplEditor').hidden = true;
      editingTplId = null;
      toast('片段「' + name + '」已保存，按钮已出现在对应字段上方', 'ok', 3800);
    });
    renderCustomTplList();
  }

  /* ================= 预览与体检 ================= */

  var schedulePreviewRender = debounce(function () {
    renderChatPreview();
    renderHealth();
    if (isTabActive('tab-json')) renderPreview();
  }, 250);
  function scheduleSide() { schedulePreviewRender(); }
  function isTabActive(id) {
    var el = document.getElementById(id);
    return !!(el && el.classList.contains('active'));
  }
  function renderJsonIfVisible() { if (isTabActive('tab-json')) renderPreview(); }

  function renderPreview() {
    var pre = $('#jsonPreview');
    try { pre.textContent = JSON.stringify(M.toExportBundle(card, { spec: card.spec }).primary, null, 2); }
    catch (e) { pre.textContent = String(e); }
  }

  function jumpHealth(h) {
    if (!h || !h.tab) return;
    setFormTab(h.tab);
    if (h.focus) {
      setTimeout(function () {
        var el = document.querySelector(h.focus);
        if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      }, 60);
    }
  }

  function renderHealth() {
    var bar = $('#healthBar');
    var stats = M.bookStats(card.character_book);
    var size = 0;
    try { size = JSON.stringify(card).length; } catch (e) { size = 0; }
    var kb = size / 1024;
    var rules = card.rules || [];
    var chips = [];
    if (card.name.trim()) chips.push({ cls: 'ok', t: '作品：' + card.name.trim(), tab: 'tab-overview', focus: '[data-field="name"]' });
    else chips.push({ cls: 'bad', t: '缺少作品名', tab: 'tab-overview', focus: '[data-field="name"]' });
    if (card.first_mes.trim()) chips.push({ cls: 'ok', t: '主开局 ✓', tab: 'tab-open', focus: '[data-field="first_mes"]' });
    else chips.push({ cls: 'bad', t: '缺少主开局', tab: 'tab-open', focus: '[data-field="first_mes"]' });
    chips.push(
      { cls: 'info', t: '备用开局 ' + card.alternate_greetings.length, tab: 'tab-open' },
      { cls: 'info', t: '条例 ' + rules.filter(function (r) { return r.enabled; }).length + ' 条', tab: 'tab-rules' },
      { cls: 'info', t: '世界书 ' + stats.total + ' 条' + (stats.constant ? '（常驻 ' + stats.constant + '）' : ''), tab: 'tab-book' },
      { cls: 'info', t: '正则 ' + card.extensions.regex_scripts.length, tab: 'tab-ui' },
      { cls: kb >= 2048 ? 'warn' : 'info', t: '体积 ' + (kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB') }
    );
    M.health(card).forEach(function (h) {
      // 已用上方摘要覆盖的「缺少作品名 / 主开局」不再重复
      if (h.level === 'error' && (/缺少作品|缺少主开局/.test(h.text))) return;
      chips.push({
        cls: h.level === 'error' ? 'bad' : (h.level === 'warn' ? 'warn' : 'info'),
        t: h.text, tab: h.tab || '', focus: h.focus || ''
      });
    });
    bar.innerHTML = '';
    chips.forEach(function (c) {
      var s = document.createElement(c.tab ? 'button' : 'span');
      s.className = 'chip ' + c.cls + (c.tab ? ' chip-go' : '');
      s.textContent = c.t;
      if (c.tab) {
        s.type = 'button';
        s.title = '点击跳转到对应页签';
        s.addEventListener('click', function () { jumpHealth(c); });
      }
      bar.appendChild(s);
    });
  }

  var chatAvaUrl = null;
  var PREVIEW_CSS = [
    'html,body{margin:0;background:transparent;}',
    'body{font:14px/1.75 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#E9E9E4;word-break:break-word;padding:12px 14px;}',
    'em.act{color:#6EE7A8;font-style:italic;} span.say{color:#f3d58b;}',
    'img{max-width:100%;}'
  ].join('');

  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function markdownLite(text) {
    var h = escapeHtml(text).replace(/\r\n/g, '\n');
    // 先处理台词引号，再加标签，避免把标签自身的属性引号误当作台词
    h = h.replace(/(“[^”\n]*”|"[^"\n]*")/g, '<span class="say">$1</span>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\*([^*\n]+)\*/g, '<em class="act">$1</em>');
    return h.replace(/\n/g, '<br>');
  }
  // 预览用的 HTML 清洗：保留样式与结构，去掉脚本与事件属性（预览不执行脚本）
  function sanitizePreviewHtml(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('script,iframe,object,embed,link,meta,form,base').forEach(function (el) { el.remove(); });
    tpl.content.querySelectorAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var n = attr.name.toLowerCase();
        var v = String(attr.value).trim().toLowerCase();
        if (n.indexOf('on') === 0 || ((n === 'href' || n === 'src') && v.indexOf('javascript:') === 0)) {
          el.removeAttribute(attr.name);
        }
      });
    });
    return tpl.innerHTML;
  }

  function previewBodyHtml(text, renderHtml) {
    if (renderHtml && (/<\/?[a-z][\s\S]*?>/i.test(text) || /```html/i.test(text))) {
      return sanitizePreviewHtml(text.replace(/```html[ \t]*\r?\n?/gi, '').replace(/```[ \t]*$/gm, ''));
    }
    return markdownLite(text);
  }

  function messageDocument(text, renderHtml) {
    return '<!doctype html><html><head><meta charset="utf-8"><style>' + PREVIEW_CSS + '</style></head><body>' +
      previewBodyHtml(text, renderHtml) + '</body></html>';
  }

  function currentGreeting() {
    if (previewIdx === 0) return M.str(card.first_mes);
    return M.str(card.alternate_greetings[previewIdx - 1]);
  }

  function renderChatPreview() {
    var box = $('#chatPreview');
    var total = card.alternate_greetings.length + 1;
    if (previewIdx >= total) previewIdx = 0;
    box.querySelector('.chat-name').textContent = card.name.trim() || '作品名';
    box.querySelector('.chat-idx').textContent = total > 1 ? '开局 ' + (previewIdx + 1) + '/' + total : '主开局';
    $('#previewHint').textContent = total > 1 ? '共 ' + total + ' 个开局，‹ › 切换' : '';
    var bodyEl = box.querySelector('.chat-body');
    var raw = currentGreeting();
    if (!raw.trim()) {
      bodyEl.innerHTML = '<p class="empty-note">（这里为空。在「开局」页填写开场，这里会实时预览它在酒馆里的样子。）</p>';
      return;
    }
    var useRegex = $('#cbRegexPreview').checked;
    var renderHtml = $('#cbRenderHtml').checked;
    var text = M.applyMacros(useRegex ? M.applyDisplayRegex(raw, card.extensions.regex_scripts) : raw, card.name.trim() || '角色', 'User');
    var bodyHtml = previewBodyHtml(text, renderHtml);
    var note = $('#previewNote');
    if (!bodyHtml.trim() && raw.trim()) {
      note.hidden = false;
      note.textContent = '预览为空：这条开场白被正则整体替换为外部 HTML 面板，预览不会加载外部资源与脚本（酒馆中可能正常显示）。可取消勾选「应用正则显示效果」查看原文。';
    } else {
      note.hidden = true;
    }
    var frame = bodyEl.querySelector('iframe');
    if (!frame) {
      bodyEl.innerHTML = '';
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.className = 'msg-frame';
      frame.title = '开局预览';
      frame.addEventListener('load', function () {
        try { frame.style.height = Math.max(56, frame.contentDocument.documentElement.scrollHeight) + 'px'; } catch (e) { /* ignore */ }
      });
      bodyEl.appendChild(frame);
    }
    frame.srcdoc = messageDocument(text, $('#cbRenderHtml').checked);
  }
  function cycleGreeting(dir) {
    var total = card.alternate_greetings.length + 1;
    previewIdx = (previewIdx + dir + total) % total;
    renderChatPreview();
  }

  function setChatAvatar() {
    var img = document.querySelector('#chatPreview .chat-ava');
    if (!img) return;
    if (chatAvaUrl) { URL.revokeObjectURL(chatAvaUrl); chatAvaUrl = null; }
    if (avatarBytes) { chatAvaUrl = URL.createObjectURL(new Blob([avatarBytes])); img.src = chatAvaUrl; }
    else img.removeAttribute('src');
  }

  /* ================= 封面 ================= */

  function setAvatar(bytes, fileName, persist) {
    avatarBytes = bytes;
    avatarIsPng = PNGCard.isPng(bytes);
    setChatAvatar();
    if (persist !== false) idbSet('avatar', { bytes: bytes, name: fileName }).catch(function () { /* ignore */ });
    var blob = new Blob([bytes]);
    if (avatarUrl) URL.revokeObjectURL(avatarUrl);
    avatarUrl = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      // 作品页封面框
      var box = $('#coverBox');
      box.innerHTML = '';
      box.appendChild(img.cloneNode());
      box.classList.add('has-img');
      // 侧栏预览框
      var box2 = $('#avatarPreview');
      box2.innerHTML = '';
      box2.appendChild(img.cloneNode());
      // 顶栏缩略图
      var th = $('#coverThumb');
      th.src = avatarUrl;
      th.hidden = false;
      $('#coverThumbPh').hidden = true;
      var info = img.width + '×' + img.height + ' · ' + (avatarIsPng ? 'PNG（原样嵌入）' : '将自动转为 PNG');
      $('#avatarInfo').textContent = info;
      $('#coverInfo').textContent = info;
    };
    img.onerror = function () {
      $('#avatarInfo').textContent = '图片解码失败';
      $('#coverInfo').textContent = '图片解码失败';
    };
    img.src = avatarUrl;
  }

  function clearAvatar() {
    if (!avatarBytes) { toast('当前没有封面', 'info'); return; }
    if (!confirm('移除当前封面图片？移除后需要重新选择才能生成 PNG。')) return;
    avatarBytes = null;
    avatarIsPng = false;
    setChatAvatar();
    idbDel('avatar').catch(function () { /* ignore */ });
    if (avatarUrl) { URL.revokeObjectURL(avatarUrl); avatarUrl = null; }
    $('#coverBox').innerHTML = '尚未选择';
    $('#coverBox').classList.remove('has-img');
    $('#avatarPreview').innerHTML = '尚未选择封面<br>点击下方按钮，或直接把图片拖进页面';
    $('#coverThumb').hidden = true;
    $('#coverThumbPh').hidden = false;
    $('#coverInfo').textContent = '';
    $('#avatarInfo').textContent = '';
    toast('封面已移除', 'ok');
  }

  function bindCover() {
    $('#btnPickCover').addEventListener('click', function () { $('#avatarFile').click(); });
    $('#btnPickAvatar').addEventListener('click', function () { $('#avatarFile').click(); });
    $('#btnCoverTop').addEventListener('click', function () { $('#avatarFile').click(); });
    $('#btnClearCover').addEventListener('click', clearAvatar);
  }

  async function setAvatarFromFile(file) {
    setAvatar(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  function convertToPng(bytes) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([bytes]));
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, MAX_AVATAR_SIDE / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (!blob) { reject(new Error('图片转码失败')); return; }
            blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
          }, 'image/png');
        } catch (err) { URL.revokeObjectURL(url); reject(err); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败，请换一张图片')); };
      img.src = url;
    });
  }

  function bindAvatar() {
    $('#avatarFile').addEventListener('change', async function () {
      if (!this.files || !this.files[0]) return;
      await setAvatarFromFile(this.files[0]);
      this.value = '';
      if (pendingGenerate) { pendingGenerate = false; setTimeout(generatePng, 100); }
    });
  }

  /* ================= 导入 ================= */

  function adoptCard(obj) {
    invalidateHelper();
    var wasInternal = M.isInternalCard(obj);
    card = wasInternal ? M.fromInternalCard(obj) : M.fromCardObject(obj);
    // 导入外部卡时不注入默认条例，避免把我们的条例写进别人的卡
    if (!card.rules.length && wasInternal) card.rules = M.defaultRules();
    var w = currentWork();
    if (w) { w.name = card.name.trim() || '未命名作品'; }
    previewIdx = 0;
    resetBookView('card');
    $('#bookSearch').value = '';
    editingRuleId = null;
    $('#ruleEditor').hidden = true;
    renderAll();
    touch();
  }

  function importJsonObject(o) {
    if (M.looksLikeNativeBook(o)) { importNativeBookList(M.parseNativeBook(o)); return; }
    if (o && typeof o === 'object' && o.findRegex != null) {
      card.extensions.regex_scripts.push(M.normalizeRegex(o));
      renderRegex(); touch();
      toast('已导入 1 条正则脚本', 'ok', 3800);
      setFormTab('tab-ui');
      return;
    }
    if (o && (o.prompts || o.prompt_order)) {
      throw new Error('这是酒馆「预设」文件，不是世界卡；请在酒馆的预设面板中导入');
    }
    if (o && (o.spec || o.data || o.name || o.first_mes || o.description)) {
      adoptCard(o);
      toast('JSON 世界卡导入成功（' + (o.spec === 'chara_card_v3' ? 'V3' : (o.spec === 'chara_card_v2' ? 'V2' : 'V1')) + '）', 'ok');
      return;
    }
    throw new Error('无法识别的 JSON 文件');
  }

  async function importFile(file) {
    try {
      var lower = file.name.toLowerCase();
      if (lower.endsWith('.png') || file.type === 'image/png') {
        var bytes = new Uint8Array(await file.arrayBuffer());
        var cards = PNGCard.readCards(bytes);
        var obj = cards.ccv3 || cards.chara;
        if (!obj) {
          setAvatar(bytes, file.name);
          toast('这张 PNG 没有内嵌世界卡数据，已设为封面', 'info', 4200);
          return;
        }
        adoptCard(obj);
        setAvatar(bytes, file.name);
        toast('已导入世界卡「' + card.name + '」，封面已带入', 'ok', 4200);
      } else if (lower.endsWith('.json') || file.type === 'application/json') {
        importJsonObject(JSON.parse(await file.text()));
      } else if (/\.(md|markdown|txt)$/.test(lower)) {
        restoreFromMdText(await file.text(), file.name);
      } else if (file.type.startsWith('image/')) {
        await setAvatarFromFile(file);
        toast('已设为封面', 'ok');
      } else {
        toast('不支持的文件类型：' + file.name, 'err');
      }
    } catch (e) {
      toast('导入失败：' + e.message, 'err', 5200);
    }
  }

  function bindImport() {
    $('#btnImport').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) importFile(this.files[0]);
      this.value = '';
    });
  }

  function bindDrop() {
    var overlay = $('#dropOverlay');
    var depth = 0;
    window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; overlay.hidden = false; });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function (e) {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importFile(e.dataTransfer.files[0]);
    });
  }

  /* ================= 导出 / 生成 ================= */

  function validateCard() {
    if (!card.name.trim()) { toast('请先填写「作品 / 世界名」', 'err'); setFormTab('tab-overview'); $('[data-field="name"]').focus(); return false; }
    if (!card.first_mes.trim()) { toast('请先填写「主开局」', 'err'); setFormTab('tab-open'); $('[data-field="first_mes"]').focus(); return false; }
    return true;
  }

  function ensurePermission(dir) {
    return Promise.resolve().then(function () { return dir.queryPermission({ mode: 'readwrite' }); }).then(function (st) {
      if (st === 'granted') return true;
      return dir.requestPermission({ mode: 'readwrite' }).then(function (r) { return r === 'granted'; });
    }).catch(function () { return false; });
  }

  function writeBlobToDir(fileName, blob) {
    if (!archiveDirHandle) return Promise.reject(new Error('未设置保存目录'));
    return ensurePermission(archiveDirHandle).then(function (granted) {
      if (!granted) throw new Error('没有保存目录的写入权限');
      return archiveDirHandle.getFileHandle(fileName, { create: true });
    }).then(function (fh) {
      return fh.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); });
    });
  }

  async function exportJson() {
    if (!validateCard()) return;
    var fileName = sanitizeFilename(card.name) + '.json';
    var text = JSON.stringify(M.toExportBundle(card, { spec: card.spec }).primary, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var specTxt = card.spec === 'chara_card_v3' ? 'V3' : 'V2';
    if (archiveDirHandle && saveSettings.saveJson) {
      try {
        await writeBlobToDir(fileName, blob);
        if (saveSettings.alsoDownload) download(blob, fileName);
        toast('JSON 已保存到「' + archiveDirHandle.name + '」（' + specTxt + '）', 'ok', 4200);
      } catch (e) {
        download(blob, fileName);
        toast('保存到目录失败（' + e.message + '），已改为下载', 'err', 5200);
      }
      return;
    }
    download(blob, fileName);
    toast('JSON 已导出（' + specTxt + '）', 'ok');
  }

  async function generatePng() {
    if (!validateCard()) return;
    if (!avatarBytes) {
      pendingGenerate = true;
      $('#avatarFile').click();
      toast('请先选择封面图片，选择后自动生成', 'info', 3500);
      return;
    }
    try {
      var pngBytes = avatarIsPng ? avatarBytes : await convertToPng(avatarBytes);
      var bundle = M.toExportBundle(card, { spec: card.spec });
      var out = PNGCard.writeCards(pngBytes, bundle.chunks);
      var back = PNGCard.readCards(out)[bundle.key];
      if (!back || JSON.stringify(back) !== JSON.stringify(bundle.primary)) throw new Error('读回校验失败，已取消保存');
      var fileName = sanitizeFilename(card.name) + '.png';
      var blob = new Blob([out], { type: 'image/png' });
      if (archiveDirHandle && saveSettings.savePng) {
        try {
          await writeBlobToDir(fileName, blob);
          if (saveSettings.alsoDownload) download(blob, fileName);
          toast('PNG 世界卡已保存到「' + archiveDirHandle.name + '」并通过校验 ✔', 'ok', 4200);
        } catch (e) {
          download(blob, fileName);
          toast('保存到目录失败（' + e.message + '），已改为下载', 'err', 5200);
        }
        return;
      }
      download(blob, fileName);
      toast('PNG 世界卡已生成并通过校验 ✔ 可直接拖进酒馆导入', 'ok', 4200);
    } catch (e) {
      toast('生成失败：' + e.message, 'err', 5000);
    }
  }

  /* ================= MD 存档 ================= */

  function mdSection(title, body) {
    return M.str(body).trim() ? '## ' + title + '\n\n' + M.str(body).trim() + '\n\n' : '';
  }

  function buildArchiveMd() {
    var t = new Date();
    var stamp = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
    var md = '# 世界卡存档：' + (card.name || '未命名') + '\n\n';
    md += '- 存档时间：' + stamp + '\n';
    md += '- 作者：' + (card.creator || '—') + '　版本：' + (card.character_version || '—') + '\n';
    md += '- 标签：' + (card.tags.join(', ') || '—') + '\n\n---\n\n';
    md += mdSection('世界总纲 description', card.description);
    md += mdSection('当前处境 scenario', card.scenario);
    md += mdSection('叙事基调 personality', card.personality);
    var rules = (card.rules || []).filter(function (r) { return r.enabled; });
    if (rules.length) {
      md += '## 条例（' + rules.length + ' 条）\n\n';
      rules.forEach(function (r) {
        md += '### ' + r.title + '\n\n→ ' + (M.RULE_TARGETS.filter(function (t2) { return t2.v === r.target; })[0] || { t: r.target }).t + '\n\n' + r.body + '\n\n';
      });
    }
    md += mdSection('主开局 first_mes', card.first_mes);
    card.alternate_greetings.forEach(function (g, i) { md += mdSection('备用开局 ' + (i + 1), g); });
    card.group_only_greetings.forEach(function (g, i) { md += mdSection('群聊开局 ' + (i + 1), g); });
    md += mdSection('叙事示例 mes_example', card.mes_example);
    var entries = card.character_book.entries;
    if (entries.length) {
      md += '## 内嵌世界书（' + entries.length + ' 条）\n\n';
      entries.forEach(function (e) {
        md += '### ' + (e.comment || '未命名条目') + '\n\n';
        md += '- 关键词：' + (e.keys.join(', ') || '（无）') + (e.constant ? '（常驻）' : '') + (e.enabled ? '' : '（已停用）') + '\n\n';
        md += e.content + '\n\n';
      });
    }
    if (card.extensions.regex_scripts.length) {
      md += '## 正则脚本（' + card.extensions.regex_scripts.length + ' 条）\n\n';
      card.extensions.regex_scripts.forEach(function (s) { md += '- ' + s.scriptName + (s.disabled ? '（已停用）' : '') + '：' + s.findRegex + '\n'; });
      md += '\n';
    }
    md += mdSection('历史后指令 post_history_instructions', card.post_history_instructions);
    md += '## 机器可读数据（「从 MD 恢复」用，勿改动）\n\n```json\n' + JSON.stringify({ card: card }, null, 2) + '\n```\n';
    return md;
  }

  async function writeArchiveFile(fileName) {
    var md = buildArchiveMd();
    if (!(await ensurePermission(archiveDirHandle))) throw new Error('没有文件夹写入权限');
    var fh = await archiveDirHandle.getFileHandle(fileName, { create: true });
    var w = await fh.createWritable();
    await w.write(md);
    await w.close();
    return fileName;
  }

  async function saveArchive() {
    try {
      var base = sanitizeFilename(card.name || '未命名世界');
      // 未设目录：直接下载，并提示可以设目录（避免突然弹出文件夹选择框）
      if (!archiveDirHandle) {
        if (typeof window.showDirectoryPicker !== 'function') {
          download(new Blob([buildArchiveMd()], { type: 'text/markdown' }), base + '_' + timestampForFile() + '.md');
          toast('当前浏览器不支持直接写入文件夹，已改为下载 .md', 'info', 6000);
          return;
        }
        download(new Blob([buildArchiveMd()], { type: 'text/markdown' }), base + '_' + timestampForFile() + '.md');
        toast('已下载 .md存档。如果想直接写入文件夹，请先点「📁 设置保存目录」', 'ok', 6500);
        return;
      }
      var fname = await writeArchiveFile(base + '_' + timestampForFile() + '.md');
      toast('MD 存档已保存：' + fname, 'ok', 4200);
    } catch (e) {
      if (e && e.name === 'AbortError') { toast('已取消选择文件夹', 'info'); return; }
      toast('存档失败：' + e.message, 'err', 5200);
    }
  }

  async function autoSaveArchive() {
    if (!archiveDirHandle) return;
    try {
      if (!(await ensurePermission(archiveDirHandle))) return;
      await writeArchiveFile(sanitizeFilename(card.name || '未命名世界') + '_自动.md');
    } catch (e) { /* ignore */ }
  }

  function restoreFromMdText(text, sourceName) {
    var start = text.lastIndexOf('```json');
    var fenceLen = 7;
    if (start === -1) { start = text.lastIndexOf('```'); fenceLen = 3; }
    if (start === -1) { toast('这个 MD 里没有数据块，无法恢复', 'err', 5000); return; }
    var end = text.lastIndexOf('```');
    var body = end > start ? text.slice(start + fenceLen, end) : text.slice(start + fenceLen);
    try {
      var parsed = JSON.parse(body.trim());
      adoptCard(parsed.card || parsed);
      toast('已从 MD 恢复：' + (card.name || sourceName || '未命名'), 'ok', 4200);
    } catch (e) {
      toast('恢复失败：' + e.message, 'err', 5200);
    }
  }

  function updateArchiveInfo() {
    var el = $('#archiveDirInfo');
    el.textContent = archiveDirHandle ? '📁 ' + archiveDirHandle.name : '';
    renderSaveSettings();
  }

  function renderSaveSettings() {
    $('#save-png').checked = saveSettings.savePng;
    $('#save-json').checked = saveSettings.saveJson;
    $('#also-download').checked = saveSettings.alsoDownload;
    $('#saveDirWarn').hidden = !!archiveDirHandle || typeof window.showDirectoryPicker === 'function';
  }

  function bindSaveSettings() {
    function bind(id, key) {
      $('#' + id).addEventListener('change', function () {
        saveSettings[key] = this.checked;
        try { localStorage.setItem(LS_SAVE, JSON.stringify(saveSettings)); } catch (e) { /* ignore */ }
      });
    }
    bind('save-png', 'savePng');
    bind('save-json', 'saveJson');
    bind('also-download', 'alsoDownload');
    renderSaveSettings();
  }

  async function pickArchiveDir() {
    try {
      if (typeof window.showDirectoryPicker !== 'function') {
        toast('当前浏览器不支持文件夹选择（需 Chrome / Edge）', 'info', 5200);
        return;
      }
      archiveDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      try { await idbSet('archiveDir', archiveDirHandle); } catch (e) { /* ignore */ }
      updateArchiveInfo();
      toast('保存目录已设为「' + archiveDirHandle.name + '」', 'ok', 4200);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('设置失败：' + e.message, 'err', 5200);
    }
  }

  async function initArchive() {
    try {
      var h = await idbGet('archiveDir');
      if (h) {
        archiveDirHandle = h;
        updateArchiveInfo();
        if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          $('#archiveDirInfo').textContent += '（下次保存时点击授权）';
        }
      }
    } catch (e) { /* ignore */ }
    setInterval(autoSaveArchive, 90000);
    window.addEventListener('pagehide', function () { autoSaveArchive(); });
  }

  /* ================= AI 扩写世界 ================= */

  var AI_SYSTEM_PROMPT = [
    '你是资深的 SillyTavern 世界卡设计师。根据用户的世界构想，扩写出一张「世界观卡」。卡的核心是世界，不是单个角色。',
    '只输出一个 JSON 对象（不要任何解释文字），结构如下：',
    '{',
    '  "name": 作品/世界名（简短有记忆点）,',
    '  "creator_notes": 给玩家看的简短使用说明,',
    '  "tags": [4-8 个标签],',
    '  "description": 世界总纲，用 # 与 - 分节（基本定位、世界法则、地理与局势、主要势力、禁区与底线），以讲述者视角写，400-900 字；用 {{char}} 指讲述者、{{user}} 指玩家；包含讲述者职责（客观叙述、不替玩家做选择）,',
    '  "scenario": 当前处境（时间、地点、局势），100-200 字,',
    '  "personality": 叙事基调，40 字内,',
    '  "mes_example": 2 组示例，每组以单独一行 <START> 开头，用 {{user}}: 与 {{char}}: 交替,',
    '  "first_mes": 主开局 300-600 字，用「你」或 {{user}} 把玩家带入场景，结尾留出选择空间,',
    '  "alternate_greetings": [2-3 个不同时间点或阵营的备用开局],',
    '  "character_book": { "name": 世界书名, "entries": [6-12 条，每条为 {"comment": "【分类】标题"，分类只能取 地理/势力/历史/人物/物品/规则/事件/其他 之一，"keys": [触发关键词数组], "secondary_keys": [], "content": 150-300 字的设定文本, "constant": 布尔（世界规则条目设为 true）, "position": "before_char"}] }',
    '}',
    '所有文本使用中文（专有名词除外）。内容要原创、具体、有因果，禁止模板化套话。'
  ].join('\n');

  function extractJson(text) {
    var t = String(text).replace(/```(?:json)?/gi, '').trim();
    var s = t.indexOf('{');
    var e = t.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('AI 返回内容里没有找到 JSON');
    return JSON.parse(t.slice(s, e + 1));
  }

  function loadAiConfig() {
    try {
      var c = JSON.parse(localStorage.getItem(LS_AI) || '{}');
      if (c.base) $('#ai-base').value = c.base;
      if (c.key) $('#ai-key').value = c.key;
      if (c.model) $('#ai-model').value = c.model;
    } catch (e) { /* ignore */ }
  }

  function saveAiConfig() {
    try {
      localStorage.setItem(LS_AI, JSON.stringify({
        base: $('#ai-base').value.trim(), key: $('#ai-key').value.trim(), model: $('#ai-model').value.trim()
      }));
    } catch (e) { /* ignore */ }
  }

  function applyAiWorld(o) {
    if (!o || typeof o !== 'object') throw new Error('AI 返回的 JSON 结构不对');
    var hasContent = card.name.trim() || card.description.trim() || card.character_book.entries.length;
    if (hasContent && !confirm('当前作品已有内容，AI 生成将覆盖世界总纲、开局与世界书，继续？')) return false;
    var next = M.emptyCard();
    next.spec = card.spec;
    next.creator = card.creator;
    next.character_version = card.character_version;
    next.extensions = card.extensions;
    next.tone = card.tone;
    next.rules = card.rules;
    ['name', 'description', 'scenario', 'personality', 'mes_example', 'first_mes', 'creator_notes'].forEach(function (k) {
      if (o[k] != null) next[k] = M.str(o[k]);
    });
    next.tags = M.toList(o.tags);
    next.alternate_greetings = (Array.isArray(o.alternate_greetings) ? o.alternate_greetings : []).map(M.str).filter(Boolean);
    var bk = o.character_book || {};
    next.character_book = M.normalizeBook({
      name: bk.name || next.name,
      entries: (Array.isArray(bk.entries) ? bk.entries : []).map(function (e, i) {
        var n = M.normalizeEntry(e);
        n.insertion_order = (i + 1) * 10;
        return n;
      })
    });
    card = next;
    var w = currentWork();
    if (w) w.name = card.name.trim() || '未命名作品';
    previewIdx = 0;
    resetBookView('card');
    renderAll();
    touch();
    return true;
  }

  async function aiGenerate() {
    var btn = $('#btnAiGen');
    var status = $('#aiStatus');
    var cfg = {
      base: $('#ai-base').value.trim().replace(/\/+$/, ''),
      key: $('#ai-key').value.trim(),
      model: $('#ai-model').value.trim() || 'gpt-4o-mini'
    };
    var desc = $('#ai-desc').value.trim();
    if (!cfg.base || !cfg.key) { toast('请先填写「接口地址」和「API 密钥」', 'err'); return; }
    if (!desc) { toast('请先写一句世界构想', 'err'); return; }
    saveAiConfig();
    btn.disabled = true;
    status.textContent = '生成中…（最长等待 3 分钟）';
    var timer = null;
    try {
      var ctrl = new AbortController();
      timer = setTimeout(function () { ctrl.abort(); }, 180000);
      var res = await fetch(cfg.base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
        body: JSON.stringify({
          model: cfg.model, temperature: 0.8, stream: false,
          messages: [
            { role: 'system', content: AI_SYSTEM_PROMPT },
            { role: 'user', content: '世界构想：\n' + desc + '\n\n请严格按系统要求输出 JSON。' }
          ]
        }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        var errText = await res.text().catch(function () { return ''; });
        throw new Error('接口返回 HTTP ' + res.status + '：' + errText.slice(0, 200));
      }
      var j = await res.json();
      var content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) throw new Error('接口返回里没有消息内容');
      if (applyAiWorld(extractJson(content))) {
        status.textContent = '生成完成 ✔ 请检查世界书分类与开局，再按需修改。';
        toast('AI 已生成世界观，请逐项检查', 'ok');
      } else {
        status.textContent = '已取消。';
      }
    } catch (e) {
      var msg = e.name === 'AbortError' ? '请求超时（3 分钟）' : e.message;
      if (e instanceof TypeError) msg += ' —— 通常是跨域(CORS)或网络问题，可改用「兼容模式.bat」再试';
      status.textContent = '失败：' + msg;
      toast('AI 生成失败：' + msg, 'err', 6000);
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
    }
  }

  /* ================= 页签 / 快捷键 ================= */

  function bindTabs() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_TAB) || '{}') || {}; } catch (e) { /* ignore */ }
    document.querySelectorAll('[data-tabs]').forEach(function (group) {
      var groupName = group.getAttribute('data-tabs');
      var container = document.querySelector('[data-panels="' + groupName + '"]');
      if (!container) return;
      var buttons = Array.prototype.slice.call(group.querySelectorAll('[data-tab]'));
      function activate(id) {
        buttons.forEach(function (b) {
          var on = b.getAttribute('data-tab') === id;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
          b.setAttribute('tabindex', on ? '0' : '-1');
        });
        Array.prototype.slice.call(container.children).forEach(function (p) {
          var on = p.id === id;
          p.classList.toggle('active', on);
          p.setAttribute('role', 'tabpanel');
          p.setAttribute('aria-hidden', on ? 'false' : 'true');
        });
        refreshAutoGrow("#" + id);
        saved[groupName] = id;
        try { localStorage.setItem(LS_TAB, JSON.stringify(saved)); } catch (e) { /* ignore */ }
        if (id === 'tab-json') renderPreview();
      }
      buttons.forEach(function (b) { b.addEventListener('click', function () { activate(b.getAttribute('data-tab')); }); });
      group._activate = activate;
      var initial = saved[groupName];
      if (!initial || !document.getElementById(initial)) initial = buttons[0].getAttribute('data-tab');
      activate(initial);
    });
  }

  function setFormTab(id) {
    var g = document.querySelector('[data-tabs="form"]');
    if (g && g._activate && document.getElementById(id)) g._activate(id);
  }

  function bindShortcuts() {
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      var modalOpen = $('#pasteModal') && !$('#pasteModal').hidden;
      // 粘贴解析：Ctrl+Shift+V（模态打开时改为直接解析）
      if (e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault();
        if (modalOpen) runPasteParse();
        else openPasteModal();
        return;
      }
      if (modalOpen) return; // 模态打开时不抢占 Ctrl+S / Ctrl+Enter / 切页
      var k = e.key;
      if (k >= '1' && k <= '7') {
        e.preventDefault();
        setFormTab(FORM_TABS[parseInt(k, 10) - 1]);
      } else if (k.toLowerCase() === 's') {
        e.preventDefault();
        exportJson();
      } else if (k === 'Enter') {
        e.preventDefault();
        generatePng();
      }
    });
  }

  /* ================= 全量渲染 ================= */

  function renderAll() {
    syncFieldsToForm();
    renderWorks();
    renderRules();
    bkMode = 'card';
    renderBookList();
    renderCatFilter();
    renderLibList();
    syncLibToForm();
    renderGreetings();
    renderRegex();
    renderHelper();
    renderUiEditor();
    previewIdx = Math.min(previewIdx, card.alternate_greetings.length);
    renderChatPreview();
    renderHealth();
    renderJsonIfVisible();
  }


  /* ================= 界面主题（日间 / 夜间） ================= */
  var LS_THEME = 'stCardForgeTheme_v1';

  function getUiTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return (t === 'day' || t === 'night') ? t : 'night';
  }

  function applyUiTheme(theme, persist) {
    var t = (theme === 'day') ? 'day' : 'night';
    document.documentElement.setAttribute('data-theme', t);
    var nightBtn = $('#btnThemeNight');
    var dayBtn = $('#btnThemeDay');
    if (nightBtn) nightBtn.setAttribute('aria-pressed', t === 'night' ? 'true' : 'false');
    if (dayBtn) dayBtn.setAttribute('aria-pressed', t === 'day' ? 'true' : 'false');
    if (persist !== false) {
      try { localStorage.setItem(LS_THEME, t); } catch (e) { /* ignore */ }
    }
  }

  function bindUiTheme() {
    applyUiTheme(getUiTheme(), false);
    var nightBtn = $('#btnThemeNight');
    var dayBtn = $('#btnThemeDay');
    if (nightBtn) nightBtn.addEventListener('click', function () { applyUiTheme('night'); });
    if (dayBtn) dayBtn.addEventListener('click', function () { applyUiTheme('day'); });
  }

  /* ================= 启动 ================= */

  function init() {
    bindFields();
    bindTabs();
    bindShortcuts();
    bindCustomTpl();
    bindRules();
    bindTone();
    bindBook();
    bindLib();
    bindSaveSettings();
    bindImport();
    bindDrop();
    bindCover();
    bindAvatar();
    bindUi();
    bindPasteParse();
    bindUiTheme();

    ['#newEntryCat', '#libNewCat'].forEach(function (sel) {
      var el = $(sel);
      M.CATEGORIES.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c; o.textContent = c;
        el.appendChild(o);
      });
      el.value = '地理';
    });

    var ruleTarget = $('#rule-target');
    M.RULE_TARGETS.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.v; o.textContent = t.t;
      ruleTarget.appendChild(o);
    });

    $('#btnPrevGreet').addEventListener('click', function () { cycleGreeting(-1); });
    $('#btnNextGreet').addEventListener('click', function () { cycleGreeting(1); });
    $('#cbRenderHtml').addEventListener('change', renderChatPreview);
    $('#cbRegexPreview').addEventListener('change', renderChatPreview);

    $('#btnExportJson').addEventListener('click', exportJson);
    $('#btnGenPng').addEventListener('click', generatePng);
    $('#btnCopyJson').addEventListener('click', async function () {
      var ok = await copyText(JSON.stringify(M.toExportBundle(card, { spec: card.spec }).primary, null, 2));
      toast(ok ? 'JSON 已复制到剪贴板' : '复制失败，请手动从预览框复制', ok ? 'ok' : 'err');
    });

    $('#btnSaveExtras').addEventListener('click', saveRawExtras);
    bindHelper();

    $('#btnNewWork').addEventListener('click', function () { createWork(false); });
    $('#btnDupWork').addEventListener('click', function () { createWork(true); });
    $('#btnDelWork').addEventListener('click', deleteWork);

    $('#btnSaveArchive').addEventListener('click', saveArchive);
    $('#btnPickArchiveDir').addEventListener('click', pickArchiveDir);
    $('#btnRestoreArchive').addEventListener('click', function () { $('#archiveFile').click(); });
    $('#archiveFile').addEventListener('change', async function () {
      if (!this.files || !this.files[0]) return;
      restoreFromMdText(await this.files[0].text(), this.files[0].name);
      this.value = '';
    });

    $('#btnAddGreeting').addEventListener('click', function () { card.alternate_greetings.push(''); renderGreetings(); touch(); });
    $('#btnAddGroupGreeting').addEventListener('click', function () { card.group_only_greetings.push(''); renderGreetings(); touch(); });
    $('#btnAddRegex').addEventListener('click', function () {
      card.extensions.regex_scripts.push(M.normalizeRegex({ scriptName: '新脚本', placement: [2] }));
      renderRegex(); touch();
    });
    $('#btnAddRegexHide').addEventListener('click', function () {
      card.extensions.regex_scripts.push(M.normalizeRegex({
        scriptName: '隐藏思维链与内部标签（仅显示）',
        findRegex: '/<(think|thinking|UpdateVariable)>[\\s\\S]*?<\\/\\1>/gi',
        replaceString: '', placement: [2], markdownOnly: true, promptOnly: false, runOnEdit: true
      }));
      renderRegex(); touch();
      toast('已添加「隐藏标签」：只影响显示，不改变发给模型的内容', 'ok', 4200);
    });
    $('#btnAddRegexStatus').addEventListener('click', function () {
      card.extensions.regex_scripts.push(M.normalizeRegex({
        scriptName: '状态栏标签渲染为代码块',
        findRegex: '/<StatusBar>([\\s\\S]*?)<\\/StatusBar>/gi',
        replaceString: '```\n$1\n```', placement: [2], markdownOnly: true, promptOnly: false, runOnEdit: true
      }));
      renderRegex(); touch();
      toast('已添加「状态栏标签」模板，可按你的标签名修改', 'ok', 4200);
    });

    $('#btnAiGen').addEventListener('click', aiGenerate);
    loadAiConfig();

    renderAll();
    loadWorks().then(function (restored) {
      var w = currentWork();
      card = w ? w.card : M.emptyCard();
      if (!card.rules) card.rules = [];
      if (!card.tone) card.tone = M.emptyTone();
      renderAll();
      if (restored) toast('已载入本机作品库', 'ok', 2600);
      saveWorks();
    });
    loadLibBooks().then(function (has) {
      if (!has) {
        // 首次使用：建一本默认世界书，方便直接体验独立世界书流程
        var nb = M.emptyBook();
        libBooks.items.push({ id: newWorkId(), name: '未命名世界书', scan_depth: nb.scan_depth, token_budget: nb.token_budget, recursive_scanning: false, entries: nb.entries, extensions: {}, raw: {}, updatedAt: Date.now() });
        libBooks.activeId = libBooks.items[0].id;
        saveLibBooks();
      }
      renderLibList();
      syncLibToForm();
    });
    idbGet('avatar').catch(function () { return null; }).then(function (av) {
      if (av && av.bytes && !avatarBytes) setAvatar(new Uint8Array(av.bytes), av.name || 'avatar', false);
    });
    initArchive();
  }

  document.addEventListener('DOMContentLoaded', init);
})();