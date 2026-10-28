/*
 * card-model.js —— 酒馆「世界观卡」数据模型（纯函数，无 DOM，浏览器 / Node 双端可用）
 *
 * 卡的核心是「世界」：叙事者设定 + 世界总纲 + 当前处境 + 开局场景 + 内嵌世界书（character_book）
 * + 界面正则（状态栏等）。本文件负责：归一化、导入导出、无损往返、原生世界书互转、关键词触发测试。
 *
 * 浏览器：<script src="card-model.js"></script> → 全局 CardModel
 * Node：  const CardModel = require('./card-model.js')
 */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.CardModel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 世界书条目位置（ST 原生枚举）：0 角色定义前 1 角色定义后 2 作者注释前 3 作者注释后 4 按深度
  var POSITIONS = [
    { v: 0, t: '角色定义之前' },
    { v: 1, t: '角色定义之后' },
    { v: 2, t: '作者注释之前' },
    { v: 3, t: '作者注释之后' },
    { v: 4, t: '按深度插入' }
  ];
  var CHAR_POS = { before_char: 0, after_char: 1, before_an: 2, after_an: 3, at_depth: 4 };

  // 次级关键词逻辑（ST 原生枚举）
  var SELECTIVE_LOGIC = [
    { v: 0, t: '任一次级命中即可（AND ANY）' },
    { v: 1, t: '非全部次级命中才注入（NOT ALL）' },
    { v: 2, t: '次级都不命中才注入（NOT ANY）' },
    { v: 3, t: '全部次级命中才注入（AND ALL）' }
  ];

  var ROLE_OPTIONS = [
    { v: 'system', t: 'system' }, { v: 'user', t: 'user' }, { v: 'assistant', t: 'assistant' }
  ];

  // 世界书条目的推荐分类（写在 comment 开头 【分类】名称）
  var CATEGORIES = ['世界观', '地理', '势力', '历史', '人物', '物品', '规则', '事件', '其他'];

  // 条例可以注入的字段（导出时把启用的条例拼接进对应字段）
  var RULE_TARGETS = [
    { v: 'description', t: '世界总纲' },
    { v: 'post_history_instructions', t: '历史后指令（权重最高）' },
    { v: 'system_prompt', t: '系统提示' }
  ];

  // 内置条例库：用户可从中添加，也可删除或自行新建
  var RULE_LIBRARY = [
    { key: 'no-act', title: '不替玩家行动', target: 'post_history_instructions', body: '只描写世界与 NPC 的反应，绝不代替玩家做决定、发言或描写其内心。' },
    { key: 'consistent', title: '设定一致', target: 'description', body: '世界规则、人物身份与已发生的事件必须前后一致，不得无故改写设定。' },
    { key: 'small-step', title: '小步推进', target: 'post_history_instructions', body: '每次只推进一小段剧情，不跳跃时间线，结尾留出玩家的选择空间。' },
    { key: 'causality', title: '后果有因果', target: 'description', body: '玩家的选择会改变势力关系与世界状态，行动的代价需要被呈现。' },
    { key: 'npc-will', title: 'NPC 有独立意志', target: 'description', body: 'NPC 拥有自己的立场与目标，不因玩家的意愿无条件让步或迎合。' },
    { key: 'sensory', title: '感官细节', target: 'description', body: '环境描写优先选择气味、温度、声音等可直接感知的细节，避免空泛形容。' },
    { key: 'length', title: '篇幅节奏', target: 'post_history_instructions', body: '单次回复控制在合适篇幅，动作、环境与对白交替，结尾给出悬念或选择。' },
    { key: 'status', title: '状态栏更新', target: 'post_history_instructions', body: '若开局包含状态栏，每次回复末尾按原格式更新状态栏，数值变化需有依据。' },
    { key: 'no-timeskip', title: '不擅自跳时间', target: 'description', body: '不擅自转换场景或跳过时间，场景切换需由剧情自然引出。' },
    { key: 'name', title: '称呼统一', target: 'description', body: '同一角色的称呼、头衔与语气保持统一，除非剧情中有明确理由。' },
    { key: 'no-meta', title: '不打破第四面墙', target: 'post_history_instructions', body: '不在叙述中提及模型、提示词或系统规则，保持世界内视角。' },
    { key: 'choice', title: '保留选择权', target: 'post_history_instructions', body: '关键抉择交给玩家，讲述者只呈现局势与可选方向。' }
  ];
  var DEFAULT_RULE_KEYS = ['no-act', 'consistent'];

  // 文风基调选项
  var TONE_PRESETS = [
    { id: 'cold', t: '冷峻写实', d: '克制客观，少形容，多动作与环境细节，不做情绪判断' },
    { id: 'epic', t: '史诗宏大', d: '语势开阔，强调命运、历史与群体的重量，句式有节奏感' },
    { id: 'warm', t: '温情细腻', d: '关注人物的小动作与心理变化，语气柔和，留白多' },
    { id: 'mystery', t: '悬疑诡异', d: '渲染不确定感，线索零散，描写中埋下异常细节' },
    { id: 'humor', t: '轻松幽默', d: '口语化，允许吐槽与俏皮话，节奏明快' },
    { id: 'gothic', t: '古典雅致', d: '措辞典雅，意象丰富，偏好比喻与节令景物' },
    { id: 'grim', t: '黑暗压抑', d: '氛围沉重，代价真实，不回避残酷后果' },
    { id: 'slice', t: '日常生活', d: '贴近生活细节，事件小而具体，节奏舒缓' }
  ];
  var TONE_OPTIONS = {
    person: ['第二人称（你）', '第三人称（他/她）', '第一人称（我）'],
    tense: ['过去时', '现在时'],
    length: ['精炼（100-200 字）', '适中（200-400 字）', '详尽（400-700 字）'],
    dialogue: ['以叙述为主', '对白与叙述均衡', '以对白为主'],
    pace: ['慢热铺垫', '节奏适中', '快节奏推进']
  };

  // 扩展字段中由本工具专门管理的键（其余键归入「原生扩展」编辑区）
  var EXT_MANAGED = ['talkativeness', 'fav', 'depth_prompt', 'regex_scripts', 'world', 'wc_source', 'tavern_helper'];

  /* ---------------- 智能粘贴解析 ---------------- */

  // 卡片字段的常见中文/英文标签
  var PASTE_FIELD_LABELS = [
    { field: 'name', keys: ['角色名', '角色名称', '名字', '名称', '作品名', '世界名', 'name', 'char name'] },
    { field: 'description', keys: ['核心设定', '角色设定', '世界总纲', '总纲', '人设', '简介', '描述', '设定', '外貌', 'description'] },
    { field: 'personality', keys: ['性格', '个性', '性格特点', 'personality'] },
    { field: 'scenario', keys: ['世界当前情况', '当前处境', '故事背景', '场景', '背景', '情境', 'scenario'] },
    { field: 'first_mes', keys: ['开场白', '首条消息', '首次对话', '第一句', '开局', 'first_mes', 'greeting'] },
    { field: 'mes_example', keys: ['对话示例', '示例对话', '样例', '示例', 'mes_example', 'example'] },
    { field: 'creator_notes', keys: ['作者备注', '使用说明', '备注', '说明', 'creator_notes'] },
    { field: 'system_prompt', keys: ['系统提示', '系统指令', 'system_prompt'] },
    { field: 'post_history_instructions', keys: ['历史后指令', '后置指令', '输出条例', 'post_history_instructions'] },
    { field: 'creator', keys: ['作者', '制作者', 'creator'] },
    { field: 'character_version', keys: ['版本', '版本号', 'character_version', 'version'] },
    { field: 'tags', keys: ['标签', 'tag', 'tags'] }
  ];
  // 世界书条目的分类标签
  var PASTE_ENTRY_LABELS = [
    { cat: '地理', keys: ['地点', '地理', '位置', '地区', '城市', '地图', '场景地'] },
    { cat: '势力', keys: ['势力', '组织', '门派', '阵营', '国家', '家族', '势力设定'] },
    { cat: '人物', keys: ['人物', '角色', 'npc', '配角', '人物设定', 'npc设定'] },
    { cat: '物品', keys: ['物品', '道具', '装备', '宝物', '武器', '物品设定'] },
    { cat: '规则', keys: ['规则', '法则', '机制', '世界规则', '玩法', '系统规则'] },
    { cat: '历史', keys: ['历史', '背景故事', '编年史', '往事', '史料'] },
    { cat: '事件', keys: ['事件', '剧情', '任务', '事件设定', '桥段'] },
    { cat: '世界观', keys: ['世界观', '世界设定', '世界', 'world', '世界观设定'] }
  ];
  // 备用开局的标签
  var PASTE_GREETING_LABELS = ['备用开场白', '备用开局', '第二开局', '开局二', '开场白2', '开场白二', 'alternate greeting', 'alternate_greetings'];

  function normLabel(s) {
    return str(s).toLowerCase().replace(/[\s_\-—－·:：]/g, '');
  }

  // 标签 → 卡片字段
  function labelToField(label) {
    var n = normLabel(label);
    if (!n) return null;
    var i, j, g, k;
    for (i = 0; i < PASTE_FIELD_LABELS.length; i++) {
      g = PASTE_FIELD_LABELS[i];
      for (j = 0; j < g.keys.length; j++) {
        if (n === normLabel(g.keys[j])) return g.field;
      }
    }
    for (i = 0; i < PASTE_FIELD_LABELS.length; i++) {
      g = PASTE_FIELD_LABELS[i];
      for (j = 0; j < g.keys.length; j++) {
        k = normLabel(g.keys[j]);
        if (k.length >= 2 && n.indexOf(k) !== -1) return g.field;
      }
    }
    return null;
  }
  // 标签 → 世界书分类
  function labelToCategory(label) {
    var n = normLabel(label);
    if (!n) return null;
    var i, j, g, k;
    for (i = 0; i < PASTE_ENTRY_LABELS.length; i++) {
      g = PASTE_ENTRY_LABELS[i];
      for (j = 0; j < g.keys.length; j++) {
        if (n === normLabel(g.keys[j])) return g.cat;
      }
    }
    for (i = 0; i < PASTE_ENTRY_LABELS.length; i++) {
      g = PASTE_ENTRY_LABELS[i];
      for (j = 0; j < g.keys.length; j++) {
        k = normLabel(g.keys[j]);
        if (k.length >= 2 && n.indexOf(k) !== -1) return g.cat;
      }
    }
    return null;
  }
  function isGreetingLabel(label) {
    var n = normLabel(label);
    return PASTE_GREETING_LABELS.some(function (k) {
      var nk = normLabel(k);
      return n === nk || n.indexOf(nk) !== -1;
    });
  }
  // 带序号的标题，如「开场白1」「开局 二」→ 序号
  function labelIndex(label) {
    var m = /(\d+)/.exec(str(label));
    if (m) return parseInt(m[1], 10);
    var cn = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    var m2 = /([一二三四五六七八九十])/.exec(str(label));
    return m2 && cn[m2[1]] ? cn[m2[1]] : 0;
  }

  // 从条目内容里提取显式关键词
  function extractKeys(title, content) {
    var m = /(?:关键词|触发词|关键字|keys?)\s*[：:]\s*([^\n]+)/i.exec(content);
    if (m) {
      var list = toList(m[1]);
      if (list.length) return list;
    }
    var t = str(title).replace(/^\s*【[^】]{1,8}】\s*/, '').trim();
    return t ? [t] : [];
  }


  // 是否是已知标签（用于区分「标签：内容」与条目内的子标题，如「位置：xxx」）
  var ALL_KNOWN_LABELS = (function () {
    var set = {};
    function add(k) { set[normLabel(k)] = true; }
    PASTE_FIELD_LABELS.forEach(function (g) { g.keys.forEach(add); });
    PASTE_ENTRY_LABELS.forEach(function (g) { g.keys.forEach(add); });
    PASTE_GREETING_LABELS.forEach(add);
    return set;
  })();
  function isKnownLabel(s) {
    var n = normLabel(s);
    if (!n) return false;
    if (ALL_KNOWN_LABELS[n]) return true;
    var keys = Object.keys(ALL_KNOWN_LABELS);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].length >= 2 && n.indexOf(keys[i]) !== -1) return true;
    }
    return false;
  }

  // 把文本切成「标签 + 内容」块
  function splitBlocks(text) {
    var lines = text.split('\n');
    var blocks = [];
    var cur = null;
    function push() {
      if (cur) {
        cur.content = cur.lines.join('\n').replace(/^\n+|\n+$/g, '');
        if (cur.label || cur.content) blocks.push(cur);
      }
      cur = null;
    }
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      var label = null, rest = '';
      var m;
      if ((m = /^#{1,6}\s*(.+)$/.exec(line))) { label = m[1].trim(); }
      else if ((m = /^【\s*([^】]{1,14})\s*】\s*(.*)$/.exec(line))) { label = m[1].trim(); rest = m[2]; }
      else if ((m = /^\[([^\]\[]{1,14})\]\s*(.*)$/.exec(line))) { label = m[1].trim(); rest = m[2]; }
      else if ((m = /^<([A-Za-z][A-Za-z0-9_\-]{1,20})>\s*(.*)$/.exec(line))) { label = m[1].trim(); rest = m[2]; }
      else if ((m = /^([^：:【\[#<>]{1,14})[：:]\s*(.*)$/.exec(line)) && (labelToField(m[1].trim()) || isGreetingLabel(m[1].trim()))) { label = m[1].trim(); rest = m[2]; }
      if (label) {
        push();
        cur = { label: label, lines: [] };
        if (rest) cur.lines.push(rest);
      } else if (cur) {
        cur.lines.push(raw);
      } else if (line.trim()) {
        cur = { label: '', lines: [raw] };
      }
    });
    push();
    return blocks;
  }

  // 长内容按空段拆成多条（把一大段设定拆成多个条目）
  function splitLongContent(content, maxLen) {
    maxLen = maxLen || 700;
    var s = str(content);
    if (s.length <= maxLen) return [s];
    var paras = s.split(/\n\s*\n/).filter(function (p) { return p.trim(); });
    if (paras.length < 2) return [s];
    var out = [], buf = '';
    paras.forEach(function (p) {
      if (buf && (buf + '\n\n' + p).length > maxLen) { out.push(buf); buf = p; }
      else { buf = buf ? buf + '\n\n' + p : p; }
    });
    if (buf) out.push(buf);
    return out;
  }

  /**
   * 解析粘贴的文本
   * opts: { splitLong: bool }
   * 返回 { ok, kind, fields, entries, notes }；kind: 'json'|'card'|'book'|'mixed'|'unknown'
   */
  function parsePastedText(text, opts) {
    opts = opts || {};
    var t = str(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!t) return { ok: false, error: '内容为空' };
    var notes = [];

    // 1) JSON 直接走既有导入逻辑
    var trimmed = t.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
    if (/^[[{]/.test(trimmed)) {
      try {
        var obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') {
          if (looksLikeNativeBook(obj)) {
            return { ok: true, kind: 'book', nativeBook: parseNativeBook(obj), notes: ['识别为 JSON 世界书'] };
          }
          if (obj.spec || obj.data || obj.name || obj.first_mes || obj.description) {
            return { ok: true, kind: 'json', card: obj, notes: ['识别为 JSON 角色卡'] };
          }
        }
      } catch (e) { /* 不是合法 JSON，继续按文本解析 */ }
    }

    var blocks = splitBlocks(t);
    var fields = {};
    var entries = [];
    var greetings = [];
    var unknown = [];
    var blockPos = 0;

    blocks.forEach(function (b) {
      var label = b.label || '';
      var content = b.content;
      if (!content.trim() && !label) return;

      if (isGreetingLabel(label)) {
        greetings.push({ index: labelIndex(label), pos: blockPos++, content: content });
        return;
      }
      var f = labelToField(label);
      if (f === 'first_mes') {
        var gi = labelIndex(label);
        if (gi && gi > 1) { greetings.push({ index: gi, content: content }); return; }
        fields.first_mes = fields.first_mes ? fields.first_mes + '\n\n' + content : content;
        return;
      }
      if (f) {
        if (f === 'tags') fields.tags = toList(content);
        else fields[f] = fields[f] ? fields[f] + '\n\n' + content : content;
        return;
      }
      var cat = labelToCategory(label);
      if (cat && content.trim()) {
        var body = content;
        // 标题：标签去掉分类前缀；若为空则取内容首行（如「【地点】北境要塞」）
        var catKeys = ((PASTE_ENTRY_LABELS.filter(function (g) { return g.cat === cat; })[0] || {}).keys || []).concat([cat]);
        var rawLabel = str(label).trim();
        var title = rawLabel;
        for (var ci = 0; ci < catKeys.length; ci++) {
          if (title.indexOf(catKeys[ci]) === 0) { title = title.slice(catKeys[ci].length); break; }
        }
        title = title.replace(/^[（(【\[].*[）)\]】]\s*/, '').trim();
        if (!title) {
          var firstLine = body.split('\n')[0].trim();
          if (firstLine && firstLine.length <= 30 && !/[。！？.!?]$/.test(firstLine)) {
            title = firstLine;
            body = body.split('\n').slice(1).join('\n').replace(/^\n+/, '');
          }
        }
        if (!title) title = cat;
        var parts = opts.splitLong ? splitLongContent(body) : [body];
        parts.forEach(function (p, i) {
          entries.push(normalizeEntry({
            comment: withCategory(cat, title + (parts.length > 1 ? '（' + (i + 1) + '）' : '')),
            keys: extractKeys(title, p),
            content: p,
            insertion_order: (entries.length + 1) * 10
          }));
        });
        return;
      }
      if (content.trim() || label) unknown.push({ label: label, content: content });
    });

    // 开场白归位：第一个作主开局，其余作备用
    if (greetings.length) {
      greetings.sort(function (a, b) {
        var ia = a.index || a.pos + 1, ib = b.index || b.pos + 1;
        return ia - ib;
      });
      if (!str(fields.first_mes).trim()) fields.first_mes = greetings.shift().content;
      greetings.forEach(function (g) {
        fields.__greetings = fields.__greetings || [];
        fields.__greetings.push(g.content);
      });
    }

    // 未识别内容：单个且较长 → 世界总纲；多个 → 各成条目
    if (unknown.length) {
      if (unknown.length === 1 && unknown[0].content.length > 200 && !fields.description) {
        fields.description = unknown[0].content;
        notes.push('未识别的大段文本已放入「世界总纲」');
      } else {
        unknown.forEach(function (u) {
          if (!u.content.trim()) return;
          entries.push(normalizeEntry({
            comment: withCategory('', u.label || '未分类片段'),
            keys: extractKeys(u.label, u.content),
            content: u.content,
            insertion_order: (entries.length + 1) * 10
          }));
        });
        if (entries.length) notes.push('有 ' + unknown.length + ' 段未识别标签的文本，已按「未分类片段」存为世界书条目');
      }
    }

    var hasCard = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes']
      .some(function (k) { return str(fields[k]).trim(); });
    var kind = hasCard && entries.length ? 'mixed' : (hasCard ? 'card' : (entries.length ? 'book' : 'unknown'));

    if (kind === 'unknown') {
      return { ok: false, error: '没有识别出结构化内容', notes: notes, fields: fields, entries: entries };
    }
    return { ok: true, kind: kind, fields: fields, entries: entries, notes: notes };
  }

  /* ---------------- 统一前端（HTML 面板模板） ---------------- */

  var UI_PLACEHOLDER = '<WorldPanel/>';
  var UI_REGEX_ID = 'wcui-panel';

  var UI_THEMES = [
    { id: 'aurora', t: '极光紫', c: { from: '#161a2b', to: '#241a46', border: '#5b5fb8', text: '#e2e4ff', accent: '#aab0e0' } },
    { id: 'ember', t: '余烬橙', c: { from: '#2a1710', to: '#3d1f10', border: '#b3693a', text: '#ffe6d2', accent: '#e8b48c' } },
    { id: 'ocean', t: '深海蓝', c: { from: '#0d1a2b', to: '#102539', border: '#3a6f9e', text: '#d6e8f7', accent: '#9dc3e0' } },
    { id: 'forest', t: '林间绿', c: { from: '#101f18', to: '#14291d', border: '#3f7d5c', text: '#d8f0e2', accent: '#9ccfb4' } },
    { id: 'rose', t: '蔷薇粉', c: { from: '#2b1620', to: '#3a1b2a', border: '#a85c7d', text: '#f7dbe8', accent: '#e0a8c2' } },
    { id: 'mono', t: '素白', c: { from: '#f7f7f9', to: '#ececf1', border: '#c8c8d2', text: '#2a2a35', accent: '#6a6a7a' } }
  ];

  var UI_TEMPLATES = [
    { id: 'status', t: '状态栏', d: '时间 / 地点 / 局势等信息，适合每回合更新' },
    { id: 'opening', t: '开局面板', d: '标题 + 选项按钮，让玩家选择故事入口' },
    { id: 'world', t: '世界信息面板', d: '多个区块，每区一个标题与若干行' },
    { id: 'minimal', t: '简约条', d: '单行文字，最轻量' }
  ];

  function uiTheme(id) {
    return UI_THEMES.filter(function (t) { return t.id === id; })[0] || UI_THEMES[0];
  }
  function uiTemplate(id) {
    return UI_TEMPLATES.filter(function (t) { return t.id === id; })[0] || UI_TEMPLATES[0];
  }

  function uiEsc(s) {
    return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 各模板的默认配置
  function defaultUi(template) {
    var t = uiTemplate(template);
    var base = {
      enabled: true,
      template: t.id,
      theme: 'aurora',
      colors: clone(uiTheme('aurora').c),
      title: t.t,
      subtitle: '',
      layout: t.id === 'status' ? 'grid' : 'row',
      displayOnly: t.id !== 'opening',
      inGreetings: false,
      fields: [],
      options: [],
      sections: []
    };
    if (t.id === 'status') {
      base.title = '状态栏';
      base.fields = [
        { icon: '⏰', label: '时间', value: '{{date}} {{time}}' },
        { icon: '📍', label: '地点', value: '（当前位置）' },
        { icon: '🧭', label: '局势', value: '（当前态势）' },
        { icon: '🎯', label: '目标', value: '（当前目标）' }
      ];
    } else if (t.id === 'opening') {
      base.title = '开局选择';
      base.subtitle = '选择一个入口进入世界';
      base.options = ['A. （场景一：身份与处境）', 'B. （场景二：另一时间点或阵营）', 'C. 自定义开局'];
    } else if (t.id === 'world') {
      base.title = '世界信息';
      base.sections = [
        { title: '当前处境', lines: ['（时间与地点）', '（正在发生什么）'] },
        { title: '已知线索', lines: ['（线索一）', '（线索二）'] }
      ];
    } else {
      base.fields = [{ icon: '', label: '', value: '⏰ {{time}}　📍 （当前位置）' }];
    }
    return base;
  }

  function normalizeUi(v) {
    var d = defaultUi(v && v.template);
    if (!v || typeof v !== 'object') return d;
    d.enabled = v.enabled !== false;
    d.template = uiTemplate(v.template).id;
    d.theme = uiTheme(v.theme).id;
    var c = v.colors || {};
    // 未显式指定的颜色回落到主题色
    var themeC = uiTheme(d.theme).c;
    ['from', 'to', 'border', 'text', 'accent'].forEach(function (k) { d.colors[k] = str(c[k]) || themeC[k]; });
    d.title = str(v.title);
    d.subtitle = str(v.subtitle);
    if (['row', 'grid', 'list'].indexOf(v.layout) !== -1) d.layout = v.layout;
    d.displayOnly = v.displayOnly !== false;
    d.inGreetings = !!v.inGreetings;
    d.fields = (Array.isArray(v.fields) ? v.fields : []).map(function (f) {
      return { icon: str(f && f.icon), label: str(f && f.label), value: str(f && f.value) };
    });
    d.options = (Array.isArray(v.options) ? v.options : []).map(str).filter(function (s) { return s.trim(); });
    d.sections = (Array.isArray(v.sections) ? v.sections : []).map(function (s) {
      return { title: str(s && s.title), lines: (Array.isArray(s && s.lines) ? s.lines : []).map(str) };
    });
    return d;
  }

  // 由配置生成完整 HTML（自包含，无外部依赖）
  // 设计要点：渐变外框 + 内容面板，保证文字在渐变背景上依然清晰；标签/数值分层，便于快速阅读
  function renderUiTemplate(cfg) {
    var ui = normalizeUi(cfg);
    var c = ui.colors;
    var font = '"Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif';
    var frame = 'border-radius:16px;padding:1px;background:linear-gradient(135deg,' + c.accent + ',' + c.border + ');';
    var panel = 'border-radius:15px;padding:15px 17px;background:linear-gradient(135deg,' + c.from + ',' + c.to + ');color:' + c.text + ';font-family:' + font + ';font-size:0.95em;line-height:1.85;';
    var out = [];
    var isStatus = ui.template === 'status' || ui.template === 'minimal';

    if (isStatus) {
      var items = ui.fields.filter(function (f) { return f.value.trim() || f.label.trim(); });
      out.push('<div style="' + frame + '">');
      out.push('<div style="' + panel + '">');
      if (ui.title) {
        out.push('<div style="display:flex;align-items:center;gap:9px;margin-bottom:11px;">');
        out.push('<span style="flex:none;width:4px;height:15px;border-radius:2px;background:' + c.accent + ';"></span>');
        out.push('<span style="font-weight:700;font-size:1.06em;letter-spacing:.6px;color:' + c.accent + ';">' + uiEsc(ui.title) + '</span>');
        out.push('</div>');
      }
      if (ui.template === 'minimal') {
        // 简约条：单行，用间隔点分隔
        var cells = items.map(function (f) {
          var lb = f.label ? '<span style="opacity:.7;">' + uiEsc(f.label) + '</span> ' : '';
          return lb + '<span style="font-weight:600;">' + uiEsc(f.value) + '</span>';
        });
        out.push('<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;">' + cells.join('<span style="opacity:.35;">\u00b7</span>') + '</div>');
      } else if (ui.layout === 'list') {
        // 每行一条：标签淡、数值亮，带分隔线
        items.forEach(function (f) {
          var lb = (f.icon ? f.icon + ' ' : '') + (f.label ? uiEsc(f.label) : '');
          out.push('<div style="display:flex;align-items:baseline;gap:12px;padding:5px 0;border-bottom:1px solid ' + c.border + '33;">');
          if (lb) out.push('<span style="flex:none;opacity:.72;font-size:.92em;">' + lb + '</span>');
          out.push('<span style="flex:1;font-weight:600;">' + uiEsc(f.value) + '</span>');
          out.push('</div>');
        });
      } else {
        // 一行横排 / 两列网格：标签固定宽度左对齐，数值加粗，便于扫读
        var cols = ui.layout === 'grid' ? 'repeat(2,minmax(0,1fr))' : 'none';
        out.push('<div style="display:grid;grid-template-columns:' + cols + ';gap:2px 20px;">');
        items.forEach(function (f) {
          var lb = (f.icon ? f.icon + ' ' : '') + (f.label ? uiEsc(f.label) : '');
          out.push('<div style="display:flex;align-items:baseline;gap:10px;padding:4px 0;min-width:0;">');
          if (lb) out.push('<span style="flex:none;min-width:4.5em;opacity:.72;font-size:.92em;">' + lb + '</span>');
          out.push('<span style="flex:1;font-weight:600;min-width:0;">' + uiEsc(f.value) + '</span>');
          out.push('</div>');
        });
        out.push('</div>');
      }
      out.push('</div></div>');
    } else if (ui.template === 'opening') {
      // 开局面板：标题 + 带字母徽章的选项行
      out.push('<div style="' + frame + '">');
      out.push('<div style="' + panel + 'text-align:center;">');
      if (ui.title) out.push('<div style="font-size:1.3em;font-weight:800;letter-spacing:1.5px;color:' + c.accent + ';">' + uiEsc(ui.title) + '</div>');
      if (ui.subtitle) out.push('<div style="opacity:.75;margin-top:3px;font-size:.94em;">' + uiEsc(ui.subtitle) + '</div>');
      out.push('<div style="display:flex;flex-direction:column;gap:9px;margin-top:14px;text-align:left;">');
      ui.options.forEach(function (o, i) {
        var badge = '<span style="flex:none;width:22px;height:22px;border-radius:7px;background:' + c.accent + ';color:' + c.from + ';font-size:.82em;font-weight:800;display:inline-grid;place-items:center;">' + String.fromCharCode(65 + (i % 26)) + '</span>';
        out.push('<div style="display:flex;align-items:center;gap:11px;border:1px solid ' + c.border + '66;border-radius:11px;padding:10px 13px;background:rgba(255,255,255,.06);">' + badge + '<span style="flex:1;">' + uiEsc(o) + '</span></div>');
      });
      out.push('</div></div></div>');
    } else {
      // 世界信息面板：分区块，每区标题带竖条，内容用圆点列表
      out.push('<div style="' + frame + '">');
      out.push('<div style="' + panel + '">');
      if (ui.title) out.push('<div style="font-weight:800;font-size:1.12em;letter-spacing:.6px;margin-bottom:4px;color:' + c.accent + ';">' + uiEsc(ui.title) + '</div>');
      ui.sections.forEach(function (s) {
        out.push('<div style="margin-top:11px;padding-top:10px;border-top:1px solid ' + c.border + '33;">');
        if (s.title) {
          out.push('<div style="display:flex;align-items:center;gap:7px;font-weight:700;font-size:.98em;color:' + c.accent + ';margin-bottom:3px;">');
          out.push('<span style="flex:none;width:3px;height:12px;border-radius:2px;background:' + c.accent + ';"></span>' + uiEsc(s.title) + '</div>');
        }
        s.lines.filter(function (l) { return l.trim(); }).forEach(function (l) {
          out.push('<div style="display:flex;gap:9px;padding:2px 0;"><span style="flex:none;opacity:.5;">\u2022</span><span style="flex:1;opacity:.94;">' + uiEsc(l) + '</span></div>');
        });
        out.push('</div>');
      });
      out.push('</div></div>');
    }
    return out.join('');
  }

  // 面板要替换成的完整文本（```html 代码块，酒馆会渲染）
  function uiReplaceString(cfg) {
    return '```html\n' + renderUiTemplate(cfg) + '\n```';
  }

  // 把占位符写进开局（不重复插入）
  function ensureUiPlaceholder(card) {
    var ui = card.ui;
    if (!ui || !ui.enabled) return false;
    var changed = false;
    if (str(card.first_mes).indexOf(UI_PLACEHOLDER) === -1) {
      card.first_mes = (str(card.first_mes).replace(/\s+$/, '') + '\n\n' + UI_PLACEHOLDER).replace(/^\n+/, '');
      changed = true;
    }
    if (ui.inGreetings) {
      card.alternate_greetings.forEach(function (g, i) {
        if (str(g).indexOf(UI_PLACEHOLDER) === -1) {
          card.alternate_greetings[i] = (str(g).replace(/\s+$/, '') + '\n\n' + UI_PLACEHOLDER).replace(/^\n+/, '');
          changed = true;
        }
      });
    }
    return changed;
  }

  // 同步「前端」到正则脚本：新增或更新由本工具管理的那一条，不动其他脚本
  function syncUi(card) {
    var ui = card.ui;
    if (!ui || !ui.enabled) return false;
    var list = card.extensions.regex_scripts;
    var repl = uiReplaceString(ui);
    var name = '[前端] ' + uiTemplate(ui.template).t + '渲染';
    var idx = -1;
    list.forEach(function (s, i) { if (s.id === UI_REGEX_ID) idx = i; });
    if (idx === -1) {
      list.push(normalizeRegex({
        id: UI_REGEX_ID, scriptName: name, findRegex: '/<WorldPanel\\/>/g',
        replaceString: repl, placement: [2], markdownOnly: ui.displayOnly !== false,
        promptOnly: false, runOnEdit: true, disabled: false
      }));
      return true;
    }
    list[idx].findRegex = '/<WorldPanel\\/>/g';
    list[idx].replaceString = repl;
    list[idx].markdownOnly = ui.displayOnly !== false;
    if (!str(list[idx].scriptName).trim() || str(list[idx].scriptName).indexOf('[前端]') === 0) list[idx].scriptName = name;
    return true;
  }


  /* ---------------- 酒馆助手脚本（tavern_helper） ---------------- */

  var HELPER_SCRIPT_KEYS = ['id', 'name', 'enabled', 'type', 'content'];

  // tavern_helper 可能是 {scripts:[...], variables:...}，也可能直接是脚本数组；统一取出脚本列表
  function normalizeHelperScript(s) {
    s = s || {};
    return {
      id: str(s.id) || uniqueId(),
      name: str(s.name),
      enabled: s.enabled !== false,
      type: str(s.type) || 'script',
      content: str(s.content),
      extra: pickExtra(s, HELPER_SCRIPT_KEYS)
    };
  }

  function helperScripts(ext) {
    var th = ext && ext.tavern_helper;
    if (!th) return [];
    if (Array.isArray(th)) return th.map(normalizeHelperScript);
    if (Array.isArray(th.scripts)) return th.scripts.map(normalizeHelperScript);
    return [];
  }

  function helperScriptToExport(s) {
    return Object.assign({}, s.extra || {}, {
      id: s.id, name: s.name, enabled: s.enabled, type: s.type, content: s.content
    });
  }

  // 写回时保持原始形态（数组 / 对象），避免破坏酒馆助手读取方式
  function setHelperScripts(ext, list) {
    var th = ext.tavern_helper;
    var scripts = list.map(helperScriptToExport);
    if (Array.isArray(th)) { ext.tavern_helper = scripts; return; }
    if (th && typeof th === 'object') { th.scripts = scripts; return; }
    ext.tavern_helper = { scripts: scripts };
  }

  var ENTRY_KNOWN = ['keys', 'key', 'secondary_keys', 'keysecondary', 'content', 'enabled', 'disable',
    'insertion_order', 'order', 'case_sensitive', 'caseSensitive', 'name', 'priority', 'id', 'uid', 'comment',
    'selective', 'constant', 'position', 'use_regex', 'useRegex', 'depth', 'role', 'roleRaw', 'probability',
    'useProbability', 'scanDepth', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'delayRaw',
    'selectiveLogic', 'matchWholeWords', 'vectorized', 'sticky', 'cooldown', 'delay', 'group',
    'groupWeight', 'groupOverride', 'extensions', 'addMemo', 'ignoreBudget', 'useGroupScoring',
    'outletName', 'automationId', 'triggers', 'characterFilter', 'displayIndex', 'budget',
    'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
    'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes'];

  var REGEX_KNOWN = ['id', 'scriptName', 'name', 'findRegex', 'pattern', 'replaceString', 'trimStrings',
    'placement', 'disabled', 'enabled', 'markdownOnly', 'promptOnly', 'runOnEdit', 'minDepth', 'maxDepth', 'substituteRegex'];

  /* ---------------- 基础工具 ---------------- */

  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
  function num(v, dflt) {
    if (v === '' || v == null) return dflt;
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return isFinite(n) ? n : dflt;
  }
  function toList(v) {
    if (Array.isArray(v)) return v.map(function (x) { return str(x).trim(); }).filter(Boolean);
    if (typeof v === 'string') return v.split(/[,，\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    return [];
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pickExtra(src, known) {
    var out = {};
    Object.keys(src || {}).forEach(function (k) { if (known.indexOf(k) === -1) out[k] = src[k]; });
    return out;
  }
  function uniqueId() { return 'rx' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function toPos(v) {
    if (typeof v === 'number' && isFinite(v)) return Math.max(0, Math.min(4, v | 0));
    var key = str(v).toLowerCase().trim();
    if (key in CHAR_POS) return CHAR_POS[key];
    var n = parseInt(key, 10);
    return isNaN(n) ? 0 : Math.max(0, Math.min(4, n));
  }
  // 导出到 character_book：0/1 沿用社区惯用字符串，其余数字
  function posToCharBook(v) {
    v = toPos(v);
    return v === 0 ? 'before_char' : (v === 1 ? 'after_char' : v);
  }
  function posLabel(v) {
    var p = POSITIONS[toPos(v)];
    return p ? p.t : String(v);
  }

  /* ---------------- 分类（comment 前缀） ---------------- */

  function categoryOf(comment) {
    var m = /^\s*【([^】]{1,8})】/.exec(str(comment));
    return m ? m[1] : '';
  }
  function titleOf(comment) {
    return str(comment).replace(/^\s*【[^】]{1,8}】\s*/, '').trim();
  }
  function withCategory(category, title) {
    var t = str(title).trim();
    if (!category) return t;
    return '【' + category + '】' + t;
  }

  /* ---------------- 世界书条目 ---------------- */

  // role：酒馆同时接受数字（0 system / 1 user / 2 assistant）与字符串；保留原始值用于原生导出
  function normalizeRoleInfo(v) {
    if (v === 0 || v === '0') return { norm: 'system', raw: v };
    if (v === 1 || v === '1') return { norm: 'user', raw: v };
    if (v === 2 || v === '2') return { norm: 'assistant', raw: v };
    if (v === 'user' || v === 'assistant') return { norm: v, raw: v };
    return { norm: 'system', raw: null };
  }

  function normalizeEntry(e) {
    e = e || {};
    var csRaw = e.case_sensitive != null ? e.case_sensitive : e.caseSensitive;
    var roleInfo = normalizeRoleInfo(e.role);
    var idRaw = (e.id != null && e.id !== '') ? e.id : e.uid;
    return {
      // id 为 null 表示未指定（导出时自动分配 uid）；0 是合法 uid
      id: (idRaw == null || idRaw === '') ? null : num(idRaw, null),
      comment: str(e.comment),
      name: str(e.name),
      keys: toList(e.keys != null ? e.keys : e.key),
      secondary_keys: toList(e.secondary_keys != null ? e.secondary_keys : e.keysecondary),
      content: str(e.content),
      enabled: e.enabled !== false && e.disable !== true,
      constant: !!e.constant,
      selective: !!e.selective,
      selectiveLogic: num(e.selectiveLogic, 0),
      position: toPos(e.position),
      depth: num(e.depth, 4),
      role: roleInfo.norm,
      roleRaw: roleInfo.raw,
      insertion_order: num(e.insertion_order != null ? e.insertion_order : e.order, 100),
      priority: num(e.priority, 10),
      probability: num(e.probability, 100),
      useProbability: e.useProbability !== false,
      // 条目预算（部分新版酒馆使用；null = 不限制）
      budget: e.budget == null ? null : num(e.budget, null),
      // null = 继承全局设置（酒馆原生语义，不可改写为 false / 0）
      case_sensitive: csRaw == null ? null : !!csRaw,
      matchWholeWords: e.matchWholeWords == null ? null : !!e.matchWholeWords,
      useGroupScoring: e.useGroupScoring == null ? null : !!e.useGroupScoring,
      sticky: e.sticky == null ? null : num(e.sticky, 0),
      cooldown: e.cooldown == null ? null : num(e.cooldown, 0),
      delay: e.delay == null ? null : num(e.delay, 0),
      scanDepth: (e.scanDepth == null || e.scanDepth === '') ? null : num(e.scanDepth, null),
      use_regex: !!(e.use_regex != null ? e.use_regex : e.useRegex),
      excludeRecursion: !!e.excludeRecursion,
      preventRecursion: !!e.preventRecursion,
      delayUntilRecursion: !!e.delayUntilRecursion,
      delayRaw: e.delayUntilRecursion,
      vectorized: !!e.vectorized,
      group: str(e.group),
      groupWeight: num(e.groupWeight, 100),
      groupOverride: !!e.groupOverride,
      // ---- 酒馆原生世界书字段（独立世界书必备） ----
      addMemo: e.addMemo !== false,
      ignoreBudget: !!e.ignoreBudget,
      outletName: str(e.outletName),
      automationId: str(e.automationId),
      displayIndex: e.displayIndex == null ? null : num(e.displayIndex, null),
      triggers: Array.isArray(e.triggers) ? e.triggers.map(str) : [],
      characterFilter: (e.characterFilter && typeof e.characterFilter === 'object') ? clone(e.characterFilter) : null,
      matchPersonaDescription: !!e.matchPersonaDescription,
      matchCharacterDescription: !!e.matchCharacterDescription,
      matchCharacterPersonality: !!e.matchCharacterPersonality,
      matchCharacterDepthPrompt: !!e.matchCharacterDepthPrompt,
      matchScenario: !!e.matchScenario,
      matchCreatorNotes: !!e.matchCreatorNotes,
      extensions: (e.extensions && typeof e.extensions === 'object') ? e.extensions : {},
      // 其余酒馆字段原样保存，导出时写回
      extra: pickExtra(e, ENTRY_KNOWN)
    };
  }

  function newEntry(category, title, order) {
    return normalizeEntry({
      comment: withCategory(category || '', title || '新条目'),
      keys: [], enabled: true, insertion_order: order || 100
    });
  }

  // 条目 → character_book（V2/V3 卡内嵌）
  function entryToCharBook(e) {
    return Object.assign({}, e.extra || {}, {
      keys: e.keys, secondary_keys: e.secondary_keys, content: e.content,
      enabled: e.enabled, insertion_order: e.insertion_order, case_sensitive: e.case_sensitive,
      name: e.name, priority: e.priority, id: e.id == null ? 0 : e.id, comment: e.comment,
      selective: e.selective, selectiveLogic: e.selectiveLogic, constant: e.constant,
      position: posToCharBook(e.position), use_regex: e.use_regex, depth: e.depth, role: e.role,
      probability: e.probability, useProbability: e.useProbability, scanDepth: e.scanDepth,
      excludeRecursion: e.excludeRecursion, preventRecursion: e.preventRecursion,
      delayUntilRecursion: e.delayUntilRecursion, matchWholeWords: e.matchWholeWords,
      vectorized: e.vectorized, sticky: e.sticky, cooldown: e.cooldown, delay: e.delay,
      group: e.group, groupWeight: e.groupWeight, groupOverride: e.groupOverride,
      // 酒馆原生字段（character_book 与原生世界书同构，写出以保证无损）
      addMemo: e.addMemo, ignoreBudget: e.ignoreBudget, useGroupScoring: e.useGroupScoring,
      outletName: e.outletName, automationId: e.automationId,
      displayIndex: e.displayIndex, triggers: e.triggers || [],
      characterFilter: e.characterFilter,
      matchPersonaDescription: e.matchPersonaDescription,
      matchCharacterDescription: e.matchCharacterDescription,
      matchCharacterPersonality: e.matchCharacterPersonality,
      matchCharacterDepthPrompt: e.matchCharacterDepthPrompt,
      matchScenario: e.matchScenario, matchCreatorNotes: e.matchCreatorNotes,
      budget: e.budget,
      extensions: e.extensions || {}
    });
  }
  // 条目 → ST 原生世界书条目（独立 .json，uid 为键，key/keysecondary/disable 命名）
  function entryToNative(e, uid) {
    return Object.assign({}, e.extra || {}, {
      uid: e.id != null ? e.id : uid,
      key: e.keys, keysecondary: e.secondary_keys, comment: e.comment,
      content: e.content, constant: e.constant, vectorized: e.vectorized,
      selective: e.selective, selectiveLogic: e.selectiveLogic, addMemo: e.addMemo,
      order: e.insertion_order, position: toPos(e.position), disable: !e.enabled,
      excludeRecursion: e.excludeRecursion, preventRecursion: e.preventRecursion,
      delayUntilRecursion: e.delayRaw != null ? e.delayRaw : e.delayUntilRecursion,
      probability: e.probability, useProbability: e.useProbability, depth: e.depth,
      group: e.group, groupOverride: e.groupOverride, groupWeight: e.groupWeight,
      scanDepth: e.scanDepth, caseSensitive: e.case_sensitive, matchWholeWords: e.matchWholeWords,
      useGroupScoring: e.useGroupScoring, automationId: e.automationId, ignoreBudget: e.ignoreBudget,
      outletName: e.outletName,
      matchPersonaDescription: e.matchPersonaDescription,
      matchCharacterDescription: e.matchCharacterDescription,
      matchCharacterPersonality: e.matchCharacterPersonality,
      matchCharacterDepthPrompt: e.matchCharacterDepthPrompt,
      matchScenario: e.matchScenario, matchCreatorNotes: e.matchCreatorNotes,
      role: e.roleRaw != null ? e.roleRaw : e.role,
      sticky: e.sticky, cooldown: e.cooldown, delay: e.delay,
      triggers: e.triggers || [],
      displayIndex: e.displayIndex != null ? e.displayIndex : uid,
      characterFilter: e.characterFilter || { isExclude: false, names: [], tags: [] },
      budget: e.budget
    });
  }

  /* ---------------- 世界书 ---------------- */

  function emptyBook() {
    return { name: '', scan_depth: 2, token_budget: 500, recursive_scanning: false, entries: [], extensions: {}, raw: {} };
  }

  function normalizeBook(bk) {
    bk = bk || {};
    return {
      name: str(bk.name),
      scan_depth: num(bk.scan_depth, 2),
      token_budget: num(bk.token_budget, 500),
      recursive_scanning: !!bk.recursive_scanning,
      entries: (Array.isArray(bk.entries) ? bk.entries : []).map(normalizeEntry),
      extensions: (bk.extensions && typeof bk.extensions === 'object') ? bk.extensions : {},
      raw: (bk.raw && typeof bk.raw === 'object') ? bk.raw : {}
    };
  }

  // 解析 ST 原生世界书：{ entries: {uid: {...}} } 或 { entries: [...] }；不是则返回 null
  function parseNativeBook(obj) {
    var ens = obj && obj.entries;
    if (!ens || typeof ens !== 'object') return null;
    var list = Array.isArray(ens) ? ens : Object.keys(ens).map(function (k) { return ens[k]; });
    list = list.filter(function (x) { return x && typeof x === 'object'; });
    if (!list.length) return null;
    var raw = {};
    Object.keys(obj).forEach(function (k) { if (k !== 'entries' && k !== 'name') raw[k] = obj[k]; });
    return { name: str(obj.name), entries: list.map(normalizeEntry), raw: raw };
  }

  function looksLikeNativeBook(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    if (o.spec || o.data) return false;
    var parsed = parseNativeBook(o);
    if (!parsed) return false;
    var s = parsed.entries[0];
    return !!(s && (s.content || s.keys.length));
  }

  function buildNativeBook(name, entries, raw) {
    var out = {};
    var used = {};
    entries.forEach(function (e, i) {
      // uid 显式指定（含 0）时沿用；未指定或冲突时分配下一个可用正整数，绝不覆盖已有条目
      var uid = (e.id != null && e.id !== '' && !used[e.id]) ? e.id : null;
      if (uid == null) {
        uid = i + 1;
        while (used[uid]) uid++;
      }
      used[uid] = true;
      out[String(uid)] = entryToNative(e, uid);
    });
    return Object.assign({}, raw || {}, { name: name || '未命名世界书', entries: out });
  }

  // 原生世界书 → 内部书对象（保留 uid、原生字段与顶层未知键）
  function bookFromNative(parsed) {
    return {
      name: parsed.name || '',
      scan_depth: 2, token_budget: 500, recursive_scanning: false,
      entries: parsed.entries, extensions: {}, raw: parsed.raw || {}
    };
  }

  function cloneBook(b) { return JSON.parse(JSON.stringify(b)); }

  // 书的统计：分类计数、常驻数、启用数
  function bookStats(book) {
    var byCat = {};
    var constant = 0, enabled = 0;
    book.entries.forEach(function (e) {
      var c = categoryOf(e.comment) || '未分类';
      byCat[c] = (byCat[c] || 0) + 1;
      if (e.constant) constant++;
      if (e.enabled) enabled++;
    });
    return { total: book.entries.length, enabled: enabled, constant: constant, byCategory: byCat };
  }

  /* ---------------- 关键词触发测试 ---------------- */

  function parseRegexSource(src) {
    var m = /^\/([\s\S]+)\/([a-z]*)$/.exec(String(src).trim());
    try {
      if (m) return new RegExp(m[1], m[2].indexOf('g') === -1 ? m[2] + 'g' : m[2]);
      return new RegExp(String(src), 'g');
    } catch (err) { return null; }
  }

  function keyHit(key, text, e) {
    if (!key) return false;
    if (e.use_regex) {
      var re = parseRegexSource(key);
      if (!re) return false;
      re.lastIndex = 0;
      return re.test(text);
    }
    var hay = e.case_sensitive ? text : text.toLowerCase();
    var needle = e.case_sensitive ? key : key.toLowerCase();
    if (!e.matchWholeWords || !/^[\x20-\x7e]+$/.test(needle)) return hay.indexOf(needle) !== -1;
    var esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)').test(hay);
  }

  // 用测试文本模拟酒馆的关键词扫描，返回会被注入的条目及原因
  function scanEntries(entries, text) {
    var hits = [];
    entries.forEach(function (e, idx) {
      if (!e.enabled) return;
      if (e.constant) { hits.push({ index: idx, entry: e, reason: '常驻' }); return; }
      var primary = e.keys.filter(function (k) { return keyHit(k, text, e); });
      if (!primary.length) return;
      if (e.selective && e.secondary_keys.length) {
        var sec = e.secondary_keys.filter(function (k) { return keyHit(k, text, e); }).length;
        var all = e.secondary_keys.length;
        var ok = [sec > 0, sec < all, sec === 0, sec === all][e.selectiveLogic] || false;
        if (!ok) return;
      }
      hits.push({ index: idx, entry: e, reason: '命中：' + primary.join('、') });
    });
    return hits;
  }

  /* ---------------- 正则脚本 ---------------- */

  function normalizeRegex(s) {
    s = s || {};
    var placement = Array.isArray(s.placement) ? s.placement.map(Number).filter(isFinite) : [2];
    if (!placement.length) placement = [2];
    return {
      id: str(s.id) || uniqueId(),
      scriptName: str(s.scriptName != null ? s.scriptName : s.name) || '未命名脚本',
      findRegex: str(s.findRegex != null ? s.findRegex : s.pattern),
      replaceString: str(s.replaceString),
      trimStrings: Array.isArray(s.trimStrings) ? s.trimStrings.map(str) : [],
      placement: placement,
      disabled: s.disabled === true || s.enabled === false,
      markdownOnly: s.markdownOnly !== false,
      promptOnly: !!s.promptOnly,
      runOnEdit: s.runOnEdit !== false,
      minDepth: (s.minDepth == null || s.minDepth === '') ? null : num(s.minDepth, null),
      maxDepth: (s.maxDepth == null || s.maxDepth === '') ? null : num(s.maxDepth, null),
      substituteRegex: num(s.substituteRegex, 0),
      extra: pickExtra(s, REGEX_KNOWN)
    };
  }

  function regexToExport(s) {
    return Object.assign({}, s.extra || {}, {
      id: s.id, scriptName: s.scriptName, findRegex: s.findRegex, replaceString: s.replaceString,
      trimStrings: (s.trimStrings || []).slice(), placement: s.placement.slice(), disabled: s.disabled,
      markdownOnly: s.markdownOnly, promptOnly: s.promptOnly, runOnEdit: s.runOnEdit,
      substituteRegex: s.substituteRegex, minDepth: s.minDepth, maxDepth: s.maxDepth
    });
  }

  // 显示层正则：作用于 AI 输出（placement 2）且不是「仅提示词」的脚本
  // 酒馆语义：markdownOnly = 只影响显示；promptOnly = 只影响提示词；两者都 false = 显示与提示词都改
  function applyDisplayRegex(text, scripts) {
    (scripts || []).forEach(function (s) {
      if (s.disabled || s.placement.indexOf(2) === -1 || s.promptOnly || !s.findRegex) return;
      var re = parseRegexSource(s.findRegex);
      if (re) text = text.replace(re, s.replaceString);
    });
    return text;
  }

  /* ---------------- 宏 ---------------- */

  function applyMacros(text, charName, userName, now) {
    now = now || new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var time = pad(now.getHours()) + ':' + pad(now.getMinutes());
    var date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    return str(text)
      .replace(/\{\{\s*char\s*\}\}/gi, charName || '角色')
      .replace(/\{\{\s*user\s*\}\}/gi, userName || 'User')
      .replace(/\{\{\s*time\s*\}\}/gi, time)
      .replace(/\{\{\s*date\s*\}\}/gi, date)
      .replace(/\{\{\s*original\s*\}\}/gi, '');
  }

  /* ---------------- 卡（card） ---------------- */

  /* ---------------- 条例与文风 ---------------- */

  function normalizeRule(r) {
    r = r || {};
    var target = RULE_TARGETS.some(function (t) { return t.v === r.target; }) ? r.target : 'description';
    return {
      id: str(r.id) || uniqueId(),
      key: str(r.key),
      title: str(r.title).trim() || '未命名条例',
      body: str(r.body),
      target: target,
      enabled: r.enabled !== false
    };
  }

  function newRule(title, body, target) {
    return normalizeRule({ title: title || '自定义条例', body: body || '', target: target || 'description', enabled: true });
  }

  function libraryRule(key) {
    var lib = RULE_LIBRARY.filter(function (x) { return x.key === key; })[0];
    return lib ? normalizeRule(Object.assign({ enabled: true }, lib)) : null;
  }

  function defaultRules() {
    return DEFAULT_RULE_KEYS.map(libraryRule).filter(Boolean);
  }

  function emptyTone() {
    return {
      presets: [],
      person: TONE_OPTIONS.person[0],
      tense: TONE_OPTIONS.tense[0],
      length: TONE_OPTIONS.length[1],
      dialogue: TONE_OPTIONS.dialogue[1],
      pace: TONE_OPTIONS.pace[1],
      custom: ''
    };
  }

  function normalizeTone(t) {
    var base = emptyTone();
    t = t || {};
    var ids = Array.isArray(t.presets) ? t.presets.map(str) : [];
    base.presets = ids.filter(function (id) { return TONE_PRESETS.some(function (p) { return p.id === id; }); });
    ['person', 'tense', 'length', 'dialogue', 'pace'].forEach(function (k) {
      if (TONE_OPTIONS[k].indexOf(t[k]) !== -1) base[k] = t[k];
    });
    base.custom = str(t.custom);
    return base;
  }

  // 文风基调 → 写入 personality 的说明文本
  function toneText(tone) {
    tone = normalizeTone(tone);
    var names = TONE_PRESETS.filter(function (p) { return tone.presets.indexOf(p.id) !== -1; });
    var lines = [];
    if (names.length) {
      lines.push('文风基调：' + names.map(function (p) { return p.t; }).join('、'));
      lines.push(names.map(function (p) { return p.d; }).join('；') + '。');
    }
    lines.push('叙述视角：' + tone.person + '，' + tone.tense + '。');
    lines.push('篇幅：' + tone.length + '；' + tone.dialogue + '；' + tone.pace + '。');
    if (tone.custom.trim()) lines.push('补充要求：' + tone.custom.trim());
    return lines.join('\n');
  }

  // 把启用的条例拼接进某个字段：base 为用户原文，条例追加在其后
  function composeField(base, rules, target) {
    var list = (rules || []).filter(function (r) { return r.enabled && r.target === target && r.body.trim(); });
    if (!list.length) return str(base);
    var blocks = list.map(function (r) { return '【' + r.title + '】\n' + r.body.trim(); }).join('\n\n');
    var head = str(base).replace(/\s+$/, '');
    return (head ? head + '\n\n' : '') + blocks;
  }

  // 「原生扩展」编辑区：只显示本工具不专门管理的扩展键（如 tavern_helper、QuickReply 配置）
  function rawExtras(ext) {
    var out = {};
    Object.keys(ext || {}).forEach(function (k) { if (EXT_MANAGED.indexOf(k) === -1) out[k] = ext[k]; });
    return out;
  }

  function applyRawExtras(card, obj) {
    Object.keys(card.extensions).forEach(function (k) {
      if (EXT_MANAGED.indexOf(k) === -1) delete card.extensions[k];
    });
    Object.keys(obj || {}).forEach(function (k) {
      if (EXT_MANAGED.indexOf(k) === -1) card.extensions[k] = obj[k];
    });
    return card;
  }

  function emptyExtensions() {
    return {
      talkativeness: '0.5',
      fav: false,
      depth_prompt: { prompt: '', depth: 4, role: 'system' },
      regex_scripts: []
    };
  }

  function emptyCard() {
    return {
      spec: 'chara_card_v3',
      name: '', creator: '', character_version: '1.0', tags: [], creator_notes: '',
      description: '',   // 世界总纲 / 叙事者设定
      scenario: '',      // 当前处境 / 时代背景
      personality: '',   // 叙事风格与基调（简述）
      mes_example: '',   // 叙事示例
      system_prompt: '',
      post_history_instructions: '',
      first_mes: '',     // 主开局
      alternate_greetings: [],
      group_only_greetings: [],
      character_book: emptyBook(),
      extensions: emptyExtensions(),
      tone: emptyTone(),
      rules: [],
      ui: null
    };
  }

  function normalizeExtensions(ext, card) {
    ext = (ext && typeof ext === 'object') ? ext : {};
    var out = emptyExtensions();
    Object.keys(ext).forEach(function (k) { out[k] = ext[k]; });
    out.talkativeness = ext.talkativeness != null ? str(ext.talkativeness)
      : (card && card.talkativeness != null ? str(card.talkativeness) : '0.5');
    out.fav = ext.fav != null ? !!ext.fav : !!(card && card.fav);
    var dp = ext.depth_prompt;
    out.depth_prompt = (dp && typeof dp === 'object')
      ? { prompt: str(dp.prompt), depth: num(dp.depth, 4), role: (dp.role === 'user' || dp.role === 'assistant') ? dp.role : 'system' }
      : { prompt: '', depth: 4, role: 'system' };
    out.regex_scripts = (Array.isArray(ext.regex_scripts) ? ext.regex_scripts : []).map(normalizeRegex);
    return out;
  }

  function strArr(v) { return (Array.isArray(v) ? v : []).filter(function (x) { return typeof x === 'string'; }); }

  // 判断是否是本工具的内部卡对象（带 rules / tone，而非酒馆卡格式）
  function isInternalCard(o) {
    return !!(o && typeof o === 'object' &&
      (Array.isArray(o.rules) || (o.tone && typeof o.tone === 'object' && Array.isArray(o.tone.presets))));
  }

  // 内部卡对象 → 完整内部模型：保留 rules / tone / 世界书 / 扩展（草稿、作品库、MD 存档都用它）
  function fromInternalCard(c) {
    var base = emptyCard();
    if (!c || typeof c !== 'object') { base.rules = defaultRules(); return base; }
    Object.keys(base).forEach(function (k) { if (c[k] !== undefined) base[k] = c[k]; });
    base.spec = c.spec === 'chara_card_v2' ? 'chara_card_v2' : 'chara_card_v3';
    ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
      'system_prompt', 'post_history_instructions', 'creator', 'character_version']
      .forEach(function (k) { base[k] = str(c[k]); });
    base.alternate_greetings = strArr(c.alternate_greetings);
    base.group_only_greetings = strArr(c.group_only_greetings);
    base.tags = toList(c.tags);
    base.character_book = normalizeBook(c.character_book);
    base.extensions = normalizeExtensions(c.extensions, c);
    base.rules = (Array.isArray(c.rules) ? c.rules : []).map(normalizeRule);
    if (!base.rules.length) base.rules = defaultRules();
    base.tone = normalizeTone(c.tone);
    base.ui = c.ui ? normalizeUi(c.ui) : null;
    return base;
  }

  // 任意规范的卡对象（V1 平铺 / V2 / V3，data 包裹或顶层）→ 内部模型
  function fromCardObject(card) {
    if (!card || typeof card !== 'object') throw new Error('角色卡数据不是有效的 JSON 对象');
    var d = (card.data && typeof card.data === 'object') ? card.data : card;
    var c = emptyCard();
    c.spec = card.spec === 'chara_card_v2' ? 'chara_card_v2' : 'chara_card_v3';
    ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
      'system_prompt', 'post_history_instructions', 'creator', 'character_version']
      .forEach(function (k) {
        if (d[k] != null) c[k] = str(d[k]);
        else if (card[k] != null) c[k] = str(card[k]);
      });
    if (!c.creator_notes && card.creatorcomment != null) c.creator_notes = str(card.creatorcomment);
    c.alternate_greetings = strArr(d.alternate_greetings != null ? d.alternate_greetings : card.alternate_greetings);
    c.group_only_greetings = strArr(d.group_only_greetings != null ? d.group_only_greetings : card.group_only_greetings);
    c.tags = toList(d.tags != null ? d.tags : card.tags);
    c.character_book = normalizeBook(d.character_book || card.character_book);
    c.extensions = normalizeExtensions(d.extensions || card.extensions, card);
    // 本工具导出的条例源数据：还原未拼接的原文，避免二次导出时条例重复
    var src = c.extensions.wc_source;
    if (src && typeof src === 'object') {
      c.tone = normalizeTone(src.tone);
      c.rules = (Array.isArray(src.rules) ? src.rules : []).map(normalizeRule);
      c.ui = src.ui ? normalizeUi(src.ui) : null;
      var bases = src.bases || {};
      ['description', 'post_history_instructions', 'system_prompt'].forEach(function (k) {
        if (typeof bases[k] === 'string') c[k] = bases[k];
      });
    }
    delete c.extensions.wc_source;
    return c;
  }

  // 内部模型 → 导出包：primary 为 JSON 文件内容；chunks 为 PNG 要写入的 tEXt 数据块
  function toExportBundle(card, opts) {
    opts = opts || {};
    var ext = clone(card.extensions);
    ext.regex_scripts = card.extensions.regex_scripts.map(regexToExport);
    ext.talkativeness = card.extensions.talkativeness;
    ext.fav = !!card.extensions.fav;
    ext.depth_prompt = card.extensions.depth_prompt;
    if (card.character_book.name) ext.world = card.character_book.name;

    var book = card.character_book;
    var rules = card.rules || [];
    // 条例拼接：把各目标字段中启用的条例追加到该字段原文之后
    var composed = {};
    RULE_TARGETS.forEach(function (t) { composed[t.v] = composeField(card[t.v], rules, t.v); });

    var data = {
      name: card.name, description: composed.description, personality: card.personality,
      scenario: card.scenario, first_mes: card.first_mes, mes_example: card.mes_example,
      creator_notes: card.creator_notes, system_prompt: composed.system_prompt,
      post_history_instructions: composed.post_history_instructions,
      alternate_greetings: card.alternate_greetings.slice(),
      character_book: {
        name: book.name, scan_depth: book.scan_depth, token_budget: book.token_budget,
        recursive_scanning: book.recursive_scanning,
        entries: book.entries.map(entryToCharBook),
        extensions: book.extensions || {}
      },
      tags: card.tags.slice(), creator: card.creator, character_version: card.character_version,
      extensions: ext
    };

    // 记录未拼接的原文与条例源，便于重新导入时还原（避免二次导出时条例叠加）
    ext.wc_source = {
      v: 1,
      bases: { description: card.description, post_history_instructions: card.post_history_instructions, system_prompt: card.system_prompt },
      rules: rules.map(function (r) {
        return { id: r.id, key: r.key, title: r.title, body: r.body, target: r.target, enabled: r.enabled };
      }),
      tone: clone(card.tone),
      ui: card.ui ? clone(card.ui) : null
    };

    if (opts.spec === 'chara_card_v2') {
      var v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: data };
      return { primary: v2, key: 'chara', chunks: { chara: v2 } };
    }
    var v3data = clone(data);
    v3data.group_only_greetings = card.group_only_greetings.slice();
    var top = {
      name: data.name, description: data.description, personality: data.personality,
      scenario: data.scenario, first_mes: data.first_mes, mes_example: data.mes_example,
      creatorcomment: data.creator_notes, avatar: 'none',
      talkativeness: card.extensions.talkativeness, fav: !!card.extensions.fav,
      tags: data.tags, create_date: (opts.now || new Date()).toISOString(),
      // 与部分社区工具一致：顶层也带一份元信息，便于只读顶层的导入器识别
      creator: card.creator, character_version: card.character_version,
      creator_notes: card.creator_notes,
      spec: 'chara_card_v3', spec_version: '3.0', data: v3data
    };
    var v2data = clone(data);
    return {
      primary: top,
      key: 'ccv3',
      chunks: { ccv3: top, chara: { spec: 'chara_card_v2', spec_version: '2.0', data: v2data } }
    };
  }

  // 卡的基础体检结果（用于界面提示；tab/focus 供点击跳转）
  function health(card) {
    var issues = [];
    if (!str(card.name).trim()) {
      issues.push({ level: 'error', text: '缺少作品 / 世界名 name', tab: 'tab-overview', focus: '[data-field="name"]' });
    }
    if (!str(card.first_mes).trim()) {
      issues.push({ level: 'error', text: '缺少主开局 first_mes', tab: 'tab-open', focus: '[data-field="first_mes"]' });
    }
    if (!str(card.description).trim() && !card.character_book.entries.length) {
      issues.push({ level: 'warn', text: '世界总纲与世界书都为空，模型将缺乏世界信息', tab: 'tab-world', focus: '[data-field="description"]' });
    }
    if (!str(card.description).trim() && card.character_book.entries.length) {
      issues.push({ level: 'info', text: '世界总纲为空，设定主要放在世界书中（这是常见写法）', tab: 'tab-world', focus: '[data-field="description"]' });
    }
    if (card.character_book.entries.length && !card.character_book.name) {
      issues.push({ level: 'warn', text: '世界书未命名：导入酒馆时将无法自动关联', tab: 'tab-book', focus: '#f-book-name' });
    }
    var constantN = card.character_book.entries.filter(function (e) { return e.constant && e.enabled; }).length;
    if (card.character_book.entries.length && !constantN) {
      issues.push({ level: 'info', text: '没有常驻条目：世界规则最好设为常驻，避免关键词未命中时丢失', tab: 'tab-book' });
    }
    var rules = card.rules || [];
    var enabledRules = rules.filter(function (r) { return r.enabled; }).length;
    if (!enabledRules) {
      issues.push({ level: 'warn', text: '没有启用任何条例：建议至少启用「不替玩家行动」', tab: 'tab-rules' });
    }
    var tone = card.tone || emptyTone();
    if (!tone.presets.length && !str(tone.custom).trim()) {
      issues.push({ level: 'info', text: '未设置文风基调：可让文风更稳定', tab: 'tab-rules' });
    }
    return issues;
  }

  return {
    POSITIONS: POSITIONS,
    SELECTIVE_LOGIC: SELECTIVE_LOGIC,
    ROLE_OPTIONS: ROLE_OPTIONS,
    CATEGORIES: CATEGORIES,
    RULE_LIBRARY: RULE_LIBRARY,
    RULE_TARGETS: RULE_TARGETS,
    TONE_PRESETS: TONE_PRESETS,
    TONE_OPTIONS: TONE_OPTIONS,
    EXT_MANAGED: EXT_MANAGED,
    normalizeRule: normalizeRule,
    newRule: newRule,
    libraryRule: libraryRule,
    defaultRules: defaultRules,
    emptyTone: emptyTone,
    normalizeTone: normalizeTone,
    toneText: toneText,
    composeField: composeField,
    rawExtras: rawExtras,
    applyRawExtras: applyRawExtras,
    helperScripts: helperScripts,
    setHelperScripts: setHelperScripts,
    normalizeHelperScript: normalizeHelperScript,
    UI_THEMES: UI_THEMES,
    UI_TEMPLATES: UI_TEMPLATES,
    UI_PLACEHOLDER: UI_PLACEHOLDER,
    parsePastedText: parsePastedText,
    splitBlocks: splitBlocks,
    splitLongContent: splitLongContent,
    labelToField: labelToField,
    labelToCategory: labelToCategory,
    UI_REGEX_ID: UI_REGEX_ID,
    uiTheme: uiTheme,
    uiTemplate: uiTemplate,
    defaultUi: defaultUi,
    normalizeUi: normalizeUi,
    renderUiTemplate: renderUiTemplate,
    uiReplaceString: uiReplaceString,
    ensureUiPlaceholder: ensureUiPlaceholder,
    syncUi: syncUi,
    str: str,
    num: num,
    toList: toList,
    clone: clone,
    toPos: toPos,
    posLabel: posLabel,
    categoryOf: categoryOf,
    titleOf: titleOf,
    withCategory: withCategory,
    normalizeEntry: normalizeEntry,
    newEntry: newEntry,
    entryToCharBook: entryToCharBook,
    entryToNative: entryToNative,
    emptyBook: emptyBook,
    normalizeBook: normalizeBook,
    parseNativeBook: parseNativeBook,
    looksLikeNativeBook: looksLikeNativeBook,
    buildNativeBook: buildNativeBook,
    bookFromNative: bookFromNative,
    cloneBook: cloneBook,
    normalizeRoleInfo: normalizeRoleInfo,
    bookStats: bookStats,
    parseRegexSource: parseRegexSource,
    scanEntries: scanEntries,
    normalizeRegex: normalizeRegex,
    applyDisplayRegex: applyDisplayRegex,
    applyMacros: applyMacros,
    emptyCard: emptyCard,
    fromCardObject: fromCardObject,
    fromInternalCard: fromInternalCard,
    isInternalCard: isInternalCard,
    toExportBundle: toExportBundle,
    health: health
  };
});
