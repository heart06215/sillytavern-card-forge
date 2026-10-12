/*
 * png-card.js —— SillyTavern 角色卡 PNG 元数据读写库（零依赖，浏览器/Node 双端可用）
 *
 * 功能：把符合 Character Card V2 规范的角色卡 JSON 以 base64 编码写入 PNG 图片的
 * tEXt 块（关键字 chara，与 SillyTavern / V1·V2 社区规范一致），并支持读回解析。
 *
 * 浏览器：<script src="png-card.js"></script> → 全局对象 PNGCard
 * Node：  const PNGCard = require('./png-card.js')
 */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PNGCard = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  var CARD_KEYWORD = 'chara'; // SillyTavern 读取角色卡的 tEXt 关键字
  var STRIP_KEYWORDS = ['chara', 'ccv3']; // 重写时需清除的旧卡片数据，避免叠加

  /* ---------------- CRC32（PNG 规范） ---------------- */

  var CRC_TABLE = null;

  function makeCrcTable() {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    if (!CRC_TABLE) CRC_TABLE = makeCrcTable();
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------------- 字节工具 ---------------- */

  function u32be(n) {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }

  function latin1ToBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function bytesToLatin1(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined' && Buffer.from) {
      return Buffer.from(bytes).toString('base64');
    }
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    if (typeof Buffer !== 'undefined' && Buffer.from) {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function utf8ToBytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf-8'));
  }

  function bytesToUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf-8');
  }

  /* ---------------- PNG 块级操作 ---------------- */

  function isPng(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (var i = 0; i < 8; i++) {
      if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    }
    return true;
  }

  // 把 PNG 拆成 [{type, data}]；data 不含长度/类型/CRC
  function extractChunks(bytes) {
    if (!isPng(bytes)) throw new Error('不是有效的 PNG 文件（PNG 签名校验失败）');
    var chunks = [];
    var pos = 8;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (pos + 8 <= bytes.length) {
      var length = dv.getUint32(pos);
      var type = bytesToLatin1(bytes.subarray(pos + 4, pos + 8));
      var dataStart = pos + 8;
      var dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) throw new Error('PNG 数据损坏：块长度越界');
      chunks.push({ type: type, data: bytes.subarray(dataStart, dataEnd) });
      pos = dataEnd + 4; // 跳过 CRC
      if (type === 'IEND') break;
    }
    if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND') {
      throw new Error('PNG 数据损坏：缺少 IEND 结束块');
    }
    return chunks;
  }

  function buildChunk(type, data) {
    var typeBytes = latin1ToBytes(type);
    var out = new Uint8Array(12 + data.length);
    out[0] = (data.length >>> 24) & 0xff;
    out[1] = (data.length >>> 16) & 0xff;
    out[2] = (data.length >>> 8) & 0xff;
    out[3] = data.length & 0xff;
    out.set(typeBytes, 4);
    out.set(data, 8);
    var crc = crc32(out.subarray(4, 8 + data.length));
    var crcBytes = u32be(crc);
    out[8 + data.length] = crcBytes[0];
    out[9 + data.length] = crcBytes[1];
    out[10 + data.length] = crcBytes[2];
    out[11 + data.length] = crcBytes[3];
    return out;
  }

  // tEXt 块数据布局：keyword + 0x00 + text（均为 Latin-1）
  function textChunkData(keyword, text) {
    var kw = latin1ToBytes(keyword);
    var tx = latin1ToBytes(text);
    var data = new Uint8Array(kw.length + 1 + tx.length);
    data.set(kw, 0);
    data[kw.length] = 0x00;
    data.set(tx, kw.length + 1);
    return data;
  }

  function splitTextChunk(data) {
    var zero = -1;
    for (var i = 0; i < data.length; i++) {
      if (data[i] === 0x00) { zero = i; break; }
    }
    if (zero < 0) return null;
    return {
      keyword: bytesToLatin1(data.subarray(0, zero)),
      text: bytesToLatin1(data.subarray(zero + 1))
    };
  }

  function rebuildBytes(chunkList) {
    var total = 8;
    var built = [];
    for (var i = 0; i < chunkList.length; i++) {
      var c = buildChunk(chunkList[i].type, chunkList[i].data);
      built.push(c);
      total += c.length;
    }
    var out = new Uint8Array(total);
    out.set(PNG_SIGNATURE, 0);
    var pos = 8;
    for (var j = 0; j < built.length; j++) {
      out.set(built[j], pos);
      pos += built[j].length;
    }
    return out;
  }

  /* ---------------- 对外主接口 ---------------- */

  // 把多个卡片数据块写入 PNG（如 V3 卡同时写 chara + ccv3）。
  // cardsMap：{ 关键字: 对象或 JSON 字符串 }；空值（null/''）会被跳过。
  // 返回新的 Uint8Array（原图片不受影响），并剥离旧的 chara/ccv3 数据。
  function writeCards(pngBytes, cardsMap) {
    cardsMap = cardsMap || {};
    var chunks = extractChunks(pngBytes);

    var kept = [];
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      if (c.type === 'tEXt') {
        var kv = splitTextChunk(c.data);
        if (kv && STRIP_KEYWORDS.indexOf(kv.keyword) !== -1) continue; // 剥离旧卡数据
      }
      kept.push(c);
    }

    var fresh = [];
    Object.keys(cardsMap).forEach(function (kw) {
      var v = cardsMap[kw];
      if (v == null || v === '') return;
      var json = typeof v === 'string' ? v : JSON.stringify(v);
      fresh.push({ type: 'tEXt', data: textChunkData(kw, bytesToBase64(utf8ToBytes(json))) });
    });

    var out = [];
    var inserted = false;
    for (var j = 0; j < kept.length; j++) {
      out.push(kept[j]);
      if (kept[j].type === 'IHDR') { // 惯例：紧跟 IHDR 之后
        for (var k = 0; k < fresh.length; k++) out.push(fresh[k]);
        inserted = true;
      }
    }
    if (!inserted) throw new Error('PNG 缺少 IHDR 块，文件可能已损坏');
    return rebuildBytes(out);
  }

  // 把单个角色卡对象（或 JSON 字符串）写入 PNG，返回新的 Uint8Array（原图片不受影响）
  function writeCard(pngBytes, cardObj) {
    var map = {};
    map[CARD_KEYWORD] = cardObj;
    return writeCards(pngBytes, map);
  }

  // 从 PNG 读回全部角色卡数据块：{ chara: {...}, ccv3: {...} }
  function readCards(pngBytes) {
    var chunks = extractChunks(pngBytes);
    var res = {};
    for (var i = 0; i < chunks.length; i++) {
      if (chunks[i].type !== 'tEXt') continue;
      var kv = splitTextChunk(chunks[i].data);
      if (!kv || STRIP_KEYWORDS.indexOf(kv.keyword) === -1) continue;
      var parsed = decodeCardText(kv.text);
      if (parsed != null) res[kv.keyword] = parsed;
    }
    return res;
  }

  function decodeCardText(text) {
    var payload = String(text).trim();
    var json;
    try {
      json = bytesToUtf8(base64ToBytes(payload));
    } catch (e) {
      json = payload; // 兼容极少数未做 base64 的旧工具
    }
    try { return JSON.parse(json); } catch (e) { return null; }
  }

  // 从 PNG 读回角色卡 JSON 对象；没有则返回 null。
  // V3 卡优先返回 ccv3 块（含 group_only_greetings 等 V3 字段），否则返回 chara 块。
  function readCard(pngBytes) {
    var cards = readCards(pngBytes);
    return cards.ccv3 || cards[CARD_KEYWORD] || null;
  }

  // 归一化为 V2 结构：兼容 V1 平铺卡与 V3 卡
  function toV2Card(parsed) {
    if (!parsed || typeof parsed !== 'object') throw new Error('角色卡数据不是有效的 JSON 对象');
    if (parsed.spec === 'chara_card_v2' && parsed.data) return parsed;
    if (parsed.spec === 'chara_card_v3' && parsed.data) {
      var v3 = parsed.data;
      var keep = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
        'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
        'group_only_greetings', 'tags', 'creator', 'character_version', 'extensions'];
      var data = {};
      for (var i = 0; i < keep.length; i++) {
        if (v3[keep[i]] !== undefined) data[keep[i]] = v3[keep[i]];
      }
      if (v3.character_book && Array.isArray(v3.character_book.entries)) {
        data.character_book = v3.character_book;
      }
      return { spec: 'chara_card_v2', spec_version: '2.0', data: data };
    }
    // V1：字段平铺在顶层
    var flat = parsed;
    var v2Data = {
      name: flat.name || '',
      description: flat.description || '',
      personality: flat.personality || '',
      scenario: flat.scenario || '',
      first_mes: flat.first_mes || '',
      mes_example: flat.mes_example || ''
    };
    var optional = ['creator_notes', 'system_prompt', 'post_history_instructions',
      'alternate_greetings', 'group_only_greetings', 'character_book', 'tags', 'creator', 'character_version', 'extensions'];
    for (var k = 0; k < optional.length; k++) {
      if (flat[optional[k]] !== undefined) v2Data[optional[k]] = flat[optional[k]];
    }
    return { spec: 'chara_card_v2', spec_version: '2.0', data: v2Data };
  }

  return {
    isPng: isPng,
    extractChunks: extractChunks,
    buildChunk: buildChunk,
    writeCard: writeCard,
    writeCards: writeCards,
    readCard: readCard,
    readCards: readCards,
    decodeCardText: decodeCardText,
    toV2Card: toV2Card,
    crc32: crc32,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    utf8ToBytes: utf8ToBytes,
    bytesToUtf8: bytesToUtf8
  };
});
