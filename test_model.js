/*
 * test_model.js —— card-model.js 单元测试（Node 端）
 * 用法：node test_model.js
 * 覆盖：世界书无损往返、ST 原生世界书互转、关键词触发模拟、正则 placement 保留、
 *       V3 导出结构（ccv3 + chara 双块）、扩展字段 world 同步、体检提示
 */
'use strict';
const assert = require('assert');
const M = require('./card-model.js');
const PNGCard = require('./png-card.js');

let passed = 0;
function ok(label, cond) {
  if (!cond) throw new Error('测试失败：' + label);
  passed++;
  console.log('  ✔ ' + label);
}

console.log('== card-model.js 测试 ==');

// 1. 原生世界书（uid 键 + 未知字段）→ 内部模型 → 导出，未知字段不丢
const nativeBook = {
  name: '霜原设定集',
  entries: {
    '50112': {
      uid: 50112, key: ['霜城', 'Frosthold'], keysecondary: ['城市'], comment: '【地理】霜城',
      content: '霜城是一座以工业与律法闻名的城市。', constant: false, selective: true, selectiveLogic: 0,
      order: 300, position: 0, disable: false, depth: 4, role: 0, probability: 100, useProbability: true,
      characterFilter: { isExclude: false, names: [], tags: [] }, triggers: [], automationId: '', displayIndex: 3
    },
    '7': {
      uid: 7, key: [], keysecondary: [], comment: '【规则】灵力法则', content: '灵力只在夜间复苏。',
      constant: true, order: 100, position: 4, depth: 2, role: 'system', disable: false
    }
  }
};
const parsed = M.parseNativeBook(nativeBook);
// 原生对象的整数键按数值升序遍历（7 先于 50112），因此按 id 查找，不依赖顺序
const byId = (list, id) => list.find(function (e) { return e.id === id; });
const A = byId(parsed.entries, 50112);
ok('原生世界书可解析为 2 条', parsed && parsed.entries.length === 2);
ok('原生 key / keysecondary 映射为 keys / secondary_keys', A.keys.join() === '霜城,Frosthold' && A.secondary_keys[0] === '城市');
ok('characterFilter 作为一等字段保留（不再落入 extra）', A.extra.characterFilter === undefined && !!A.characterFilter);
const card = M.emptyCard();
card.name = '世界卡测试';
card.first_mes = '你站在霜城的街头。';
card.character_book = M.normalizeBook({ name: '', entries: [] });
card.character_book.entries = parsed.entries;
const bundle = M.toExportBundle(card, { spec: 'chara_card_v3', now: new Date('2026-01-01T00:00:00Z') });
const exported = byId(bundle.primary.data.character_book.entries, 50112);
ok('导出条目保留未知字段 characterFilter', !!exported.characterFilter);
ok('导出条目保留 displayIndex（原生字段）', exported.displayIndex === 3);
ok('导出 position 0 为 before_char 字符串', exported.position === 'before_char');
ok('导出 keys 数组正确', Array.isArray(exported.keys) && exported.keys[0] === '霜城');
ok('有条目且世界书名为空时自动命名并写入 extensions.world', bundle.primary.data.extensions.world === '世界卡测试 世界书');
ok('自动命名后 character_book.name 一致', bundle.primary.data.character_book.name === '世界卡测试 世界书');

// 2. 原生互转：导出为 uid 键对象，再次解析结果一致
const native2 = M.buildNativeBook('霜原设定集', card.character_book.entries);
ok('buildNativeBook 输出 uid 键对象', native2.entries['50112'] && native2.entries['50112'].key[0] === '霜城');
const again = M.parseNativeBook(native2);
ok('原生往返后条目数不变', again.entries.length === 2);
ok('原生往返后 comment 与 content 不变', byId(again.entries, 50112).comment === '【地理】霜城' && byId(again.entries, 50112).content.indexOf('霜城是') === 0);

// 3. 分类解析
ok('categoryOf 解析【分类】前缀', M.categoryOf('【势力】北境') === '势力');
ok('titleOf 去掉分类前缀', M.titleOf('【势力】北境') === '北境');
ok('无前缀时分类为空', M.categoryOf('普通备注') === '');
ok('withCategory 组合 comment', M.withCategory('地理', '霜城') === '【地理】霜城');

