/**
 * 中国移动（Surge 面板版）
 *
 * 话费 / 流量 / 语音余量面板 + 登录参数捕获 + 会话保活，单文件三模式（靠 Surge 全局变量分发）：
 *   1. type=panel          → 面板：显示剩余话费 / 剩余流量 / 剩余语音 + 用量洞察
 *   2. type=http-request   → 登录捕获：在「中国移动」App 里用短信验证码登录一次，
 *                            自动存下加密参数（params）、x-qen 与 Cookie
 *   3. type=http-response  → Cookie 刷新：自动从登录响应里抓 Set-Cookie
 *   4. type=cron           → 每 20 分钟保活查询一次，防止会话被注销
 *
 * 适配自 Aswoth/Egern--Widget 的 china-mobile-hark-merged-glass.js
 * （Hark 融合改版 v23，原作 zhaohantao1360-hash；数据层逆向自
 *   ChinaTelecomOperators/ChinaMobile 的 10086.js，加解密已验证）。
 * 数据层（自研 MD5/AES-128 加解密、x-token/x-sign 签名、响应解密、
 * autoLogin 重放续期、用量洞察与每日快照）逻辑原样搬运，只换了平台 API 外壳；
 * 原 Egern 的 Widget DSL / SVG 渲染层整体丢弃，换成 Surge 面板文字渲染。
 *
 * 模块参数（对应原 Egern 版 Env）：
 *   CM_PHONENUMBER     移动手机号（11 位；不填则用已保存的号码）
 *   CM_CAPTURE         抓取开关（默认 true；false = 完全不抓，过期也不会自动恢复）
 *   CM_CAPTURE_NOTIFY  'true' 每次抓到都通知（默认只在首次/过期恢复时通知）
 *   CM_KEEPALIVE       'true' 走保活模式（模块里 cron 条目自动带上，面板条目不要带）
 *   CM_SHOW_USED_FLOW  'true' 显示已用流量，否则显示剩余流量（默认剩余）
 *   CM_TITLE           面板标题，默认 "中国移动"
 *   CM_DEBUG           'true' 在面板上显示调试信息
 *
 * 数据来源：
 *   https://app.10086.cn/biz-orange/BN/realFeeQuery/getRealFee
 *   https://app.10086.cn/biz-orange/BH/newPlanRemainQry/getNewPlanRemainQry
 */

'use strict';

/* ==================== Surge 垫片：把原版 ctx 接口映射到 Surge 全局 ==================== */

// $argument → env 对象：兼容对象 / JSON 串 / key=value&key=value 三种形态，值统一转字符串
function parseArgument() {
  const env = {};
  try {
    let arg = (typeof $argument !== 'undefined') ? $argument : null;
    if (arg == null || arg === '') return env;
    if (typeof arg === 'object') {
      for (const k of Object.keys(arg)) env[k] = String(arg[k]);
      return env;
    }
    arg = String(arg).trim();
    if (arg.charAt(0) === '{') {
      try {
        const obj = JSON.parse(arg);
        for (const k of Object.keys(obj)) env[k] = String(obj[k]);
        return env;
      } catch (e) { /* 不是 JSON，继续按 k=v 解析 */ }
    }
    for (const part of arg.split('&')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      let v = part.slice(i + 1).trim();
      try { v = decodeURIComponent(v); } catch (e) {}
      if (k) env[k] = v;
    }
  } catch (e) {}
  return env;
}

const CM_ENV = parseArgument();

// ctx.storage → $persistentStore（注意 Surge 的 write 是 (值, 键) 顺序）
const CM_STORE = {
  get(key) {
    try {
      const v = $persistentStore.read(key);
      return v == null ? null : v;
    } catch (e) { return null; }
  },
  set(key, value) {
    try { $persistentStore.write(String(value), key); } catch (e) {}
  },
  getJSON(key) {
    try {
      const v = $persistentStore.read(key);
      if (v == null || v === '') return null;
      return JSON.parse(v);
    } catch (e) { return null; }
  },
  setJSON(key, obj) {
    try { $persistentStore.write(JSON.stringify(obj), key); } catch (e) {}
  },
};

// ctx.http.post(url, {headers, body, timeout 毫秒}) → $httpClient.post（回调式转 Promise，timeout 转秒）
// 返回 {status, headers, body, text()}，网络错误时 reject（与原版 fetch 风格一致）
const CM_HTTP = {
  post(url, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const req = { url };
      if (opts.headers) req.headers = opts.headers;
      if (opts.body != null) req.body = opts.body;
      if (opts.timeout) req.timeout = Math.max(1, Math.round(opts.timeout / 1000));
      try {
        $httpClient.post(req, (error, response, data) => {
          if (error) { reject(new Error(String(error))); return; }
          const body = data == null ? '' : (typeof data === 'string' ? data : String(data));
          resolve({
            status: response ? response.status : 0,
            headers: response ? (response.headers || {}) : {},
            body,
            text: () => Promise.resolve(body),
          });
        });
      } catch (e) { reject(e); }
    });
  },
};

function buildCtx() {
  const ctx = {
    env: CM_ENV,
    storage: CM_STORE,
    http: CM_HTTP,
    notify(o) {
      try { $notification.post((o && o.title) || '中国移动', '', (o && o.body) || ''); } catch (e) {}
    },
    widgetFamily: 'systemMedium', // Surge 无小组件尺寸概念，仅占位
  };
  try { if (typeof $request !== 'undefined' && $request) ctx.request = $request; } catch (e) {}
  try { if (typeof $response !== 'undefined' && $response) ctx.response = $response; } catch (e) {}
  return ctx;
}

/* ==================== 加解密（原版自研实现，与 cm_crypto.js 同步，经 node:crypto 验证） ==================== */

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

function utf8String(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i++; }
    else if ((b & 0xe0) === 0xc0) { s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if ((b & 0xf0) === 0xe0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
    else {
      const c = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const v = c - 0x10000;
      s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return s;
}

function bytesToHex(bytes) {
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

const B64MAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    s += B64MAP[(n >> 18) & 63] + B64MAP[(n >> 12) & 63] + (i + 1 < bytes.length ? B64MAP[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64MAP[n & 63] : '=');
  }
  return s;
}

/* ---------- MD5 ---------- */

function md5Hex(str) {
  const msg = utf8Bytes(str);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 0; i < 8; i++) msg.push((bitLen / Math.pow(2, i * 8)) & 0xff);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

  const add = (x, y) => (x + y) >>> 0;
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

  for (let off = 0; off < msg.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M.push((msg[off + i * 4] | (msg[off + i * 4 + 1] << 8) | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24)) >>> 0);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = add(add(add(F, A), K[i]), M[g]);
      A = D; D = C; C = B;
      B = add(B, rol(F, S[i]));
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  const le = (x) => [x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >> 24) & 0xff];
  return bytesToHex([].concat(le(a0), le(b0), le(c0), le(d0)));
}

/* ---------- AES-128 ---------- */

const AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
const AES_INV_SBOX = new Array(256);
for (let i = 0; i < 256; i++) AES_INV_SBOX[AES_SBOX[i]] = i;
const AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

