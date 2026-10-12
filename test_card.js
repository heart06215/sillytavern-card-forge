/*
 * test_card.js —— png-card.js 回环测试（Node 端）
 * 用法：node test_card.js
 * 产物：test_card_output.png（供 Pillow 独立交叉验证）
 */
'use strict';
const assert = require('assert');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const PNGCard = require('./png-card.js');

/* ---------- 用 zlib 现场构造一张 64x64 的渐变 PNG（不依赖任何外部文件） ---------- */
function buildTestPng(width, height) {
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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[p++] = Math.floor((x / width) * 255);
      raw[p++] = Math.floor((y / height) * 255);
      raw[p++] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 测试用 V2 角色卡（含中文、emoji、世界书） ---------- */
const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '测试角色🌸',
    description: '她是魔法学院的见习生，今年 18 岁。\n<外貌>银白色长发，琥珀色瞳孔</外貌>\n与 {{user}} 在图书馆初遇。',
    personality: '温柔、好奇、有点小迷糊',
    scenario: '雨后的魔法学院图书馆，窗外有猫头鹰飞过。',
    first_mes: '*她抱着书从书架后转出来，差点撞到你*\n啊——对不起！{{user}}，你也来还书吗？',
    mes_example: '<START>\n{{user}}: 你好\n{{char}}: *微微行礼* 你好，今天风很大呢。',
    alternate_greetings: ['*她从背后蒙住你的眼睛* 猜猜我是谁？', '*深夜的塔顶，她望着星空* 星星在唱歌呢。'],
    creator_notes: '仅供测试',
    system_prompt: '',
    post_history_instructions: '',
    character_book: {
      name: '测试世界书',
      entries: [{
        keys: ['魔法', 'magic'],
        content: '这个世界存在元素魔法，施法需要咏唱。',
        enabled: true,
        insertion_order: 10,
        case_sensitive: false,
        name: '',
        priority: 10,
        id: 0,
        comment: '世界观-魔法',
        selective: false,
        secondary_keys: [],
        constant: false,
        position: 'before_char',
        extensions: {}
      }],
      scan_depth: 2,
      token_budget: 250,
      recursive_scanning: false,
      extensions: {}
    },
    tags: ['测试', '魔法'],
    creator: 'tester',
    character_version: '1.0',
    extensions: {}
  }
};

let passed = 0;
function ok(label, cond) {
  if (!cond) throw new Error('测试失败：' + label);
  passed++;
  console.log('  ✔ ' + label);
}

console.log('== png-card.js 回环测试 ==');

// 1. 构造基础 PNG
const base = buildTestPng(64, 64);
ok('构造的测试 PNG 签名有效', PNGCard.isPng(base));

// 2. 写入角色卡
const withCard = PNGCard.writeCard(base, card);
ok('写入后仍为有效 PNG', PNGCard.isPng(withCard));

// 3. 读回校验（深比对）
const parsed = PNGCard.readCard(withCard);
assert(parsed, '读回结果不应为 null');
assert.strictEqual(JSON.stringify(parsed), JSON.stringify(card), '写读回环内容应完全一致');
ok('写→读回环：JSON 内容完全一致（含中文/emoji/世界书）', true);
passed++;

// 4. 块结构检查：恰好 1 个 tEXt，且紧跟 IHDR
const chunks = PNGCard.extractChunks(withCard);
const texts = chunks.filter(c => c.type === 'tEXt');
ok('tEXt 块恰好 1 个', texts.length === 1);
const ihdrIdx = chunks.findIndex(c => c.type === 'IHDR');
const textIdx = chunks.findIndex(c => c.type === 'tEXt');
ok('tEXt 紧跟 IHDR 之后', textIdx === ihdrIdx + 1);
ok('原有图像数据块（IDAT/IEND）保留', chunks.some(c => c.type === 'IDAT') && chunks[chunks.length - 1].type === 'IEND');