// 4. 关键词触发模拟
const entries = [
  M.normalizeEntry({ comment: '【地理】霜城', keys: ['霜城'], content: 'a' }),
  M.normalizeEntry({ comment: '【人物】莉安', keys: ['莉安'], secondary_keys: ['法师', '医者'], selective: true, selectiveLogic: 0, content: 'b' }),
  M.normalizeEntry({ comment: '【规则】常驻', constant: true, content: 'c' }),
  M.normalizeEntry({ comment: '【物品】关闭', keys: ['天灾'], enabled: false, content: 'd' })
];
const hits = M.scanEntries(entries, '我走进霜城，遇到了莉安。');
const reasons = hits.map(function (h) { return h.index; });
ok('关键词命中 霜城 条目', reasons.indexOf(0) !== -1);
ok('选择性条目未满足次级关键词时不注入', reasons.indexOf(1) === -1);
ok('常驻条目始终注入', reasons.indexOf(2) !== -1);
ok('停用条目不注入', reasons.indexOf(3) === -1);
const hits2 = M.scanEntries(entries, '莉安是法师');
ok('次级关键词满足 AND ANY 时注入', hits2.some(function (h) { return h.index === 1; }));
ok('大小写不敏感匹配英文关键词', M.scanEntries([M.normalizeEntry({ keys: ['Frosthold'], content: 'x' })], 'frosthold').length === 1);
ok('全词匹配：子串不命中', M.scanEntries([M.normalizeEntry({ keys: ['art'], matchWholeWords: true, content: 'x' })], 'party').length === 0);

// 5. 正则 placement 保留（3、5 等不丢）
const rx = M.normalizeRegex({ scriptName: 'x', findRegex: '/a/g', placement: [1, 2, 5], trimStrings: ['\n'], ephemerality: 'yes' });
card.extensions.regex_scripts = [rx];
const b2 = M.toExportBundle(card, { spec: 'chara_card_v3' });
const rxOut = b2.primary.data.extensions.regex_scripts[0];
ok('正则 placement 含 5 时保留', rxOut.placement.join() === '1,2,5');
ok('正则 trimStrings 保留', rxOut.trimStrings[0] === '\n');
ok('正则未知字段 ephemerality 保留', rxOut.ephemerality === 'yes');

// 6. 显示层正则与宏
const shown = M.applyDisplayRegex('<think>内部</think>你好', [M.normalizeRegex({ findRegex: '/<think>[\\s\\S]*?<\\/think>/g', replaceString: '', placement: [2], markdownOnly: true })]);
ok('markdownOnly 脚本作用于显示', shown === '你好');
ok('promptOnly 脚本不作用于显示', M.applyDisplayRegex('x', [M.normalizeRegex({ findRegex: '/x/g', replaceString: 'y', placement: [2], promptOnly: true })]) === 'x');
ok('显示+提示词脚本也作用于显示', M.applyDisplayRegex('x', [M.normalizeRegex({ findRegex: '/x/g', replaceString: 'y', placement: [2], markdownOnly: false, promptOnly: false })]) === 'y');
ok('宏 {{char}} {{user}} 替换', M.applyMacros('{{char}} 与 {{user}}', '讲述者', 'User') === '讲述者 与 User');

// 7. V3 双块与 V2 导出
ok('V3 导出含 ccv3 与 chara 两块', !!bundle.chunks.ccv3 && !!bundle.chunks.chara);
ok('V3 group_only_greetings 只在 ccv3 内', Array.isArray(bundle.chunks.ccv3.data.group_only_greetings) && bundle.chunks.chara.data.group_only_greetings === undefined);
const v2 = M.toExportBundle(card, { spec: 'chara_card_v2' });
ok('V2 只导出 chara 块', v2.key === 'chara' && !v2.chunks.ccv3);

// 8. 世界书名同步到 extensions.world
card.character_book.name = '霜原设定集';
ok('世界书名写入 extensions.world', M.toExportBundle(card, { spec: 'chara_card_v3' }).primary.data.extensions.world === '霜原设定集');

// 9. PNG 写读回环（内嵌世界书）
const png = buildPng();
const out = PNGCard.writeCards(png, bundle.chunks);
const back = PNGCard.readCards(out).ccv3;
ok('PNG 内嵌卡读回一致', JSON.stringify(back) === JSON.stringify(bundle.primary));
ok('PNG 内嵌世界书条目数一致', back.data.character_book.entries.length === 2);

// 10. 体检
const h = M.health(M.emptyCard());
ok('空卡体检报告缺少作品名与主开局提示', h.some(function (x) { return x.text.indexOf('作品名') !== -1; }) && h.some(function (x) { return x.text.indexOf('主开局') !== -1; }));
ok('空卡体检提示卡内世界书仍空', h.some(function (x) { return x.text.indexOf('卡内世界书') !== -1; }));

// 11. 从 V3 卡还原内部模型（无损）
const restored = M.fromCardObject(bundle.primary);
ok('fromCardObject 还原世界书条目', restored.character_book.entries.length === 2);
ok('还原后原生字段仍在（characterFilter）', !!byId(restored.character_book.entries, 50112).characterFilter);
ok('还原后 alternate_greetings 与 group_only_greetings', restored.group_only_greetings !== undefined);