function aesKeyExpand(keyBytes) {
  const Nk = 4, Nb = 4, Nr = 10;
  const W = new Array(4 * (Nr + 1));
  for (let i = 0; i < Nk; i++) {
    W[i] = (keyBytes[4*i] << 24) | (keyBytes[4*i+1] << 16) | (keyBytes[4*i+2] << 8) | keyBytes[4*i+3];
  }
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let t = W[i - 1];
    if (i % Nk === 0) {
      t = ((AES_SBOX[(t >> 16) & 0xff] << 24) | (AES_SBOX[(t >> 8) & 0xff] << 16) | (AES_SBOX[t & 0xff] << 8) | AES_SBOX[(t >> 24) & 0xff]) ^ (AES_RCON[i / Nk - 1] << 24);
    }
    W[i] = (W[i - Nk] ^ t) >>> 0;
  }
  return W;
}

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

function aesAddRoundKey(s, W, round) {
  for (let c = 0; c < 4; c++) {
    const w = W[round * 4 + c];
    s[c*4+0] ^= (w >>> 24) & 0xff;
    s[c*4+1] ^= (w >>> 16) & 0xff;
    s[c*4+2] ^= (w >>> 8) & 0xff;
    s[c*4+3] ^= w & 0xff;
  }
}
function aesSubBytes(s, inv) {
  const box = inv ? AES_INV_SBOX : AES_SBOX;
  for (let i = 0; i < 16; i++) s[i] = box[s[i]];
}
function aesShiftRows(s, inv) {
  // state 按列存放: s[c*4+r]
  const t = s.slice();
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const shift = inv ? (4 - r) % 4 : r;
      s[c*4+r] = t[((c + shift) % 4)*4+r];
    }
  }
}
function aesMixColumns(s, inv) {
  for (let c = 0; c < 4; c++) {
    const a = [s[c*4], s[c*4+1], s[c*4+2], s[c*4+3]];
    let b;
    if (!inv) {
      b = [gmul(a[0],2)^gmul(a[1],3)^a[2]^a[3],
            a[0]^gmul(a[1],2)^gmul(a[2],3)^a[3],
            a[0]^a[1]^gmul(a[2],2)^gmul(a[3],3),
            gmul(a[0],3)^a[1]^a[2]^gmul(a[3],2)];
    } else {
      b = [gmul(a[0],14)^gmul(a[1],11)^gmul(a[2],13)^gmul(a[3],9),
            gmul(a[0],9)^gmul(a[1],14)^gmul(a[2],11)^gmul(a[3],13),
            gmul(a[0],13)^gmul(a[1],9)^gmul(a[2],14)^gmul(a[3],11),
            gmul(a[0],11)^gmul(a[1],13)^gmul(a[2],9)^gmul(a[3],14)];
    }
    for (let r = 0; r < 4; r++) s[c*4+r] = b[r];
  }
}

function aesEncryptBlock(block16, W) {
  const s = block16.slice();
  aesAddRoundKey(s, W, 0);
  for (let r = 1; r < 10; r++) {
    aesSubBytes(s, false); aesShiftRows(s, false); aesMixColumns(s, false); aesAddRoundKey(s, W, r);
  }
  aesSubBytes(s, false); aesShiftRows(s, false); aesAddRoundKey(s, W, 10);
  return s;
}

function aesDecryptBlock(block16, W) {
  const s = block16.slice();
  aesAddRoundKey(s, W, 10);
  for (let r = 9; r >= 1; r--) {
    aesShiftRows(s, true); aesSubBytes(s, true); aesAddRoundKey(s, W, r); aesMixColumns(s, true);
  }
  aesShiftRows(s, true); aesSubBytes(s, true); aesAddRoundKey(s, W, 0);
  return s;
}

/* AES-128-CBC，key/iv 为字符串（按 UTF-8 取 16 字节） */
function aesCbcEncrypt(plainStr, keyStr, ivStr) {
  const key = utf8Bytes(keyStr).slice(0, 16);
  const iv = utf8Bytes(ivStr).slice(0, 16);
  let data = utf8Bytes(plainStr);
  const pad = 16 - (data.length % 16);
  for (let i = 0; i < pad; i++) data.push(pad);
  const W = aesKeyExpand(key);
  let prev = iv;
  const out = [];
  for (let off = 0; off < data.length; off += 16) {
    const block = [];
    for (let i = 0; i < 16; i++) block.push(data[off + i] ^ prev[i]);
    const enc = aesEncryptBlock(block, W);
    out.push(...enc);
    prev = enc;
  }
  return out;
}

function aesCbcDecrypt(cipherBytes, keyStr, ivStr) {
  const key = utf8Bytes(keyStr).slice(0, 16);
  const iv = utf8Bytes(ivStr).slice(0, 16);
  const W = aesKeyExpand(key);
  let prev = iv;
  const out = [];
  for (let off = 0; off < cipherBytes.length; off += 16) {
    const block = cipherBytes.slice(off, off + 16);
    const dec = aesDecryptBlock(block, W);
    for (let i = 0; i < 16; i++) out.push(dec[i] ^ prev[i]);
    prev = block;
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 16) throw new Error('bad padding');
  for (let i = 0; i < pad; i++) {
    if (out[out.length - 1 - i] !== pad) throw new Error('bad padding');
  }
  return out.slice(0, out.length - pad);
}

/* 对外接口：与原脚本语义一致（key/iv 作 UTF-8，输出 base64） */
function cmEncrypt(plainStr, keyStr, ivStr) {
  return base64Encode(aesCbcEncrypt(plainStr, keyStr, ivStr || '9791027341711819'));
}