// 5. 重复写入不叠加
const rewritten = PNGCard.writeCard(withCard, card);
const texts2 = PNGCard.extractChunks(rewritten).filter(c => c.type === 'tEXt');
ok('重复写入后 tEXt 仍恰好 1 个（旧卡已剥离）', texts2.length === 1);
assert.strictEqual(JSON.stringify(PNGCard.readCard(rewritten)), JSON.stringify(card));
ok('重复写入后读回仍一致', true);
passed++;

// 6. 非 PNG 输入报错
let threw = false;
try { PNGCard.readCard(Buffer.from('not a png')); } catch (e) { threw = true; }
ok('非 PNG 输入正确抛错', threw);

// 7. V1 平铺卡归一化
const v1 = { name: '老卡', description: 'V1 描述', personality: 'P', first_mes: 'hi' };
const v2 = PNGCard.toV2Card(v1);
ok('V1 卡归一化为 V2 结构', v2.spec === 'chara_card_v2' && v2.data.name === '老卡');

// 8. 输出文件供 Pillow 交叉验证
const outPath = path.join(__dirname, 'test_card_output.png');
fs.writeFileSync(outPath, Buffer.from(withCard));
console.log('\n已输出 ' + outPath + ' （供 Pillow 交叉验证）');

/* ---------- 新增：V3 双数据块（ccv3 + chara）与多块读写 ---------- */
console.log('\n== V3 / 多数据块测试 ==');

const v3card = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  name: 'V3测试角色',
  description: 'V3 desc',
  personality: 'p',
  scenario: 's',
  first_mes: 'hi',
  mes_example: '',
  creatorcomment: 'notes',
  avatar: 'none',
  talkativeness: '0.5',
  fav: false,
  tags: ['测试'],
  create_date: '2026-01-01T00:00:00.000Z',
  data: {
    name: 'V3测试角色', description: 'V3 desc', personality: 'p', scenario: 's',
    first_mes: 'hi', mes_example: '', creator_notes: 'notes', system_prompt: '',
    post_history_instructions: '', tags: ['测试'], creator: 'tester', character_version: '1.0',
    alternate_greetings: [], group_only_greetings: ['群聊开场白'],
    character_book: { name: 'b', entries: [], scan_depth: 2, token_budget: 500, recursive_scanning: false, extensions: {} },
    extensions: { depth_prompt: { prompt: 'depth', depth: 4, role: 'system' }, regex_scripts: [] }
  }
};
const v2legacy = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'V3测试角色', description: 'V3 desc' } };

const multi = PNGCard.writeCards(base, { ccv3: v3card, chara: v2legacy });
ok('writeCards 后仍为有效 PNG', PNGCard.isPng(multi));

const multiChunks = PNGCard.extractChunks(multi).filter(c => c.type === 'tEXt');
ok('writeCards 写入恰好 2 个 tEXt（ccv3 + chara）', multiChunks.length === 2);

const readBack = PNGCard.readCards(multi);
ok('readCards 能读回 ccv3 块', readBack.ccv3 && readBack.ccv3.spec === 'chara_card_v3');
ok('readCards 能读回 chara 块', readBack.chara && readBack.chara.spec === 'chara_card_v2');
assert.strictEqual(JSON.stringify(readBack.ccv3), JSON.stringify(v3card), 'ccv3 内容应完全一致');
ok('ccv3 写读回环一致（含 group_only_greetings / depth_prompt）', true);
passed++;

ok('readCard 在有 ccv3 时优先返回 V3 卡', PNGCard.readCard(multi).spec === 'chara_card_v3');

// 重写应剥离旧的两块，不叠加
const multi2 = PNGCard.writeCards(multi, { ccv3: v3card, chara: v2legacy });
ok('重复 writeCards 后 tEXt 仍恰好 2 个（旧块已剥离）',
  PNGCard.extractChunks(multi2).filter(c => c.type === 'tEXt').length === 2);

// toV2Card 保留 group_only_greetings
const lifted = PNGCard.toV2Card(v3card);
ok('toV2Card(V3) 保留 group_only_greetings', Array.isArray(lifted.data.group_only_greetings) && lifted.data.group_only_greetings[0] === '群聊开场白');

console.log('\n全部通过：' + passed + ' 项断言 ✔');