// 11. 条例：拼接、二次导出不重复、可删除
const ruleCard = M.emptyCard();
ruleCard.name = '条例测试';
ruleCard.first_mes = '开场。';
ruleCard.description = '世界总纲原文。';
ruleCard.post_history_instructions = '';
ruleCard.rules = [M.libraryRule('no-act'), M.libraryRule('consistent')];
const rb = M.toExportBundle(ruleCard, { spec: 'chara_card_v3' }).primary.data;
ok('条例追加到目标字段之后', rb.description.indexOf('世界总纲原文。') === 0 && rb.description.indexOf('【设定一致】') !== -1);
ok('no-act 条例写入历史后指令', rb.post_history_instructions.indexOf('【不替玩家行动】') !== -1);
ok('导出的扩展中含 wc_source 原文与条例源', rb.extensions.wc_source && rb.extensions.wc_source.bases.description === '世界总纲原文。');
// 二次导出：先导入再导出，条例不应叠加
const re = M.fromCardObject(M.toExportBundle(ruleCard, { spec: 'chara_card_v3' }).primary);
const rb2 = M.toExportBundle(re, { spec: 'chara_card_v3' }).primary.data;
ok('二次导出不叠加条例', rb2.description === rb.description && rb2.post_history_instructions === rb.post_history_instructions);
ok('重新导入后条例保留', re.rules.length === 2);
// 停用 / 删除条例
re.rules[0].enabled = false;
const rb3 = M.toExportBundle(re, { spec: 'chara_card_v3' }).primary.data;
ok('停用条例后不写入对应字段', rb3.post_history_instructions.indexOf('不替玩家行动') === -1);
re.rules.splice(0, 1);
const rb4 = M.toExportBundle(re, { spec: 'chara_card_v3' }).primary.data;
ok('删除条例后不再出现', rb4.description.indexOf('【设定一致】') !== -1 && rb4.description.indexOf('【不替玩家行动】') === -1);
// 自定义条例
const custom = M.newRule('我的条例', '正文内容', 'system_prompt');
ok('自定义条例可指定目标字段', custom.target === 'system_prompt' && custom.enabled === true);

// 12. 文风基调
const tone = M.normalizeTone({ presets: ['cold', 'epic'], person: '第二人称（你）', length: '精炼（100-200 字）' });
const tt = M.toneText(tone);
ok('文风文本含基调名', tt.indexOf('冷峻写实') !== -1 && tt.indexOf('史诗宏大') !== -1);
ok('文风文本含视角与篇幅', tt.indexOf('第二人称') !== -1 && tt.indexOf('精炼') !== -1);
ok('文风自定义补充写入', M.toneText(M.normalizeTone({ custom: '少用感叹号' })).indexOf('少用感叹号') !== -1);
ok('未知基调 id 被过滤', M.normalizeTone({ presets: ['nope'] }).presets.length === 0);

// 13. 原生扩展键：tavern_helper 等应保留在扩展中并可编辑
const extCard = M.emptyCard();
extCard.name = '扩展测试';
extCard.first_mes = 'a';
extCard.extensions.tavern_helper = { scripts: [{ name: 'ZOD' }] };
extCard.extensions.QuickReply_Profile_V54 = [{ name: 'Default' }];
const eb = M.toExportBundle(extCard, { spec: 'chara_card_v3' }).primary.data;
ok('扩展键 tavern_helper 原样导出', eb.extensions.tavern_helper.scripts[0].name === 'ZOD');
ok('扩展键 QuickReply_Profile_V54 原样导出', Array.isArray(eb.extensions.QuickReply_Profile_V54));
ok('rawExtras 排除本工具管理的键', M.rawExtras(eb.extensions).wc_source === undefined && M.rawExtras(eb.extensions).tavern_helper === undefined);
const rawBack = M.rawExtras(eb.extensions);
M.applyRawExtras(extCard, { custom_ext: 1 });
ok('applyRawExtras 新增自定义扩展键', extCard.extensions.custom_ext === 1);
ok('applyRawExtras 只替换非托管键（tavern_helper 不受影响）', extCard.extensions.tavern_helper !== undefined);
M.applyRawExtras(extCard, rawBack);
ok('applyRawExtras 替换回原生集合', extCard.extensions.tavern_helper !== undefined && extCard.extensions.custom_ext === undefined);

// 1b. uid 为 0 的条目不能被覆盖（曾经因 0 被当作假值而丢条目）
const uidZeroBook = {
  name: '零号世界书',
  entries: {
    '0': { uid: 0, key: ['a'], comment: '零号条目', content: 'uid 0 的内容', constant: false, order: 1, position: 0, disable: false },
    '1': { uid: 1, key: ['b'], comment: '一号条目', content: 'uid 1 的内容', constant: false, order: 2, position: 0, disable: false },
    '2': { uid: 2, key: ['c'], comment: '二号条目', content: 'uid 2 的内容', constant: false, order: 3, position: 0, disable: false }
  }
};
const uz = M.bookFromNative(M.parseNativeBook(uidZeroBook));
const uzOut = M.buildNativeBook(uz.name, uz.entries, uz.raw);
ok('uid 0 条目不丢失（3 条全部导出）', Object.keys(uzOut.entries).length === 3);
ok('uid 0 条目保留 uid 0', !!uzOut.entries['0'] && uzOut.entries['0'].content === 'uid 0 的内容');
ok('新条目 id 为 null（自动分配 uid）', M.newEntry('地理', 'x').id === null);
const autoBook = M.buildNativeBook('auto', [M.newEntry('地理', 'a'), M.newEntry('地理', 'b')]);
ok('未指定 id 的条目自动分配不重复 uid', Object.keys(autoBook.entries).length === 2 && autoBook.entries['1'] && autoBook.entries['2']);
const dupBook = M.buildNativeBook('dup', [M.normalizeEntry({ id: 5, comment: 'x', content: '1' }), M.normalizeEntry({ id: 5, comment: 'y', content: '2' })]);
ok('uid 冲突时不互相覆盖', Object.keys(dupBook.entries).length === 2);