function cmDecrypt(b64Str, keyStr, ivStr) {
  const raw = String(b64Str).replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes = [];
  for (let i = 0; i < raw.length; i += 4) {
    const c = [0,1,2,3].map((k) => (raw[i+k] === '=' || !raw[i+k] ? 0 : B64MAP.indexOf(raw[i+k])));
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const padCount = (raw.match(/=+$/) || [''])[0].length;
  const trimmed = bytes.slice(0, bytes.length - padCount);
  return utf8String(aesCbcDecrypt(trimmed, keyStr, ivStr || '9791027341711819'));
}

function cmMd5(str) { return md5Hex(str); }

/* ==================== 常量（逆向所得） ==================== */

// 捕获参数的解密密钥（按 x-qen 选择）
const REQ_KEY = { '2': 'bAIgvwAuA4tbDr9d', '12': 'V0dSUFZtS1NWRnJa', '14': 'tVkdaRWRY0ZkV1Vr' };
const REQ_IV  = { '2': '9791027341711819', '12': 'UkdWMVpWTVVWaGVq', '14': 'VjFSQ1ZtVkQxRTlQ' };
// 查询请求/响应的加解密（x-qen 固定为 '1'）
const REQ1_KEY = 'foorettD7vcBawt3';
// autoLogin 换会话用的 x-token 密钥：登录接口与查询接口不同（查询用 REQ1_KEY）
const TOK_KEY = 'bAIgvwAuA4tbDr9d';
const RESP1_KEY = 'UVic06tpXgMNiApm';
const RESP2_KEY = 'GS7VelkJl5IT1uwQ';
const RESP14_KEY = 'RYV0hCV1lV25KYVJ';
const RESP14_IV = 'VjFSQ1ZtVkQxRTlQ';
const DEFAULT_IV = '9791027341711819';

const API_FEE = 'https://app.10086.cn/biz-orange/BN/realFeeQuery/getRealFee';
const API_PLAN = 'https://app.10086.cn/biz-orange/BH/newPlanRemainQry/getNewPlanRemainQry';
const UA_WAP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/9.2.5/CMCCIT';

const STORE = {
  paramsEnc: 'cm_params_enc',   // 捕获的 autoLogin 加密请求体
  xqen: 'cm_x_qen',             // 捕获的 x-qen（'2'/'12'/'14'）
  loginUrl: 'cm_login_url',     // 捕获的 autoLogin URL
  cookie: 'cm_cookie',          // Cookie / Set-Cookie
  loginTs: 'cm_login_ts',
  loginHeaders: 'cm_login_headers', // 捕获的 autoLogin 请求头（用于自动续期）
  refreshTs: 'cm_refresh_ts',       // 上次自动续期时间
  datasource: 'cm_datasource',
  rawDebug: 'cm_raw_debug',
  planDebug: 'cm_plan_debug',
};

/* ==================== 工具 ==================== */

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    try {
      const v = headers.get(name);
      if (v) return v;
    } catch (e) { /* ignore */ }
  }
  if (typeof headers.getSetCookie === 'function' && /set-cookie/i.test(name)) {
    try { return headers.getSetCookie().join('; '); } catch (e) { /* ignore */ }
  }
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) {
      const v = headers[k];
      return Array.isArray(v) ? v.join('; ') : (v || '');
    }
  }
  return '';
}

function maskSecret(s, keep = 6) {
  s = String(s || '');
  if (s.length <= keep * 2) return s.slice(0, keep) + '***';
  return s.slice(0, keep) + '***' + s.slice(-keep);
}

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/* ==================== 捕获 ==================== */

function isAutoLogin(url) {
  // 新主机 10086.online-cmcc.cn：只认登录/会话刷新路径。
  // 之前整站放行，App 里的 queryCardInfo 等普通查询会覆盖掉 autoLogin 模板，
  // 导致查询参数错（empty plan）、续期重放的也不是登录接口。
  if (/10086\.online-cmcc\.cn/.test(url)) return /(autoLogin|refreshSession|\/login)/i.test(url.replace(/\?.*$/, ''));
  // 老主机：autoLogin（登录）与 refreshSession（会话刷新，App 自动调用）都认
  return /client\.app\.coc\.10086\.cn/.test(url) &&
    /\/biz-orange\/[A-Z]{2}\/.*(autoLogin|refreshSession)/.test(url);
}

function dlog(ctx, msg) {
  // 侦察日志常开：只记方法+路径，不记查询参数与正文
  if (typeof console !== 'undefined' && console.log) {
    try { console.log(`[CM] ${msg}`); } catch (e) {}
  }
}