// 1c. 独立世界书的原生字段与 null 语义
const nat = M.normalizeEntry({
  uid: 9, key: ['k'], comment: '原生条目', content: 'c', constant: true, order: 5, position: 4,
  disable: false, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
  sticky: null, cooldown: null, delay: null, scanDepth: null, role: 0, addMemo: false,
  ignoreBudget: true, outletName: 'o', automationId: 'a1', displayIndex: 7,
  triggers: ['t1'], characterFilter: { isExclude: true, names: ['n'], tags: [] },
  matchPersonaDescription: true, matchCharacterDescription: true, delayUntilRecursion: 1
});
ok('null 语义保留：caseSensitive 为 null', nat.case_sensitive === null);
ok('null 语义保留：sticky/cooldown/delay 为 null', nat.sticky === null && nat.cooldown === null && nat.delay === null);
ok('role 数字 0 归一为 system 且保留原始值', nat.role === 'system' && nat.roleRaw === 0);
ok('addMemo=false 被保留', nat.addMemo === false);
ok('ignoreBudget / outletName / automationId / displayIndex 保留',
  nat.ignoreBudget === true && nat.outletName === 'o' && nat.automationId === 'a1' && nat.displayIndex === 7);
ok('triggers 与 characterFilter 保留', nat.triggers[0] === 't1' && nat.characterFilter.isExclude === true);
ok('match* 匹配来源保留', nat.matchPersonaDescription === true && nat.matchCharacterDescription === true);
const natOut = M.entryToNative(nat, 9);
ok('原生导出保留 null（不被改成 false/0）',
  natOut.caseSensitive === null && natOut.sticky === null && natOut.cooldown === null && natOut.delay === null && natOut.scanDepth === null);
ok('原生导出 role 保留原始数字 0', natOut.role === 0);
ok('原生导出 delayUntilRecursion 保留原始值 1', natOut.delayUntilRecursion === 1);
ok('原生导出含全部 41 个酒馆字段', Object.keys(natOut).length >= 40);

// 1d. 独立世界书 → 卡内世界书 → 独立世界书 无损
const natBook = { name: '原生书', scan_depth: 3, token_budget: 800, recursive_scanning: true, entries: [nat], extensions: {}, raw: { extraTop: 1 } };
const cardBook = M.normalizeBook({
  name: natBook.name, scan_depth: natBook.scan_depth, token_budget: natBook.token_budget,
  recursive_scanning: natBook.recursive_scanning, entries: natBook.entries.map(M.entryToCharBook)
});
ok('卡内世界书保留原生字段', cardBook.entries[0].characterFilter.isExclude === true && cardBook.entries[0].ignoreBudget === true);
const backNative = M.buildNativeBook(cardBook.name, cardBook.entries);
ok('卡内 → 原生 往返后 uid 与 null 保留', backNative.entries['9'].uid === 9 && backNative.entries['9'].caseSensitive === null);

// 14. 酒馆助手脚本（tavern_helper）：对象与数组两种形态都要无损
const objForm = { scripts: [{ type: 'script', enabled: true, name: '变量表', id: 'a1', content: 'var x=1', info: '说明', button: { label: 'b' }, data: { k: 1 }, export_with: true }], variables: { foo: 1 } };
const arrForm = [{ type: 'script', enabled: false, name: '脚本二', id: 'a2', content: 'var y=2' }];
function helperRoundTrip(th) {
  const c = M.emptyCard();
  c.name = 'h';
  c.first_mes = 'x';
  c.extensions.tavern_helper = th;
  const out = M.toExportBundle(c, { spec: 'chara_card_v3' }).primary.data.extensions.tavern_helper;
  return out;
}
const o1 = helperRoundTrip(objForm);
ok('助手脚本对象形态：scripts 数量保留', o1.scripts.length === 1);
ok('助手脚本对象形态：variables 等其他键保留', o1.variables && o1.variables.foo === 1);
ok('助手脚本：info/button/data/export_with 保留',
  o1.scripts[0].info === '说明' && o1.scripts[0].button.label === 'b' && o1.scripts[0].data.k === 1 && o1.scripts[0].export_with === true);