// http_request：在 App 登录时抓加密参数
async function handleCapture(ctx) {
  const req = ctx.request || {};
  const url = req.url || '';
  const headers = req.headers || {};
  const xqen = String(getHeader(headers, 'x-qen') || '').trim();
  const qmark = url.indexOf('?');
  dlog(ctx, `REQ ${req.method || ''} ${(qmark > 0 ? url.slice(0, qmark) : url).slice(0, 200)} x-qen=${xqen || '-'}`);
  dlog(ctx, `req keys=${Object.keys(req).join(',')}`);
  try {
    const g = (typeof $request !== 'undefined' && $request && $request.body);
    dlog(ctx, `global $request.body type=${g ? typeof g : 'n/a'} len=${g && g.length !== undefined ? g.length : 'n/a'}`);
  } catch (e) { dlog(ctx, `global $request 不可用`); }
  if (!isAutoLogin(url)) return;
  if (!REQ_KEY[xqen]) {
    dlog(ctx, `跳过：x-qen=${xqen || '(空)'} 不在 {2,12,14}`);
    return; // 只收 2/12/14 三种加密形态
  }

  // Egern ESM 的 ctx.request.body 可能是空对象，真正的 body 在传统全局 $request.body 里
  let rawBody = '';
  try {
    if (typeof $request !== 'undefined' && $request && typeof $request.body === 'string' && $request.body.length > 0) {
      rawBody = $request.body;
    }
  } catch (e) {}
  if (!rawBody) {
    const cb = req.body;
    rawBody = typeof cb === 'string' ? cb : JSON.stringify(cb || '');
  }
  const body = rawBody;
  dlog(ctx, `body类型=${typeof req.body} 长度=${body.length} base64=${/^[A-Za-z0-9+/=\r\n]+$/.test(body)}`);
  if (!body || body.length < 16) return;

  // 先验证能解密，防存坏数据；x-qen 指示的优先，不行就把所有已知组合试一遍
  let plain = null, usedQen = null;
  const tryOrder = [xqen, '2', '12', '14'].filter((v, i, a) => REQ_KEY[v] && a.indexOf(v) === i);
  for (const q of tryOrder) {
    try {
      const p = cmDecrypt(body, REQ_KEY[q], REQ_IV[q]);
      JSON.parse(p);
      plain = p; usedQen = q; break;
    } catch (e) { /* 换下一个组合试 */ }
  }
  if (!plain) {
    dlog(ctx, `解密失败（已试 ${tryOrder.join(',')}），跳过`);
    return;
  }
  dlog(ctx, `解密OK（x-qen=${usedQen}），顶层字段: ${Object.keys(JSON.parse(plain)).join(',').slice(0, 120)}`);

  const prevEnc = ctx.storage.get(STORE.paramsEnc);
  const changed = prevEnc !== body;
  // 只在首次抓到、或登录过期后恢复时提醒；平时静默更新（CM_CAPTURE_NOTIFY=true 可恢复每次提醒）
  const wasExpired = (ctx.storage.get('cm_expire_notify') || '0') !== '0';
  const shouldNotify = !prevEnc || wasExpired || ((ctx.env || {}).CM_CAPTURE_NOTIFY === 'true');
  ctx.storage.set(STORE.paramsEnc, body);
  ctx.storage.set(STORE.xqen, usedQen);
  ctx.storage.set(STORE.loginUrl, url);
  const cookie = String(getHeader(headers, 'cookie') || '').trim();
  if (cookie) ctx.storage.set(STORE.cookie, cookie);
  // 记下登录请求头，登录过期时用来自动重放续期
  try {
    const keep = {};
    const src = typeof headers.entries === 'function' ? Object.fromEntries(headers.entries()) : headers;
    for (const k of Object.keys(src || {})) {
      if (/^(cookie|content-length|connection|accept-encoding)$/i.test(k)) continue;
      keep[k] = Array.isArray(src[k]) ? src[k].join(', ') : String(src[k]);
    }
    ctx.storage.setJSON(STORE.loginHeaders, keep);
  } catch (e) {}

  if (changed) {
    ctx.storage.set(STORE.loginTs, String(Date.now()));
    ctx.storage.set('cm_expire_fails', '0');
    if (shouldNotify) {
      ctx.notify({ title: '中国移动', body: wasExpired ? '登录已恢复，小组件将自动更新' : '登录参数捕获成功，小组件将自动更新' });
      if (wasExpired) ctx.storage.set('cm_expire_notify', '0');
    }
    // 自检：用刚抓到的参数试一次话费查询，结果打日志（只在新捕获时跑一次）
    try {
      const params = JSON.parse(plain);
      const q = buildQuery(ctx, params, 'fee');
      dlog(ctx, `自检查询开始`);
      const resp = await ctx.http.post(q.url, { headers: q.headers, body: q.body, timeout: 15000 });
      dlog(ctx, `自检 HTTP=${resp ? resp.status : 'no-resp'}`);
      if (resp && resp.status === 200) {
        const text = typeof resp.text === 'function' ? await resp.text() : String(resp.body || '');
        const xpen = String(getHeader(resp.headers, 'x-pen') || '').trim();
        dlog(ctx, `自检 x-pen=${xpen} len=${text.length}`);
        let data;
        if (xpen === '1') {
          const inner = JSON.parse(text);
          data = JSON.parse(cmDecrypt(inner.body, RESP1_KEY, DEFAULT_IV));
        } else if (xpen === '2') {
          data = JSON.parse(cmDecrypt(text, RESP2_KEY, DEFAULT_IV));
        } else if (xpen === '14') {
          data = JSON.parse(cmDecrypt(text, RESP14_KEY, RESP14_IV));
        } else {
          data = JSON.parse(text);
        }
        const feeInfo = (data && (data.rspBody || (data.body && data.body.rspBody))) || {};
        dlog(ctx, `自检话费=${feeInfo.realBalanceFee || feeInfo.curFee || 'N/A'} ret=${(data && (data.retCode || '')) || ''}`);
      }
    } catch (e) {
      dlog(ctx, `自检失败: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }
}

// http_response：从登录响应里抓 Set-Cookie（保鲜）
async function handleRespCapture(ctx) {
  const req = ctx.request || {};
  const resp = ctx.response || {};
  const url = req.url || resp.url || '';
  if (!isAutoLogin(url)) return;
  // ESM 的 ctx.response.headers 可能为空，兜底读传统全局 $response
  let respHeaders = resp.headers || {};
  try {
    if (typeof $response !== 'undefined' && $response && $response.headers) {
      const gh = $response.headers;
      if (!respHeaders['set-cookie'] && !respHeaders['Set-Cookie'] && (gh['set-cookie'] || gh['Set-Cookie'])) {
        respHeaders = gh;
      }
    }
  } catch (e) {}
  const setCookie = String(getHeader(respHeaders, 'set-cookie') || '').trim();
  if (setCookie && ctx.storage.get(STORE.cookie) !== setCookie) {
    ctx.storage.set(STORE.cookie, setCookie);
  }
}

/* ==================== 数据层 ==================== */


// 手机号：优先读 Env，Env 为空时用本地备份；Env 里填了就备份到本地
function getPhone(ctx) {
  const fromEnv = (ctx.env.CM_PHONENUMBER || '').trim();
  if (/^\d{11}$/.test(fromEnv)) {
    try { ctx.storage.set('cm_phone_backup', fromEnv); } catch (e) {}
    return fromEnv;
  }
  try {
    const bak = (ctx.storage.get('cm_phone_backup') || '').trim();
    if (/^\d{11}$/.test(bak)) return bak;
  } catch (e) {}
  return '';
}

function decryptParams(ctx) {
  const enc = ctx.storage.get(STORE.paramsEnc) || '';
  const xqen = (ctx.storage.get(STORE.xqen) || '').trim();
  if (!enc || !REQ_KEY[xqen]) {
    const e = new Error('no-params');
    e.stage = 'capture';
    throw e;
  }
  const plain = cmDecrypt(enc, REQ_KEY[xqen], REQ_IV[xqen]);
  const params = JSON.parse(plain);
  return params;
}

function buildQuery(ctx, params, kind) {
  const phone = getPhone(ctx);
  if (!/^\d{11}$/.test(phone)) {
    const e = new Error('no-phone');
    e.stage = 'phone';
    throw e;
  }
  const cookie = ctx.storage.get(STORE.cookie) || '';
  const ts = Date.now();
  const nonce = randomDigits(8);
  const pathname = kind === 'fee'
    ? '/biz-orange/BN/realFeeQuery/getRealFee'
    : '/biz-orange/BH/newPlanRemainQry/getNewPlanRemainQry';

  // 明文正文：捕获参数 + 手机号 + cookie
  const bodyObj = Object.assign({}, params, { reqBody: { cellNum: phone }, t: cookie });
  if (kind === 'fee') bodyObj.nt = '5';
  const encBody = cmEncrypt(JSON.stringify(bodyObj), REQ1_KEY, DEFAULT_IV);

  // x-token：AES(xk_pathname_ts_nonce)
  const xk = params.xk || '';
  const tokenEnc = cmEncrypt(`${xk}_${pathname}_${ts}_${nonce}`, REQ1_KEY, DEFAULT_IV);

  // x-sign：MD5(x-token_ts_nonce_jsessionid)
  const m = cookie.match(/JSESSIONID=(.+?);/);
  const jsid = m ? m[1] : 'null';
  const xsign = cmMd5(`${tokenEnc}_${ts}_${nonce}_${jsid}`);

  const headers = {
    'Host': 'app.10086.cn',
    'x-qen': '1',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'x-sign': xsign,
    'x-nonce': nonce,
    'x-token': tokenEnc,
    'Sec-Fetch-Mode': 'cors',
    'Origin': 'https://h.app.coc.10086.cn',
    'User-Agent': UA_WAP,
    'x-time': String(ts),
    'Sec-Fetch-Des': 'empty',
  };
  return {
    url: `https://app.10086.cn${pathname}?` + encodeURI(cookie),
    headers,
    body: encBody,
  };
}

// 从任意响应里收 Set-Cookie，滚动保持会话
function absorbSetCookie(ctx, headers) {
  const sc = String(getHeader(headers, 'set-cookie') || '').trim();
  if (sc && /JSESSIONID=/i.test(sc) && ctx.storage.get(STORE.cookie) !== sc) {
    ctx.storage.set(STORE.cookie, sc);
    return true;
  }
  return false;
}

// 按 x-pen 解开响应正文
function decodeResp(text, xpen) {
  if (xpen === '1') return JSON.parse(cmDecrypt(JSON.parse(text).body, RESP1_KEY, DEFAULT_IV));
  if (xpen === '2') return JSON.parse(cmDecrypt(text, RESP2_KEY, DEFAULT_IV));
  if (xpen === '14') return JSON.parse(cmDecrypt(text, RESP14_KEY, RESP14_IV));
  return JSON.parse(text);
}

// 远程诊断：Surge 适配版已移除（原版会向作者的 ntfy.sh 发诊断，虽有号码哈希门槛，仍整体去掉，保持无外发）
let CM_DIAG = {};
async function cmReport(ctx, obj) { /* no-op */ }

// 给重放的 autoLogin 重新签名：x-sign 绑定时间戳，原样重放会被拒（950102 x-sign错误）
// 签名算法与查询接口相同：x-token=AES(xk_pathname_ts_nonce)，x-sign=MD5(x-token_ts_nonce_jsessionid)
function resignHeaders(headers, url, xk, jsid) {
  const ts = Date.now();
  const nonce = randomDigits(8);
  let pathname = '';
  try { pathname = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''); } catch (e) {}
  const out = {};
  for (const k of Object.keys(headers)) {
    if (/^(x-sign|x-nonce|x-time|x-token)$/i.test(k)) continue;
    out[k] = headers[k];
  }
  const tokenEnc = cmEncrypt(`${xk}_${pathname}_${ts}_${nonce}`, TOK_KEY, DEFAULT_IV);
  out['x-token'] = tokenEnc;
  out['x-nonce'] = nonce;
  out['x-time'] = String(ts);
  out['x-sign'] = cmMd5(`${tokenEnc}_${ts}_${nonce}_${jsid}`);
  return out;
}

function renewOk(rc, got) {
  return got || rc === '0' || rc === '000000' || rc === '200';
}

// 登录过期时：重放捕获到的 autoLogin 请求换新 Cookie（5 分钟内最多一次）
// 先重新签名；签名仍错就换 jsessionid=null、再换用当前 Cookie 重加密正文，最多试 3 种
async function autoRefreshSession(ctx, proactive) {
  const url = ctx.storage.get(STORE.loginUrl) || '';
  const body = ctx.storage.get(STORE.paramsEnc) || '';
  if (!url || !body) return false;
  const last = parseInt(ctx.storage.get(STORE.refreshTs) || '0', 10);
  if (Date.now() - last < 5 * 60 * 1000) return false;
  ctx.storage.set(STORE.refreshTs, String(Date.now()));
  let base = {};
  try { base = ctx.storage.getJSON(STORE.loginHeaders) || {}; } catch (e) {}
  if (!Object.keys(base).some((k) => /^x-qen$/i.test(k))) base['x-qen'] = ctx.storage.get(STORE.xqen) || '2';
  if (!Object.keys(base).some((k) => /^content-type$/i.test(k))) base['Content-Type'] = 'application/json';
  if (!Object.keys(base).some((k) => /^user-agent$/i.test(k))) base['User-Agent'] = UA_WAP;
  const oldCookie = ctx.storage.get(STORE.cookie) || '';
  if (oldCookie) base['Cookie'] = oldCookie;
  const jm = oldCookie.match(/JSESSIONID=(.+?)(;|$)/);
  const jsid = jm ? jm[1] : 'null';
  let params = {};
  try { params = decryptParams(ctx); } catch (e) {}
  const xk = params.xk || '';
  const xqen = (ctx.storage.get(STORE.xqen) || '2').trim();
  const variants = [
    { n: 'sign', b: body, j: jsid },
    { n: 'nulljs', b: body, j: 'null' },
  ];
  if (oldCookie && REQ_KEY[xqen] && params && Object.keys(params).length) {
    try {
      const nb = cmEncrypt(JSON.stringify(Object.assign({}, params, { t: oldCookie })), REQ_KEY[xqen], REQ_IV[xqen]);
      variants.push({ n: 'rebody', b: nb, j: jsid });
    } catch (e) {}
  }
  const tries = [];
  for (const v of variants) {
    try {
      const headers = resignHeaders(base, url, xk, v.j);
      const resp = await ctx.http.post(url, { headers, body: v.b, timeout: 15000 });
      const got = !!resp && absorbSetCookie(ctx, resp.headers);
      let rc = '', rd = '', raw = '';
      try {
        const text = typeof resp.text === 'function' ? await resp.text() : String(resp.body || '');
        raw = 'pen=' + String(getHeader(resp.headers, 'x-pen') || '') + ' len=' + text.length + ' ' + text.slice(0, 50).replace(/[0-9]{6,}/g, '#');
        const d = decodeResp(text, String(getHeader(resp.headers, 'x-pen') || '').trim());
        rc = String((d && (d.retCode || (d.body && d.body.retCode))) || '');
        rd = String((d && (d.retDesc || (d.body && d.body.retDesc))) || '').slice(0, 30);
      } catch (e) { rc = 'undecodable'; }
      tries.push({ v: v.n, http: resp ? resp.status : 0, cookie: got, rc, rd: rc === 'undecodable' ? raw : rd });
      dlog(ctx, `自动续期[${v.n}] HTTP=${resp ? resp.status : 'no-resp'} 新Cookie=${got} ret=${rc}`);
      if (resp && resp.status === 200 && renewOk(rc, got)) {
        ctx.storage.set('cm_renew_ok_ts', String(Date.now()));
        ctx.storage.set('cm_renew_variant', v.n);
        CM_DIAG.renew = { proactive: !!proactive, ok: true, tries };
        return true;
      }
      // 签名以外的错误（如未登录）换写法也没用，直接停
      if (rc && rc !== '950102' && rc !== '950202' && rc !== '-9999' && rc !== 'undecodable' && !/sign|token|\u89e3\u5bc6/i.test(rd)) break;
    } catch (e) {
      tries.push({ v: v.n, err: String((e && e.message) || e).slice(0, 40) });
    }
  }
  CM_DIAG.renew = { proactive: !!proactive, ok: false, tries };
  return false;
}

// 会话还有效时也定期续期（距上次成功续期超 8 小时），赶在服务端时效到期前刷新
async function maybeProactiveRenew(ctx) {
  const lastOk = parseInt(ctx.storage.get('cm_renew_ok_ts') || '0', 10);
  const loginTs = parseInt(ctx.storage.get(STORE.loginTs) || '0', 10);
  const since = Date.now() - Math.max(lastOk, loginTs);
  if (since < 8 * 3600 * 1000) return;
  await autoRefreshSession(ctx, true);
}

async function queryKind(ctx, kind) {
  const params = decryptParams(ctx);
  const q = buildQuery(ctx, params, kind);
  const resp = await ctx.http.post(q.url, { headers: q.headers, body: q.body, timeout: 15000 });
  if (!resp || resp.status !== 200) {
    const e = new Error(`HTTP ${resp ? resp.status : 'no-response'}`);
    e.stage = 'network';
    throw e;
  }
  absorbSetCookie(ctx, resp.headers);
  const text = typeof resp.text === 'function' ? await resp.text() : String(resp.body || '');
  if (ctx.env.CM_DEBUG === 'true') ctx.storage.set(STORE.rawDebug, text.slice(0, 300));

  const xpen = String(getHeader(resp.headers, 'x-pen') || '').trim();
  let data;
  try {
    if (xpen === '1') {
      const inner = JSON.parse(text);
      data = JSON.parse(cmDecrypt(inner.body, RESP1_KEY, DEFAULT_IV));
    } else if (xpen === '2') {
      data = JSON.parse(cmDecrypt(text, RESP2_KEY, DEFAULT_IV));
    } else if (xpen === '14') {
      data = JSON.parse(cmDecrypt(text, RESP14_KEY, RESP14_IV));
    } else {
      data = JSON.parse(text);
    }
  } catch (e) {
    const err = new Error('decrypt-failed');
    err.stage = 'decrypt';
    throw err;
  }
  // 诊断：记下解密后数据的顶层结构（不记值）
  try {
    if (kind === 'plan' && ctx.env.CM_DEBUG === 'true') {
      const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data;
      const inner = data && (data.rspBody || (data.body && data.body.rspBody)) || {};
      const innerKeys = inner && typeof inner === 'object' ? Object.keys(inner).join(',') : '';
      const resObj = (inner && inner.newPlanRemainQryRes) || {};
      const resKeys = resObj && typeof resObj === 'object' ? Object.keys(resObj).join(',') : '';
      const rc = data && (data.retCode || (data.body && data.body.retCode)) || '';
      const rd = data && (data.retDesc || (data.body && data.body.retDesc)) || '';
      ctx.storage.set(STORE.planDebug, `top:[${String(keys).slice(0, 120)}] rspBody:[${String(innerKeys).slice(0, 150)}] res:[${String(resKeys).slice(0, 200)}] ret:${rc}/${String(rd).slice(0, 60)}`);
    }
  } catch (e) {}
  return data;
}

function toFlowUnit(remain, unit) {
  if (unit === '03') {
    return remain >= 1024
      ? { number: (remain / 1024).toFixed(2), unit: 'GB' }
      : { number: remain.toFixed(2), unit: 'MB' };
  }
  if (unit === '04') return { number: remain.toFixed(2), unit: 'GB' };
  return { number: remain.toFixed(2), unit: String(unit || '') };
}

// 递归深搜：找包含指定键的数组（应对字段嵌套位置变化）
function deepFindArrays(obj, keyName, out, seen) {
  if (!obj || typeof obj !== 'object') return;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(obj)) {
    if (obj.length && obj[0] && typeof obj[0] === 'object' && keyName in obj[0]) out.push(obj);
    for (const item of obj) deepFindArrays(item, keyName, out, seen);
  } else {
    for (const k of Object.keys(obj)) deepFindArrays(obj[k], keyName, out, seen);
  }
}