ok('助手脚本：name/content/enabled 保留', o1.scripts[0].name === '变量表' && o1.scripts[0].content === 'var x=1' && o1.scripts[0].enabled === true);
const a1 = helperRoundTrip(arrForm);
ok('助手脚本数组形态：仍是数组', Array.isArray(a1) && a1.length === 1);
ok('助手脚本数组形态：enabled=false 保留', a1[0].enabled === false && a1[0].name === '脚本二');
const c2 = M.emptyCard();
c2.name = 'h'; c2.first_mes = 'x';
c2.extensions.tavern_helper = objForm;
const list = M.helperScripts(c2.extensions);
ok('helperScripts 从对象形态读取脚本', list.length === 1 && list[0].name === '变量表');
list.push(M.normalizeHelperScript({ name: '新增', content: 'z', type: 'script' }));
M.setHelperScripts(c2.extensions, list);
ok('setHelperScripts 写回对象形态并保留 variables', c2.extensions.tavern_helper.scripts.length === 2 && c2.extensions.tavern_helper.variables.foo === 1);
ok('helperScripts 也能读数组形态', M.helperScripts({ tavern_helper: arrForm }).length === 1);
ok('tavern_helper 不再出现在原生扩展编辑区', M.rawExtras({ tavern_helper: objForm, other: 1 }).tavern_helper === undefined && M.rawExtras({ tavern_helper: objForm, other: 1 }).other === 1);

// 15. V3 顶层元信息与条目 budget
const metaCard = M.emptyCard();
metaCard.name = '元信息';
metaCard.first_mes = 'x';
metaCard.creator = '作者A';
metaCard.character_version = '2.0';
metaCard.creator_notes = '备注';
const top = M.toExportBundle(metaCard, { spec: 'chara_card_v3' }).primary;
ok('V3 顶层含 creator / character_version / creator_notes',
  top.creator === '作者A' && top.character_version === '2.0' && top.creator_notes === '备注');
const be = M.normalizeEntry({ uid: 1, comment: 'c', content: 'x', budget: 300 });
ok('条目 budget 字段保留', be.budget === 300);
ok('budget 为 null 时不写入假值', M.normalizeEntry({ uid: 1, comment: 'c', content: 'x' }).budget === null);
ok('原生导出写入 budget', M.entryToNative(be, 1).budget === 300);
ok('卡内导出写入 budget', M.entryToCharBook(be).budget === 300);

// 16. 内部卡对象（草稿 / 作品库 / MD 存档）必须保留 rules 与 tone
const internal = M.emptyCard();
internal.name = '内部卡';
internal.first_mes = '开场';
internal.description = '总纲';
internal.rules = [M.libraryRule('no-act'), M.newRule('自定义', '内容', 'system_prompt')];
internal.tone = M.normalizeTone({ presets: ['cold', 'grim'], custom: '短句' });
internal.character_book.entries.push(M.newEntry('地理', '测试城', '内容'));
const rt = M.fromInternalCard(internal);
ok('fromInternalCard 保留全部条例', rt.rules.length === 2);
ok('fromInternalCard 保留条例目标', rt.rules[1].target === 'system_prompt' && rt.rules[1].title === '自定义');
ok('fromInternalCard 保留文风基调', rt.tone.presets.join() === 'cold,grim' && rt.tone.custom === '短句');
ok('fromInternalCard 保留世界书', rt.character_book.entries.length === 1);
ok('isInternalCard 识别内部对象', M.isInternalCard(internal) === true);
ok('isInternalCard 不把外部卡当内部对象', M.isInternalCard({ spec: 'chara_card_v3', data: { name: 'x' } }) === false);
ok('fromInternalCard 对空对象给出默认条例', M.fromInternalCard({}).rules.length === M.defaultRules().length);
// 内部 → 导出 → 导入 → 再导出（自旋，两条路径都要无损）
const spinNow = new Date('2026-01-01T00:00:00Z');
const exp1 = M.toExportBundle(rt, { spec: 'chara_card_v3', now: spinNow }).primary;
const reimported = M.fromCardObject(exp1);      // 重新导入（读 wc_source 还原）
const exp2 = M.toExportBundle(reimported, { spec: 'chara_card_v3', now: spinNow }).primary;
ok('内部卡经导出再导入后自旋一致', JSON.stringify(exp1) === JSON.stringify(exp2));
ok('自旋后条例不叠加', exp2.data.description.indexOf('【不替玩家行动】') === exp2.data.description.lastIndexOf('【不替玩家行动】'));
ok('自旋后自定义条例仍在', reimported.rules.some(r => r.title === '自定义' && r.target === 'system_prompt'));
ok('自旋后文风基调仍在', reimported.tone.presets.join() === 'cold,grim');
const rt2 = M.fromInternalCard(rt);           // 草稿/作品库路径（不经过导出）
ok('内部卡再解析保持条例与文风', rt2.rules.length === 2 && rt2.tone.presets.join() === 'cold,grim');