function parseMobile(feeData, planData, opts) {
  const feeInfo = (feeData && (feeData.rspBody || (feeData.body && feeData.body.rspBody))) || {};
  const planBody = (planData && (planData.rspBody || (planData.body && planData.body.rspBody))) || {};
  // 套餐数据包在 rspBody.newPlanRemainQryRes 里（兼容直接平铺的旧结构）
  const planInfo = planBody.newPlanRemainQryRes || planBody;

  const feeNum = parseFloat(feeInfo.realBalanceFee || feeInfo.curFee || '0');
  const fee = {
    title: '剩余话费',
    number: Number.isFinite(feeNum) ? feeNum.toFixed(2) : '0.00',
    unit: '元',
  };

  // 流量：先直接取，取不到就深搜（严格判断数组防 .filter 炸）
  // 实际字段名为 planRemianFlowListRes（含 List）
  const flowArrDirect = Array.isArray(planInfo.planRemianFlowListRes) ? planInfo.planRemianFlowListRes
    : Array.isArray(planInfo.planRemianFlowRes) ? planInfo.planRemianFlowRes : [];
  let flowArrAll = flowArrDirect;
  let flows = flowArrDirect.filter((f) => f && f.flowtype == 0);
  if (!flows.length && planData) {
    const found = [];
    deepFindArrays(planData, 'flowRemainNum', found, new Set());
    const arr = Array.isArray(found[0]) ? found[0] : [];
    if (arr.length) flowArrAll = arr;
    flows = arr.filter((f) => f && f.flowtype == 0);
    if (!flows.length && arr.length) flows = arr.slice(0, 1); // 实在没有 flowtype 就取第一条
  }
  // 国内其他流量：flowtype != 0 的各项求和（统一按 MB 累加再格式化）
  let otherFlow = { title: '其他流量', number: '--', unit: '', percent: 0, color: '#5AC8FA' };
  const otherItems = flowArrAll.filter((f) => f && f.flowtype != 0);
  if (otherItems.length) {
    let totalMb = 0, sumMb = 0;
    for (const f of otherItems) {
      const remain = parseFloat(f.flowRemainNum || '0');
      if (!Number.isFinite(remain)) continue;
      const k = String(f.unit || '03') === '04' ? 1024 : 1;
      totalMb += remain * k;
      const s = parseFloat(f.flowSumNum || '0');
      if (Number.isFinite(s)) sumMb += s * k;
    }
    const u = totalMb >= 1024
      ? { number: (totalMb / 1024).toFixed(2), unit: 'GB' }
      : { number: totalMb.toFixed(2), unit: 'MB' };
    otherFlow = { title: '其他流量', number: u.number, unit: u.unit, percent: sumMb > 0 ? Math.max(0, Math.min(1, totalMb / sumMb)) : 0, color: '#5AC8FA' };
  }
  let flow = { title: '剩余流量', number: '--', unit: '', percent: 0, color: '#0A84FF' };
  if (flows.length) {
    const remain = parseFloat(flows[0].flowRemainNum || '0');
    const u = toFlowUnit(remain, String(flows[0].unit || '03'));
    const showUsed = opts && opts.showUsedFlow;
    flow = {
      title: showUsed ? '已用流量' : '剩余流量',
      number: u.number,
      unit: u.unit,
      percent: 0,
      color: '#0A84FF',
    };
    const sum = parseFloat(flows[0].flowSumNum || '0');
    if (Number.isFinite(sum) && sum > 0) flow.percent = Math.max(0, Math.min(1, remain / sum));
    flow.total = Number.isFinite(sum) && sum > 0 ? toFlowUnit(sum, String(flows[0].unit || '03')) : null;
    if (showUsed && flows[0].flowUsdNum) {
      const used = parseFloat(flows[0].flowUsdNum || '0');
      const uu = toFlowUnit(used, String(flows[0].unit || '03'));
      flow.number = uu.number;
      flow.unit = uu.unit;
    }
  }

  // 语音：先直接取，取不到就深搜（严格判断数组防 .filter 炸）
  const voiceArr = Array.isArray(planInfo.planRemianVoiceListRes) ? planInfo.planRemianVoiceListRes : [];
  let voices = voiceArr.filter((v) => v && v.voicetype == 0);
  if (!voices.length && planData) {
    const found = [];
    deepFindArrays(planData, 'voiceRemainNum', found, new Set());
    const arr = Array.isArray(found[0]) ? found[0] : [];
    voices = arr.filter((v) => v && v.voicetype == 0);
    if (!voices.length && arr.length) voices = arr.slice(0, 1);
  }
  let voice = { title: '剩余语音', number: '--', unit: '分钟', percent: 0, color: '#30D158' };
  if (voices.length) {
    const remain = parseInt(voices[0].voiceRemainNum || '0', 10);
    voice.number = String(Number.isFinite(remain) ? remain : 0);
    const vs = parseInt(voices[0].voiceSumNum || '0', 10);
    if (Number.isFinite(vs) && vs > 0) voice.percent = Math.max(0, Math.min(1, remain / vs));
  }

  const feeOk = feeInfo && (feeInfo.realBalanceFee != null || feeInfo.curFee != null);
  // 只有话费、没有流量和语音 → 多为登录态过期（接口仍回 200 空壳），按无效处理，走续期/缓存
  const valid = flows.length > 0 || voices.length > 0;
  void feeOk;
  return { fee, flow, otherFlow, voice, updatedAt: Date.now(), valid };
}

async function loadData(ctx) {
  const debug = ctx.env.CM_DEBUG === 'true';
  const phone = getPhone(ctx);
  const hasParams = !!(ctx.storage.get(STORE.paramsEnc));
  if (!hasParams) return { configured: false, reason: 'capture', debug };
  if (!/^\d{11}$/.test(phone)) return { configured: false, reason: 'phone', debug };

  const fetchAll = async () => {
    const feeData = await queryKind(ctx, 'fee');
    const planData = await queryKind(ctx, 'plan');
    const ds = parseMobile(feeData, planData, {
      showUsedFlow: ctx.env.CM_SHOW_USED_FLOW === 'true',
    });
    return { feeData, planData, ds };
  };
  try {
    CM_DIAG = {};
    const rcOf = (d) => String((d && (d.retCode || (d.body && d.body.retCode))) || '');
    let { feeData, planData, ds } = await fetchAll();
    CM_DIAG.first = { valid: !!ds.valid, fee: rcOf(feeData), plan: rcOf(planData) };
    // 登录过期 → 自动重放登录续期，成功就再查一次
    if (!ds.valid && await autoRefreshSession(ctx)) {
      ({ feeData, planData, ds } = await fetchAll());
      CM_DIAG.second = { valid: !!ds.valid, fee: rcOf(feeData), plan: rcOf(planData) };
    }
    // 接口返回 200 但内容是错误（多为登录态过期）：不覆盖缓存，回退旧数据
    if (!ds.valid) {
      const rc = (d) => d && (d.retCode || (d.body && d.body.retCode)) || '';
      const rd = (d) => d && (d.retDesc || (d.body && d.body.retDesc)) || '';
      const err = new Error(`empty ${rc(feeData)}/${rc(planData)} ${String(rd(planData) || rd(feeData)).slice(0, 40)}`);
      err.stage = 'session';
      throw err;
    }
    delete ds.valid;
    if (debug) ds.planDebug = ctx.storage.get(STORE.planDebug) || '';
    ctx.storage.setJSON(STORE.datasource, ds);
    return { configured: true, ds, fromCache: false, debug };
  } catch (e) {
    let cached = ctx.storage.getJSON(STORE.datasource);
    // 旧版本可能把空数据写进了缓存，这种缓存不用
    if (cached && cached.flow && cached.flow.number === '--' && cached.voice && cached.voice.number === '--') cached = null;
    if (cached) cached.stale = (e && e.stage) === 'session' ? '登录过期' : '缓存';
    const errInfo = debug ? ` [${(e && e.stage) || '?'}:${String((e && e.message) || e).slice(0, 60)}]` : '';
    if (cached) cached.planDebug = (cached.planDebug || '') + errInfo;
    return {
      configured: true, ds: cached || null, fromCache: !!cached, debug,
      error: String((e && e.message) || e), stage: (e && e.stage) || '',
    };
  }
}