// 17. 统一前端（世界面板）：模板渲染、占位符、正则同步、往返
const uiCard = M.emptyCard();
uiCard.name = '前端卡';
uiCard.first_mes = '你推开门。';
uiCard.ui = M.normalizeUi(M.defaultUi('status'));
ok('默认前端为状态栏模板', uiCard.ui.template === 'status' && uiCard.ui.fields.length === 4);
const html = M.renderUiTemplate(uiCard.ui);
ok('状态栏生成含标题与字段', html.indexOf('状态栏') !== -1 && html.indexOf('⏰') !== -1 && html.indexOf('{{time}}') !== -1);
ok('生成 HTML 为自包含 div（无外部依赖）', html.indexOf('<div') === 0 && html.indexOf('http') === -1);
ok('HTML 转义用户输入', M.renderUiTemplate(M.normalizeUi({ template: 'status', title: '<b>x</b>' })).indexOf('&lt;b&gt;') !== -1);
ok('替换文本为 ```html 代码块', M.uiReplaceString(uiCard.ui).indexOf('```html') === 0);

// 占位符
ok('占位符默认不在开局中', uiCard.first_mes.indexOf(M.UI_PLACEHOLDER) === -1);
M.ensureUiPlaceholder(uiCard);
ok('占位符插入主开局', uiCard.first_mes.indexOf(M.UI_PLACEHOLDER) !== -1);
M.ensureUiPlaceholder(uiCard);
ok('占位符不重复插入', uiCard.first_mes.split(M.UI_PLACEHOLDER).length === 2);
uiCard.alternate_greetings = ['备用一', '备用二'];
uiCard.ui.inGreetings = false;
M.ensureUiPlaceholder(uiCard);
ok('未开启时不插入备用开局', uiCard.alternate_greetings.every(g => g.indexOf(M.UI_PLACEHOLDER) === -1));
uiCard.ui.inGreetings = true;
M.ensureUiPlaceholder(uiCard);
ok('开启后插入全部备用开局', uiCard.alternate_greetings.every(g => g.indexOf(M.UI_PLACEHOLDER) !== -1));

// 正则同步
ok('同步前没有前端正则', uiCard.extensions.regex_scripts.length === 0);
M.syncUi(uiCard);
ok('同步后新增 1 条前端正则', uiCard.extensions.regex_scripts.length === 1);
const uiRx = uiCard.extensions.regex_scripts[0];
ok('前端正则 id 固定（便于更新不叠加）', uiRx.id === M.UI_REGEX_ID);
ok('前端正则匹配占位符', uiRx.findRegex.indexOf('WorldPanel') !== -1);
ok('前端正则替换为生成的 HTML', uiRx.replaceString.indexOf('```html') === 0 && uiRx.replaceString.indexOf('状态栏') !== -1);
ok('状态栏默认仅影响显示', uiRx.markdownOnly === true);
ok('开局面板默认也发给模型', M.normalizeUi(M.defaultUi('opening')).displayOnly === false);
// 用户自加的正则不受影响
uiCard.extensions.regex_scripts.push(M.normalizeRegex({ scriptName: '我的脚本', findRegex: '/x/g', replaceString: 'y', placement: [2] }));
M.syncUi(uiCard);
ok('重复同步不叠加正则', uiCard.extensions.regex_scripts.length === 2);
ok('重复同步更新同一条', uiCard.extensions.regex_scripts.filter(s => s.id === M.UI_REGEX_ID).length === 1);
ok('用户自加的正则保留', uiCard.extensions.regex_scripts.some(s => s.scriptName === '我的脚本'));
// 改配置后同步更新
uiCard.ui.fields[0].value = '新时间';
M.syncUi(uiCard);
ok('改配置后正则内容随之更新', uiCard.extensions.regex_scripts[0].replaceString.indexOf('新时间') !== -1);

// 往返：导出 → 导入，前端配置与正则都要还原且不叠加
const uiNow = new Date('2026-01-01T00:00:00Z');
const uiB1 = M.toExportBundle(uiCard, { spec: 'chara_card_v3', now: uiNow }).primary;
ok('wc_source 内含 ui 配置', !!uiB1.data.extensions.wc_source.ui);
const uiBack = M.fromCardObject(uiB1);
ok('导入后还原 ui 配置', !!uiBack.ui && uiBack.ui.template === 'status' && uiBack.ui.fields[0].value === '新时间');
M.syncUi(uiBack);
const uiB2 = M.toExportBundle(uiBack, { spec: 'chara_card_v3', now: uiNow }).primary;
ok('前端往返后自旋一致', JSON.stringify(uiB1) === JSON.stringify(uiB2));
ok('前端往返后正则不叠加', uiB2.data.extensions.regex_scripts.filter(s => s.id === M.UI_REGEX_ID).length === 1);
// 其他模板
ok('开局面板生成选项', M.renderUiTemplate(M.defaultUi('opening')).indexOf('开局选择') !== -1);
ok('世界面板生成区块', M.renderUiTemplate(M.defaultUi('world')).indexOf('世界信息') !== -1);
ok('简约条为单行', M.renderUiTemplate(M.defaultUi('minimal')).indexOf('⏰') !== -1);
// 主题
ok('主题切换改变颜色', M.renderUiTemplate(M.normalizeUi({ template: 'status', theme: 'ember' })).indexOf('#2a1710') !== -1);
ok('自定义颜色优先于主题', M.renderUiTemplate(M.normalizeUi({ template: 'status', theme: 'ember', colors: { from: '#123456' } })).indexOf('#123456') !== -1);


// ---- 体检跳转元数据 ----
console.log('\n== 体检 tab/focus ==');
{
  const empty = M.emptyCard();
  const issues = M.health(empty);
  const nameIssue = issues.find(h => /作品|世界名|name/i.test(h.text));
  const openIssue = issues.find(h => /主开局|first_mes/i.test(h.text));
  ok('缺名带 tab-overview', nameIssue && nameIssue.tab === 'tab-overview');
  ok('缺开局带 tab-open', openIssue && openIssue.tab === 'tab-open');
  ok('缺名带 focus 选择器', nameIssue && typeof nameIssue.focus === 'string' && nameIssue.focus.length > 0);
}

console.log('\n全部通过：' + passed + ' 项断言 ✔');

// 用项目自带的 PNG 工具造一张最小 PNG（与 test_card.js 同源思路）
function buildPng() {
  const zlib = require('zlib');
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([len, typeBytes, data, crcBuf]);
  }
  const w = 4, hgt = 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]));
}

// 18. 智能粘贴解析
console.log('== 智能粘贴解析 ==');
const t1 = ['【角色名】艾莉娅', '【外貌】银白长发编成侧辫，琥珀色瞳孔，左耳有一颗小痣。', '【性格】温柔但嘴硬，怕打雷，被夸奖会脸红。', '【场景】黄昏的海边小镇，你们合租在同一栋两层小屋里。', '【开场白】*她抱着一摞书从书架后转出来，差点撞到你* 啊——对不起！你是新来的冒险者吧？', '【作者备注】推荐长上下文模型。'].join(String.fromCharCode(10));
const r1 = M.parsePastedText(t1);
ok('识别为角色卡', r1.ok && r1.kind === 'card');
ok('角色名解析正确', r1.fields.name === '艾莉娅');
ok('外貌/性格/场景归位', r1.fields.description.indexOf('银白长发') !== -1 && r1.fields.personality.indexOf('嘴硬') !== -1 && r1.fields.scenario.indexOf('海边小镇') !== -1);
ok('开场白归位', r1.fields.first_mes.indexOf('书架后') !== -1);
ok('作者备注归位', r1.fields.creator_notes.indexOf('长上下文') !== -1);

const t2 = ['【地点】北境要塞', '位置：王国最北端，墙外即是永夜。', '氛围：空气里有陈年灯油与雪混合的气味。', '', '【势力】守灯会', '立场：掌管钟楼与余烬分配，相信灯必须长亮。', '', '【人物】守灯人', '身份：守灯会成员，负责看守钟楼灯芯。', '', '【规则】光照即寿命', '黑暗中会逐渐失去记忆，须以余烬维持神志。'].join(String.fromCharCode(10));
const r2 = M.parsePastedText(t2);
ok('识别为世界书', r2.ok && (r2.kind === 'book' || r2.kind === 'mixed'));
ok('生成 4 个条目', r2.entries.length === 4);
ok('条目分类正确', r2.entries[0].comment.indexOf('地理') !== -1 && r2.entries[1].comment.indexOf('势力') !== -1 && r2.entries[2].comment.indexOf('人物') !== -1 && r2.entries[3].comment.indexOf('规则') !== -1);
ok('条目标题提取', r2.entries[0].comment.indexOf('北境要塞') !== -1);
ok('条目关键词自动取自标题', r2.entries[0].keys[0] === '北境要塞');
ok('子标题保留在内容中', r2.entries[0].content.indexOf('位置：') !== -1 && r2.entries[0].content.indexOf('氛围：') !== -1);

const t3 = ['# 永夜之城', '角色名：永夜将至的城', '核心设定：这是一个被永夜笼罩的世界，日光已有七年未曾升起。', '开场白：你推开门，雪正下着。', '', '【地点】钟楼', '钟楼顶端亮着一盏本不该亮着的灯。', '', '【势力】掘雾人', '冒险进入雾中寻找旧日遗物的组织。'].join(String.fromCharCode(10));
const r3 = M.parsePastedText(t3);
ok('识别为混合类型', r3.ok && r3.kind === 'mixed');
ok('Markdown 标题作作品名', r3.fields.name === '永夜将至的城');
ok('核心设定与开场白归位', r3.fields.description.indexOf('永夜') !== -1 && r3.fields.first_mes.indexOf('推开门') !== -1);
ok('同时生成 2 个世界书条目', r3.entries.length === 2);

const t4 = ['【开场白】你站在城门前。', '【备用开局】', '你在雾中走了三天，干粮已经耗尽。', '【开场白二】', '深夜，你被钟声惊醒。'].join(String.fromCharCode(10));
const r4 = M.parsePastedText(t4);
ok('主开局取第一个', r4.fields.first_mes.indexOf('城门前') !== -1);
ok('备用开局识别 2 条', (r4.fields.__greetings || []).length === 2);
ok('备用开局按文档顺序排列', r4.fields.__greetings[0].indexOf('雾中走了三天') !== -1 && r4.fields.__greetings[1].indexOf('钟声惊醒') !== -1);