/* ---------- 用量洞察（原版逻辑，含每日快照读写） ---------- */

// 原版颜色常量：insights 的 forecast 逻辑引用了 SUB / C_VOICE / C_FEE，面板版只取 text 字段，颜色保留原值以维持原逻辑可运行
const C_FEE = '#FF9F0A';
const C_FLOW = '#0A84FF';
const C_OTHER = '#64D2FF';
const C_VOICE = '#30D158';
const WARN = '#FF453A';
const TXT = { light: '#000000', dark: '#FFFFFF' };
const SUB = { light: '#3C3C4399', dark: '#EBEBF599' };
const GLASS = { light: '#FFFFFFA6', dark: '#FFFFFF1A' };

function toMB(d) {
  const n = parseFloat(d && d.number);
  if (!Number.isFinite(n)) return null;
  return d.unit === 'GB' ? n * 1024 : n;
}

function fmtMB(mb) {
  if (mb == null || !Number.isFinite(mb)) return '--';
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

function insights(ctx, ds) {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = dim - now.getDate() + 1;
  // 按 通用 + 其他流量 合计剩余统计
  const _g = toMB(ds.flow), _o = toMB(ds.otherFlow);
  const flowMB = ctx.env.CM_SHOW_USED_FLOW === 'true' ? null
    : (_g == null && _o == null ? null : (_g || 0) + (_o || 0));
  let todayMB = null;
  if (flowMB != null) {
    let snap = null;
    try { snap = ctx.storage.getJSON('cm_day_snap'); } catch (e) {}
    // 新的一天，或流量变多（加油包/月初重置）→ 重新记起点
    if (!snap || snap.date !== dayKey || flowMB > snap.start + 1) {
      snap = { date: dayKey, start: flowMB };
      try { ctx.storage.setJSON('cm_day_snap', snap); } catch (e) {}
    }
    todayMB = Math.max(0, snap.start - flowMB);
  }
  // 近 7 天每日用量历史（旧 → 今天）
  const hist = [];
  if (todayMB != null) {
    let h = {};
    try { h = ctx.storage.getJSON('cm_hist') || {}; } catch (e) {}
    h[dayKey] = todayMB;
    const keep = {};
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      if (h[k] != null) keep[k] = h[k];
      if (i <= 6) hist.push(h[k] == null ? null : h[k]);
    }
    try { ctx.storage.setJSON('cm_hist', keep); } catch (e) {}
  }
  // 按近 6 天（不含今天）平均用量预测
  let forecast = { text: '用量统计中…', color: SUB };
  if (flowMB != null) {
    const past = hist.slice(0, 6).filter(v => v != null && v > 0);
    const vals = past.length ? past : (todayMB > 0 ? [todayMB] : []);
    if (vals.length) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const days = Math.floor(flowMB / avg);
      forecast = days >= daysLeft
        ? { text: days > 999 ? '按近期速度 充足' : `预计够用 ${days} 天 ✓`, color: C_VOICE }
        : { text: `约 ${days} 天用完 · 早于月底`, color: C_FEE };
    }
  }
  return {
    hist,
    forecast,
    daysLeft,
    monthPct: (now.getDate() - 1 + now.getHours() / 24) / dim,
    todayMB,
    dailyMB: flowMB != null ? flowMB / daysLeft : null,
    lowFee: (() => { const n = parseFloat(ds.fee.number); return Number.isFinite(n) && n < 10; })(),
  };
}