const t5 = ['【物品】余烬之灯', '关键词：余烬, 灯, 钟楼', '一盏不会熄灭的灯。'].join(String.fromCharCode(10));
const r5 = M.parsePastedText(t5);
ok('显式关键词优先', r5.entries[0].keys.join() === '余烬,灯,钟楼');

const long = Array.from({ length: 8 }, (_, i) => '第' + (i + 1) + '段：' + '内容'.repeat(60)).join(String.fromCharCode(10) + String.fromCharCode(10));
const r6 = M.parsePastedText('【规则】世界法则' + String.fromCharCode(10) + long, { splitLong: true });
ok('长内容拆成多条', r6.entries.length > 1);
const r6b = M.parsePastedText('【规则】世界法则' + String.fromCharCode(10) + long);
ok('不拆分时为一条', r6b.entries.length === 1);

const j1 = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'JSON卡', description: 'd', first_mes: 'f' } });
const r7 = M.parsePastedText(j1);
ok('JSON 角色卡直接识别', r7.ok && r7.kind === 'json' && r7.card.data.name === 'JSON卡');
const j2 = JSON.stringify({ entries: { '1': { uid: 1, key: ['a'], comment: 'c', content: 'x' } } });
const r8 = M.parsePastedText(j2);
ok('JSON 世界书直接识别', r8.ok && r8.kind === 'book' && r8.nativeBook.entries.length === 1);

const r9 = M.parsePastedText('这是一段没有任何标签的长文本。'.repeat(30));
ok('纯长文本落入世界总纲', r9.ok && r9.fields.description && r9.fields.description.length > 100);
ok('空内容报错', M.parsePastedText('').ok === false);
ok('纯空白报错', M.parsePastedText('   ' + String.fromCharCode(10) + '  ').ok === false);
ok('极短无结构文本不崩溃', typeof M.parsePastedText('你好').ok === 'boolean');
const blocks = M.splitBlocks('【A】1' + String.fromCharCode(10) + '内容' + String.fromCharCode(10) + '【B】2');
ok('splitBlocks 切出 2 块', blocks.length === 2 && blocks[0].label === 'A' && blocks[1].label === 'B');
ok('splitBlocks 保留内容', blocks[0].content === '1' + String.fromCharCode(10) + '内容');

// ---- v0.4 角色卡内嵌世界书保证 ----
(function () {
  const c = M.emptyCard();
  c.name = '嵌入测试世界';
  c.first_mes = '开局。';
  const libEntry = M.normalizeEntry({
    comment: '【地理】极北', keys: ['极北'], content: '极北是永夜之地。',
    constant: false, enabled: true, insertion_order: 100, id: 42
  });
  // 模拟「从世界书库嵌入」：把全文写入 character_book（非仅 ID 引用）
  c.character_book = M.normalizeBook({
    name: '', scan_depth: 2, token_budget: 500, recursive_scanning: false,
    entries: [libEntry]
  });
  const v3 = M.toExportBundle(c, { spec: 'chara_card_v3', now: new Date('2026-01-01T00:00:00Z') });
  const v2 = M.toExportBundle(c, { spec: 'chara_card_v2' });
  ok('V3 data.character_book 存在', !!v3.primary.data.character_book);
  ok('V3 character_book.entries 含全文', v3.primary.data.character_book.entries.length === 1 &&
    v3.primary.data.character_book.entries[0].content.indexOf('永夜') !== -1);
  ok('V3 character_book.entries[0].keys 保留', v3.primary.data.character_book.entries[0].keys[0] === '极北');
  ok('V3 自动世界书名', v3.primary.data.character_book.name === '嵌入测试世界 世界书');
  ok('V3 extensions.world 同步', v3.primary.data.extensions.world === '嵌入测试世界 世界书');
  ok('V2 data.character_book 同样内嵌', v2.primary.data.character_book.entries.length === 1 &&
    v2.primary.data.character_book.entries[0].content.indexOf('永夜') !== -1);
  ok('V2 extensions.world 同步', v2.primary.data.extensions.world === '嵌入测试世界 世界书');
  // PNG 写读回环
  const png = buildPng();
  const out = PNGCard.writeCards(png, v3.chunks);
  const back = PNGCard.readCards(out).ccv3;
  ok('PNG 读回仍含 character_book 条目全文', back.data.character_book.entries[0].content.indexOf('永夜') !== -1);
  ok('PNG 读回 extensions.world', back.data.extensions.world === '嵌入测试世界 世界书');
  // ensureBookForExport 纯函数
  const prepared = M.ensureBookForExport(c);
  ok('ensureBookForExport 补名', prepared.name === '嵌入测试世界 世界书' && prepared.entries.length === 1);
  const emptyPrep = M.ensureBookForExport(M.emptyCard());
  ok('无条目时不虚构世界书名', emptyPrep.name === '' && emptyPrep.entries.length === 0);
})();


console.log(String.fromCharCode(10) + '全部通过：' + passed + ' 项断言 ✔');