async function handleKeepAlive(ctx) {
  const r = await loadData(ctx);
  const expired = r.configured && (r.stage === 'session' || !r.ds || r.fromCache);
  dlog(ctx, `保活 ${expired ? '失败:' + (r.error || '') : '成功'}`);
  if (!expired) { try { await maybeProactiveRenew(ctx); } catch (e) {} }
  // 诊断：失败每次报；成功只在由失败转成功、或距上次成功报告超 3 小时时报
  const lastOkRep = parseInt(ctx.storage.get('cm_diag_ok_ts') || '0', 10);
  const prevFail = (ctx.storage.get('cm_diag_state') || '') === 'fail';
  if (expired || prevFail || Date.now() - lastOkRep > 3 * 3600 * 1000) {
    await cmReport(ctx, { ok: !expired, stage: r.stage || '', err: String(r.error || '').slice(0, 80), fails: parseInt(ctx.storage.get('cm_expire_fails') || '0', 10) });
    if (!expired) ctx.storage.set('cm_diag_ok_ts', String(Date.now()));
  }
  ctx.storage.set('cm_diag_state', expired ? 'fail' : 'ok');
  if (expired && r.stage === 'session') {
    // 连续 3 次（约 1 小时）都判过期才提醒，避免接口偶发空壳误报
    const fails = parseInt(ctx.storage.get('cm_expire_fails') || '0', 10) + 1;
    ctx.storage.set('cm_expire_fails', String(fails));
    const last = parseInt(ctx.storage.get('cm_expire_notify') || '0', 10);
    if (fails >= 3 && Date.now() - last > 6 * 3600 * 1000) {
      ctx.storage.set('cm_expire_notify', String(Date.now()));
      ctx.notify({ title: '中国移动', body: '登录已过期，打开「中国移动」App 停留几秒即可恢复' });
    }
  } else if (!expired) {
    ctx.storage.set('cm_expire_notify', '0');
    ctx.storage.set('cm_expire_fails', '0');
  }
}

/* ==================== Surge 面板渲染（替代原 Widget DSL / SVG 渲染层） ==================== */

// 近 7 天用量文本条：按最大值比例映射到 ▁▂▃▄▅▆▇
function cmBars(hist) {
  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];
  const vals = (hist && hist.length) ? hist : [null, null, null, null, null, null, null];
  const max = Math.max(1, ...vals.map((v) => v || 0));
  return vals.map((v) => {
    if (v == null || !(v > 0)) return chars[0];
    return chars[Math.min(chars.length - 1, Math.floor((v / max) * chars.length))];
  }).join('');
}

function panelDone(title, content) {
  $done({ title, content, icon: 'antenna.radiowaves.left.and.right', 'icon-color': '#009FE8' });
}

// 面板模式：分支与提示文案与原 handleWidget 一致，呈现换成多行文字
async function handleWidget(ctx) {
  const title = (ctx.env.CM_TITLE || '中国移动').trim() || '中国移动';
  const r = await loadData(ctx);

  if (!r.configured) {
    if (r.reason === 'phone') {
      panelDone(title, '⚠ 请在模块参数里填写 CM_PHONENUMBER（11 位移动手机号）');
      return;
    }
    panelDone(title, '⚠ 还没抓到登录参数：打开「中国移动」App，用短信验证码登录一次');
    return;
  }
  if (!r.ds) {
    const hint = r.stage === 'decrypt'
      ? '解密失败：可能 App 升级了加密，请重新打开 App 抓一次'
      : r.stage === 'network'
        ? '网络请求失败，请检查网络或代理'
        : r.stage === 'session'
          ? '登录已过期：打开「中国移动」App 停留 10 秒刷新登录，再回桌面'
          : '查询失败：打开「中国移动」App 等 10 秒，让脚本刷新 Cookie 后再试';
    panelDone(title, '⚠ ' + hint + (r.debug ? `\n错误: ${r.error || ''}` : ''));
    return;
  }

  const ds = r.ds;
  const ins = insights(ctx, ds);
  const pct = (d) => (d && d.percent > 0 ? ` · ${Math.round(d.percent * 100)}%` : '');
  const lines = [];

  // 话费
  lines.push(`话费 ¥${ds.fee.number}${ins.lowFee ? '（话费不足）' : ''}`);

  // 流量（通用 + 其他）
  let flowLine = [ds.flow.title, ds.flow.number, ds.flow.unit || ''].filter(Boolean).join(' ');
  if (ds.flow.total) flowLine += ` / ${ds.flow.total.number} ${ds.flow.total.unit}`;
  flowLine += pct(ds.flow);
  if (ds.otherFlow && ds.otherFlow.number !== '--') {
    flowLine += `（其他 ${ds.otherFlow.number} ${ds.otherFlow.unit || ''}${pct(ds.otherFlow)}）`;
  }
  lines.push(flowLine);

  // 语音
  lines.push([ds.voice.title, ds.voice.number, ds.voice.unit || ''].filter(Boolean).join(' ') + pct(ds.voice));

  // 用量洞察
  if (ins.todayMB != null || ins.dailyMB != null) {
    lines.push(`今日已用 ${fmtMB(ins.todayMB)}`);
    lines.push(`日均可用 ${fmtMB(ins.dailyMB)}`);
  }
  if (ins.forecast && ins.forecast.text) lines.push(ins.forecast.text);
  if (ins.hist && ins.hist.some((v) => v != null)) {
    lines.push(`近7天 ${cmBars(ins.hist)}`);
  }

  // 更新时间（缓存回退时带原版的 stale 标记）
  lines.push(`${r.fromCache ? `${ds.stale || '缓存'} · ` : ''}更新 ${ds.updatedAt ? fmtTime(ds.updatedAt) : '--'}`);
  if (r.debug && ds.planDebug) lines.push(ds.planDebug);

  panelDone(title, lines.join('\n'));
}

/* ==================== 入口：按 Surge 全局变量分发三模式 ==================== */

(async () => {
  const ctx = buildCtx();
  // 有 $request → 捕获模式（http-request / http-response 脚本）
  if (ctx.request && ctx.request.url) {
    try {
      // 抓取开关：CM_CAPTURE=false 时完全不抓（与原版一致）
      if ((ctx.env || {}).CM_CAPTURE !== 'false') {
        // response 脚本同时带 request 与 response，优先按 response 处理
        if (ctx.response && (ctx.response.status || ctx.response.headers)) {
          await handleRespCapture(ctx);
        } else {
          await handleCapture(ctx);
        }
      }
    } catch (e) { /* 捕获出错也必须放行原请求/响应 */ }
    $done({});
    return;
  }
  // 无 $request + CM_KEEPALIVE=true → cron 保活
  if (ctx.env && ctx.env.CM_KEEPALIVE === 'true') {
    try { await handleKeepAlive(ctx); } catch (e) {}
    $done();
    return;
  }
  // 其余 → 面板
  try {
    await handleWidget(ctx);
  } catch (e) {
    const title = (ctx.env.CM_TITLE || '中国移动').trim() || '中国移动';
    panelDone(title, `⚠ 查询失败：${String((e && e.message) || e).slice(0, 80)}`);
  }
})();
