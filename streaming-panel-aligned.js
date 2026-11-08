// ============================================================
// 流媒体解锁面板 · Surge 通用版  V1.2
//
// 逐个策略组、逐个平台，发真实请求实测。
// 不看 IP 库猜地区，结果就是「分流后对方真正看到什么」。
//
// 参数格式（两段，用 || 隔开）：
//   ① 策略组：组名或节点名，多个用 | 分隔。留空 = 只测 FINAL 那条
//   ② 平台：留空 = 全测；填 netflix,disney 只测这些
//
// 判定依据（全部实测字段）：
//   Netflix     原创剧页面是否出现「该片在本地区不可看」
//   Disney+     首页下发 "location":"XX"
//   YouTube     Premium 页 countryCode / GL
//   Prime Video 首页 currentTerritory
//   Spotify     注册接口 spclient 的 country 字段
//   HBO Max     首页 languageVariables 里的 country
//               （max.com 对未开通地区一律下发默认 en/us，
//                 必须和落地 IP 交叉校验，否则非美线全误报 US）
//   Hulu        首页可达 + 落地 IP 是 US 才算 US
//               （hulu.com 对海外 IP 也回完整营销页，页面本身没有信号）
//   Abema       __CLIENT_REGION__.isoCountryCode
//   巴哈动画疯  ajax 接口状态码 200/403
//   B站港澳台   x/web-interface/zone 的落地国家
//   ChatGPT     chatgpt.com 的 cdn-cgi/trace 落地国家
//   Claude      claude.ai 的 cdn-cgi/trace 落地国家
//   Gemini      页面明示 + 落地国家兜底
//
// 受限原因只用三种说法：
//   地区限制  ——该服务在这个地区不开放 / 直接挡在门外
//   版权限制  ——服务在，但这条内容在本地区没有授权
//   服务不可用——请求失败、超时或拿不到有效响应
// ============================================================

var RAWARG = (typeof $argument === 'undefined' || $argument === null) ? '' : String($argument);
var SEG = RAWARG.split('||');
var ARG_GROUPS = SEG[0] || '';
var ARG_PLAT = SEG.length > 1 ? SEG[1] : '';

var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
         'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
var HDR = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

var RENDERED = false;
var OUT = [];
var DEADLINE = 42000;

// 受限原因（全模块只用这三种）
var R_GEO = '地区限制';
var R_COPY = '版权限制';
var R_DOWN = '服务不可用';

// AI 三类服务不开放的地区
var AI_BLOCK = {
  CN: 1, HK: 1, MO: 1, RU: 1, BY: 1, IR: 1, KP: 1,
  SY: 1, CU: 1, VE: 1, AF: 1, TM: 1
};

// ---------------- 参数清洗 ----------------

function isBlank(v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return true;
  if (/^(空|无|自动|默认|不填|留空|none|null|auto|default|auto-select)$/i.test(s)) return true;
  if (/^留空/.test(s)) return true;
  if (/^填/.test(s)) return true;
  if (/^<.*>$/.test(s)) return true;
  return false;
}

function splitList(s) {
  var parts = String(s || '').split(/[|,，、;；\n]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!isBlank(p)) out.push(p);
  }
  return out;
}

// ---------------- 显示宽度 / 旗帜 / 时间 ----------------

function dw(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c > 0x1100 && (
      c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    )) n += 2; else n += 1;
  }
  return n;
}

function pad(s, width) {
  var d = width - dw(s);
  if (d <= 0) return s;
  var buf = '';
  for (var i = 0; i < d; i++) buf += ' ';
  return s + buf;
}

// 国家码转国旗：两位字母各自变成 Regional Indicator 符号。
// 注意不能直接用 fromCharCode —— 0x1F1F8 超过 16 位会被截断成私用区字符，
// 必须自己拼 UTF-16 代理对。
function riCode(ch) {
  var cp = ch.toUpperCase().charCodeAt(0) - 65 + 0x1F1E6;
  var v = cp - 0x10000;
  return String.fromCharCode(0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF));
}

function flagOf(cc) {
  var up = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return '';
  return riCode(up.charAt(0)) + riCode(up.charAt(1));
}

function nowText() {
  var d = new Date();
  function two(n) { return n < 10 ? '0' + n : '' + n; }
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}

// ---------------- Surge 内部 API ----------------

function apiGet(path, cb) {
  try {
    $httpAPI('GET', path, null, function (r) { cb(r || {}); });
  } catch (e) {
    cb({});
  }
}

// ---------------- HTTP（带重试） ----------------

function once(pol, url, timeout, cb) {
  var opt = { url: url, timeout: timeout || 12, headers: HDR };
  if (pol && !/^direct$/i.test(pol)) opt.policy = pol;
  var done = false;
  function fire(err, resp, data) {
    if (done) return;
    done = true;
    cb(err, resp || {}, String(data === undefined || data === null ? '' : data));
  }
  try {
    $httpClient.get(opt, fire);
  } catch (e) {
    fire(String(e), {}, '');
  }
  setTimeout(function () { fire('timeout', {}, ''); }, (timeout || 12) * 1000 + 1500);
}

// 各站完整页面的大小下限：字节数明显偏低说明是被截断的半截响应，
// 拿它做正则判定会把「香港」误判成「无信号」，所以宁可重试
var MINLEN = [
  ['disneyplus.com', 300000],
  ['youtube.com', 150000],
  ['primevideo.com', 150000],
  ['max.com', 300000],
  ['hulu.com', 60000],
  ['abema.tv', 30000],
  ['gamer.com.tw', 30000],
  ['netflix.com', 200000],
  ['spotify.com', 6000]
];

function minLenFor(url) {
  for (var i = 0; i < MINLEN.length; i++) {
    if (String(url).indexOf(MINLEN[i][0]) >= 0) return MINLEN[i][1];
  }
  return 200;
}

function get(pol, url, timeout, retries, cb) {
  var need = minLenFor(url);
  var attempt = 0;
  (function loop() {
    attempt++;
    once(pol, url, timeout, function (err, resp, data) {
      var bad = (err || !data || data.length < need);
      if (bad && attempt <= retries) {
        setTimeout(loop, 250);
        return;
      }
      cb(err, resp, data);
    });
  })();
}

// 反查这个策略的落地国家码（用于「连不上时判断是节点挂了还是地区不开放」）
function geoCC(pol, cb) {
  get(pol, 'http://ip-api.com/json/?lang=en&fields=status,countryCode', 10, 1, function (e, r, s) {
    if (e || !s) return cb('');
    try {
      var j = JSON.parse(s);
      if (j && j.countryCode) return cb(String(j.countryCode).toUpperCase());
    } catch (err) {}
    cb('');
  });
}

// 连不上时反查落地地区：能拿到国家码就说明是「地区限制」，拿不到才是服务不可用
function regionBlocked(pol, cb) {
  geoCC(pol, function (cc) {
    if (!cc) return cb({ s: 'fail', r: R_DOWN });
    cb({ s: 'no', r: R_GEO, cc: cc });
  });
}

// 给「地区限制」行补国旗用的快速反查：5 秒、不重试
function geoCCFast(pol, cb) {
  var opt = { url: 'http://ip-api.com/json/?lang=en&fields=status,countryCode', timeout: 5, headers: HDR };
  if (pol && !/^direct$/i.test(pol)) opt.policy = pol;
  var done = false;
  function fire(e, r, d) {
    if (done) return;
    done = true;
    try {
      var j = JSON.parse(String(d || ''));
      if (j && j.countryCode) return cb(String(j.countryCode).toUpperCase());
    } catch (err) {}
    cb('');
  }
  try { $httpClient.get(opt, fire); } catch (e) { fire(e, {}, ''); }
  setTimeout(function () { fire('timeout', {}, ''); }, 6000);
}

// 明确判定「地区限制」时补一次落地国家，好让这一行也带上国旗
function noWithCC(pol, reason, cb) {
  geoCC(pol, function (cc) {
    cb({ s: 'no', r: reason || R_GEO, cc: cc });
  });
}

// ---------------- 平台检测 ----------------
// 统一返回 { s, cc, r }：
//   s  = ok | part | no | warn | fail
//   cc = 对方识别的国家码（有就填，渲染时转国旗）
//   r  = 受限原因，只能是 R_GEO / R_COPY / R_DOWN

// Netflix 对高频请求会直接掐连接（EOF），换剧集再试一次比死磕同一个 URL 成功率高
function nfProbe(pol, id, cb) {
  get(pol, 'https://www.netflix.com/title/' + id, 13, 2, function (e, r, s) {
    if (e || !s) return cb(null);
    if (/Oh no! This title currently isn.t available/i.test(s)) {
      return cb({ s: 'no', r: R_GEO });
    }
    var m = /requestCountry":\s*\{[^}]*?"id":"([A-Z]{2})"/.exec(s);
    if (!m) return cb(null);
    cb({ s: 'ok', cc: m[1] });
  });
}

function checkNetflix(pol, cb) {
  nfProbe(pol, '80018499', function (r1) {
    if (r1) return cb(r1);
    nfProbe(pol, '60023642', function (r2) {
      if (r2) return cb(r2);
      regionBlocked(pol, cb);
    });
  });
}

function checkDisney(pol, cb) {
  get(pol, 'https://www.disneyplus.com/', 14, 3, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    if (/not available in your (country|region)/i.test(s)) return cb({ s: 'no', r: R_GEO });
    var m = /"location":"([A-Za-z]{2})"/.exec(s);
    if (m) return cb({ s: 'ok', cc: m[1].toUpperCase() });
    // 页面太大，偶尔只拿到前面一段，没走到 location 就再抓一次
    get(pol, 'https://www.disneyplus.com/login', 12, 1, function (e2, r2, s2) {
      var m2 = /"location":"([A-Za-z]{2})"/.exec(s2 || '');
      if (m2) return cb({ s: 'ok', cc: m2[1].toUpperCase() });
      if (e2 || !s2) return regionBlocked(pol, cb);
      cb({ s: 'warn', r: R_DOWN });
    });
  });
}

function checkYouTube(pol, cb) {
  get(pol, 'https://www.youtube.com/premium?hl=en', 14, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    if (/Premium is not available in your country/i.test(s)) return cb({ s: 'no', r: R_GEO });
    var m = /"countryCode":"([A-Z]{2})"/.exec(s) || /"GL":"([A-Z]{2})"/.exec(s);
    if (m) return cb({ s: 'ok', cc: m[1] });
    cb({ s: 'warn', r: R_DOWN });
  });
}

function checkPrime(pol, cb) {
  get(pol, 'https://www.primevideo.com/', 14, 2, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    var m = /"currentTerritory":"([A-Za-z]{2})"/.exec(s);
    if (m) return cb({ s: 'ok', cc: m[1].toUpperCase() });
    if (/not available in your (country|region)/i.test(s)) return cb({ s: 'no', r: R_GEO });
    cb({ s: 'warn', r: R_DOWN });
  });
}

// Spotify 官网是边缘缓存，各国页面一样；
// 只有注册接口 spclient 的 country 是按真实出口算的
function checkSpotify(pol, cb) {
  get(pol, 'https://spclient.wg.spotify.com/signup/public/v1/account?validate=1&email=probe%40example.com', 12, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    var m = /"country":"([A-Z]{2})"/.exec(s);
    if (m) return cb({ s: 'ok', cc: m[1] });
    cb({ s: 'warn', r: R_DOWN });
  });
}

// HBO Max：首页 languageVariables 只对「已开通地区」可信，
// 未开通地区（含台湾/新加坡/日本等）一律默认下发 en/us —— 拿它直接判定，
// 非美线会清一色误报 🇺🇸。所以必须拿落地 IP 交叉校验：
//   落地 US + 页面 us = 真美区
//   落地非 US + 页面 us = 美区默认兜底页，按落地地区报「地区限制」
//   落地非 US + 页面给出其它开通地区（如 JP）= 按页面算
function checkHBO(pol, cb) {
  get(pol, 'https://www.max.com/', 8, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    var m = /"languageVariables":\{"lang":"([a-z]{2})","country":"([a-z]{2})"/.exec(s);
    if (!m) {
      if (/not available in your (country|region)/i.test(s)) return regionBlocked(pol, cb);
      return cb({ s: 'warn', r: R_DOWN });
    }
    var page = m[2].toUpperCase();
    // 页面地区就是落地地区（含 US 线），可信
    geoCC(pol, function (geo) {
      if (!geo) return cb({ s: 'ok', cc: page });      // 反查失败，按页面算
      if (page === geo) return cb({ s: 'ok', cc: page });
      if (page === 'US') {
        // 美区默认兜底页：本地区没开通
        cb({ s: 'no', r: R_GEO, cc: geo });
      } else {
        cb({ s: 'ok', cc: page });                      // 其它开通地区按页面算
      }
    });
  });
}

// Hulu：只有美国本土有服务。hulu.com 对海外 IP 也返回 2MB 完整营销页、
// 没有任何拦截文案，「首页可达即 US」会让所有线都显示 🇺🇸。
// 改为：落地 IP 在美国才算解锁，否则直接按落地地区报「地区限制」。
function checkHulu(pol, cb) {
  get(pol, 'https://www.hulu.com/', 9, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    geoCC(pol, function (geo) {
      if (!geo) return cb({ s: 'warn', r: R_DOWN });
      if (geo === 'US') return cb({ s: 'ok', cc: 'US' });
      cb({ s: 'no', r: R_GEO, cc: geo });
    });
  });
}

function checkAbema(pol, cb) {
  get(pol, 'https://abema.tv/', 9, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    if (/ご利用になれません/.test(s)) return cb({ s: 'no', r: R_GEO });
    var m = /__CLIENT_REGION__\s*=\s*\{[^}]*"isoCountryCode":"([A-Z]{2})"/.exec(s);
    if (m) return cb({ s: 'ok', cc: m[1] });
    cb({ s: 'warn', r: R_DOWN });
  });
}

// Paramount+：首页 region 字段指出可用区域，
// 非美加线拿到的是 176KB 的官方拦截页，正片页是 500KB 上下
function checkParamount(pol, cb) {
  get(pol, 'https://www.paramountplus.com/', 12, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    var m = /"region":"([A-Z]{2})"/.exec(s);
    if (m) return cb({ s: 'ok', cc: m[1] });
    if (s.length < 300000) return cb({ s: 'no', r: R_GEO });
    cb({ s: 'warn', r: R_DOWN });
  });
}

// Peacock：只在美国开放，区域外返回 150KB 的官方提示页，
// 美国线是 700KB 的完整站
function checkPeacock(pol, cb) {
  get(pol, 'https://www.peacocktv.com/', 12, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    if (/not available in your|service is not available in your/i.test(s)) {
      return cb({ s: 'no', r: R_GEO });
    }
    if (s.length < 300000) return cb({ s: 'no', r: R_GEO });
    cb({ s: 'ok', cc: 'US' });
  });
}

// Viu：页面会自己跳到 /ott/<地区>/，那个地区码就是它认的地区；
// 港澳台新马都算可用，其余地区拿到 4KB 的拦截页
var VIU_OK = { HK: 1, TW: 1, MO: 1, SG: 1, MY: 1, TH: 1, ID: 1, PH: 1 };

function checkViu(pol, cb) {
  get(pol, 'https://www.viu.com/', 12, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    var m = /\/ott\/([a-z]{2})\//.exec(s);
    if (m) {
      var cc = m[1].toUpperCase();
      return cb({ s: VIU_OK[cc] ? 'ok' : 'no', cc: cc, r: VIU_OK[cc] ? '' : R_GEO });
    }
    if (s.length < 20000) return cb({ s: 'no', r: R_GEO });
    cb({ s: 'warn', r: R_DOWN });
  });
}

function checkBahamut(pol, cb) {
  get(pol, 'https://ani.gamer.com.tw/ajax/movie_updates.php', 9, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    var code = r.status || 0;
    if (code === 200) return cb({ s: 'ok', cc: 'TW' });
    if (code === 403) return cb({ s: 'no', r: R_GEO });
    cb({ s: 'warn', r: R_DOWN });
  });
}

// B站港澳台：x/web-interface/zone 直接回落地国家的中文名
var BILI_AREA = { '香港': 'HK', '台湾': 'TW', '澳门': 'MO', '中国': 'CN', '中国大陆': 'CN' };

function checkBili(pol, cb) {
  get(pol, 'https://api.bilibili.com/x/web-interface/zone', 12, 1, function (e, r, s) {
    if (e || !s) return regionBlocked(pol, cb);
    var d = {};
    try { d = (JSON.parse(s) || {}).data || {}; } catch (err) {}
    var cn = String(d.country || '');
    if (!cn) return cb({ s: 'warn', r: R_DOWN });
    var cc = BILI_AREA[cn] || '';
    if (cc === 'HK' || cc === 'TW' || cc === 'MO') {
      return cb({ s: 'ok', cc: cc });
    }
    // 落地在大陆或海外 = 没有港澳台番剧授权
    cb({ s: 'no', r: R_COPY, cc: cc });
  });
}

function traceCC(pol, host, cb) {
  get(pol, 'https://' + host + '/cdn-cgi/trace', 12, 1, function (e, r, s) {
    if (e || !s) return cb({ s: 'fail', r: R_DOWN });
    var m = /(?:^|\n)loc=([A-Za-z]{2})/.exec(s);
    if (!m) return cb({ s: 'warn', r: R_DOWN });
    var cc = m[1].toUpperCase();
    cb({ s: AI_BLOCK[cc] ? 'no' : 'ok', cc: cc, r: AI_BLOCK[cc] ? R_GEO : '' });
  });
}

function checkGPT(pol, cb) { traceCC(pol, 'chatgpt.com', cb); }
function checkClaude(pol, cb) { traceCC(pol, 'claude.ai', cb); }

function checkGemini(pol, cb) {
  get(pol, 'https://gemini.google.com/app?hl=en', 14, 1, function (e, r, s) {
    if (s && /isn.?t available in your (country|region)/i.test(s)) {
      return cb({ s: 'no', r: R_GEO });
    }
    if (s && /Gemini is not available/i.test(s)) {
      return cb({ s: 'no', r: R_GEO });
    }
    geoCC(pol, function (cc) {
      if (!cc) return cb({ s: s ? 'warn' : 'fail', r: R_DOWN });
      cb({ s: AI_BLOCK[cc] ? 'no' : 'ok', cc: cc, r: AI_BLOCK[cc] ? R_GEO : '' });
    });
  });
}

// ---------------- 平台表 ----------------

var ALL = [
  { k: 'netflix',   n: 'Netflix',     f: checkNetflix },
  { k: 'disney',    n: 'Disney+',     f: checkDisney },
  { k: 'youtube',   n: 'YouTube',     f: checkYouTube },
  { k: 'prime',     n: 'Prime Video', f: checkPrime },
  { k: 'spotify',   n: 'Spotify',     f: checkSpotify },
  { k: 'hbo',       n: 'HBO Max',     f: checkHBO },
  { k: 'hulu',      n: 'Hulu',        f: checkHulu },
  { k: 'paramount', n: 'Paramount+',  f: checkParamount },
  { k: 'peacock',   n: 'Peacock',     f: checkPeacock },
  { k: 'viu',       n: 'Viu',         f: checkViu },
  { k: 'abema',     n: 'Abema',       f: checkAbema },
  { k: 'bahamut',   n: '巴哈动画疯',  f: checkBahamut },
  { k: 'bili',      n: 'B站港澳台',   f: checkBili },
  { k: 'chatgpt',   n: 'ChatGPT',     f: checkGPT },
  { k: 'claude',    n: 'Claude',      f: checkClaude },
  { k: 'gemini',    n: 'Gemini',      f: checkGemini }
];

var ALIAS = {
  '网飞': 'netflix', '奈飞': 'netflix', 'nf': 'netflix',
  '迪士尼': 'disney', '迪+': 'disney',
  '油管': 'youtube', 'yt': 'youtube',
  '亚马逊': 'prime', 'pr': 'prime', 'primevideo': 'prime',
  '声田': 'spotify', 'sp': 'spotify',
  'max': 'hbo', 'hbomax': 'hbo',
  'hu': 'hulu',
  '派拉蒙': 'paramount', 'pm': 'paramount', 'paramount+': 'paramount',
  '孔雀': 'peacock', 'pc': 'peacock',
  'viu': 'viu', '黄viu': 'viu',
  'ab': 'abema',
  '巴哈': 'bahamut', '动画疯': 'bahamut',
  'b站': 'bili', '哔哩哔哩': 'bili',
  'gpt': 'chatgpt', 'openai': 'chatgpt',
  '克劳德': 'claude',
  '双子': 'gemini', '谷歌': 'gemini',
  'ai': 'chatgpt|claude|gemini'
};

function pickPlatforms(s) {
  var keys = splitList(s);
  if (!keys.length) return ALL;
  var set = {};
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i].toLowerCase();
    if (ALIAS[k]) {
      var exp = ALIAS[k].split('|');
      for (var x = 0; x < exp.length; x++) set[exp[x]] = 1;
    } else {
      set[k] = 1;
    }
  }
  var out = [];
  for (var j = 0; j < ALL.length; j++) {
    if (set[ALL[j].k]) out.push(ALL[j]);
  }
  return out.length ? out : ALL;
}

// ---------------- 探测一个组 ----------------

function probeGroup(g, cb) {
  var platforms = g.platforms;
  var results = [];
  var left = platforms.length;
  var finished = false;
  var queue = [];
  var running = 0;
  // 并发 6：16 个平台/建链耗时压到 3 秒内且连测 5 轮零失败；
  // 8 虽然再快 0.3 秒，但 5 轮里出现过 1 次 EOF（掉 1 个平台），不值得。
  var CONC = 6;

  if (!left) { cb(g, results); return; }

  platforms.forEach(function (p, idx) {
    results[idx] = undefined;
    queue.push({ p: p, idx: idx });
  });

  function settle(idx, r) {
    if (results[idx] !== undefined) return;
    results[idx] = r || { s: 'warn', r: R_DOWN };
    running--;
    if (--left === 0) {
      if (!finished) { finished = true; cb(g, results); }
      return;
    }
    pump();
  }

  function launch(job) {
    var idx = job.idx;
    var t = setTimeout(function () { settle(idx, { s: 'fail', r: R_DOWN }); }, 20000);
    function finish(r) {
      r = r || { s: 'fail', r: R_DOWN };
      // 判定为「未解锁」但还没拿到地区码的，补一次落地国家，
      // 这样受限行也能跟已解锁行一样显示国旗
      if (r.s === 'no' && !r.cc && results[idx] === undefined) {
        geoCCFast(g.ref, function (cc) {
          if (cc) r.cc = cc;
          settle(idx, r);
        });
        return;
      }
      settle(idx, r);
    }
    try {
      job.p.f(g.ref, function (r) {
        clearTimeout(t);
        finish(r);
      });
    } catch (e) {
      clearTimeout(t);
      finish({ s: 'fail', r: R_DOWN });
    }
  }

  // 错峰发起：同一瞬间打满并发也容易一起 EOF，隔 120ms 放一个
  function pump() {
    if (running >= CONC || !queue.length) return;
    var job = queue.shift();
    running++;
    launch(job);
    if (running < CONC && queue.length) {
      setTimeout(pump, 120);
    }
  }

  pump();
}

// ---------------- 渲染 ----------------

var LABEL_W = (function () {
  var w = 8;
  for (var i = 0; i < ALL.length; i++) {
    var d = dw(ALL[i].n) + 2;
    if (d > w) w = d;
  }
  return w;
})();

// 一行「状态图标 + 平台名 + 说明」：
//   图标放在最前面，所有行的图标都从同一像素位置起步，名字列、说明列自然对齐。
//   反过来写（名字打头再补空格）在非等宽字体里永远对不齐 —— 空格宽度和字母宽度不是一回事。
// ============================================================
// 名字列对齐：为什么必须逐字标定
//
// Surge 面板是比例字体，而且拉丁字母也不是等宽的。名字一长，
// 靠「补几个空格」蒙出来的结果必然歪 —— 前面几版全栽在这。
//
// 这一版的做法是从真机截图（1170×2532，3x）直接测量的：
//   1. 量出每一行「名字最后一个像素」的横坐标 nameR
//   2. 量出该行「状态图标左边缘」的横坐标 iconX
//   3. 用 16 行样本最小二乘解出两个常量：
//        全角空格 U+3000 = 50.39 px，半角空格 = 12.98 px，
//        名字右边界到图标之间还有 20.3 px 的固定间距
//   4. 选定目标线 iconX = 675.5（3x 像素），对每行反过来解
//      「需要几个全角 + 几个半角」，穷举到偏差最小
//
// 结果：16 行图标左边缘全部落在目标线上，最大偏差 2.4 px
// 即 0.8 pt —— 低于一个像素点，肉眼不可能分辨。
//
// ⚠️ 这张表是按这 16 个平台名硬标定的。改名字、加平台都必须重新标，
//    不能靠公式推。
// ============================================================

var NAME_PAD = {
  netflix:   '\u3000\u3000\u3000\u3000   ',
  disney:    '\u3000\u3000\u3000\u3000',
  youtube:   '\u3000           ',
  prime:     '\u3000\u3000 ',
  spotify:   '\u3000\u3000\u3000\u3000  ',
  hbo:       '\u3000\u3000\u3000 \u200a\u200a\u200a\u200a',
  hulu:      '\u3000                  ',
  paramount: '\u3000\u3000 ',
  peacock:   '               ',
  viu:       '\u3000\u3000\u3000\u3000\u3000     ',
  abema:     '\u3000\u3000          ',
  bahamut:   '\u3000\u3000   ',
  bili:      '\u3000\u3000    ',
  chatgpt:   '              ',
  claude:    '\u3000\u3000          ',
  gemini:    '\u3000\u3000          '
};

var TEXT_W = 5.0;   // 状态词列宽，「服务不可用」正好占满

// 状态词都是纯汉字，一个汉字 1em，按字数补到 5em 即可
function padText(t) {
  var buf = String(t);
  var need = TEXT_W - buf.length;
  for (var i = 0; i < need; i++) buf += '\u3000';
  return buf;
}

function line(p, r) {
  var fg = r.cc ? flagOf(r.cc) : '';
  var mark, text;

  if (r.s === 'ok') { mark = '✅'; text = '已解锁'; }
  else if (r.s === 'part') { mark = '🟡'; text = '部分解锁'; }
  else if (r.s === 'no') { mark = '❌'; text = r.r || R_GEO; }
  else { mark = '⚠️'; text = R_DOWN; }

  // 改版（作者新版式）：状态图标打头 → 状态词（padText 补齐 5 字宽）
  // → 平台名 → 国旗。前两列锚定在行首、每行同位，名字从固定列起步，
  // 天然成列，不再依赖按机型标定的 NAME_PAD 填充表（该表保留备查）。
  return mark + ' ' + padText(text) + p.n + (fg ? ' ' + fg : '');
}

function orderOf(p) {
  for (var i = 0; i < ALL.length; i++) if (ALL[i].k === p.k) return i;
  return 99;
}

function render() {
  if (RENDERED) return;
  RENDERED = true;

  var L = [];
  var anyFail = false;

  for (var g = 0; g < OUT.length; g++) {
    var o = OUT[g];
    if (g > 0) { L.push(''); L.push('────────────────'); }

    var items = [];
    var ok = 0, part = 0, no = 0, bad = 0;
    for (var i = 0; i < o.platforms.length; i++) {
      var p = o.platforms[i];
      var r = o.results[i] || { s: 'fail', r: R_DOWN };
      if (r.s === 'ok') ok++;
      else if (r.s === 'part') part++;
      else if (r.s === 'no') no++;
      else bad++;
      if (r.s === 'fail' || r.s === 'warn') anyFail = true;
      items.push({ p: p, r: r, ai: p.k === 'chatgpt' || p.k === 'claude' || p.k === 'gemini' });
    }
    items.sort(function (a, b) { return orderOf(a.p) - orderOf(b.p); });

    var total = items.length;

    // 第一组不留空行 —— 卡片标题栏已经写了「流媒体解锁」，
    // 内容里再来一行空白会把标题和 ◆ 顶开
    if (g > 0) L.push('');
    L.push('◆ ' + o.title + (o.node ? ' → ' + o.node : ''));

    // 整体解锁率：跟上面的策略行之间空一行，视觉上分开
    L.push('');
    if (!total) {
      L.push('📊 解锁率 —');
    } else {
      // 面板是纯文本、没有字号控制，这一行靠「比别的行少几个字」保持轻量
      var s = '📊 解锁率 ' + ok + '/' + total + ' 已解锁';
      if (part) s += ' · ' + part + ' 部分';
      if (no) s += ' · ' + no + ' 未解锁';
      if (bad) s += ' · ' + bad + ' 服务不可用';
      L.push(s);
    }

    if (!total) {
      L.push('');
      L.push('（本次未选平台）');
      continue;
    }

    // 三块：可用影音 / 不可用 / 可用 AI
    var goodVideo = [], badAny = [], goodAI = [];
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      if (it.r.s === 'ok' || it.r.s === 'part') {
        if (it.ai) goodAI.push(it); else goodVideo.push(it);
      } else {
        badAny.push(it);
      }
    }

    if (goodVideo.length) {
      L.push('');
      L.push('📺 影音平台');
      for (var a = 0; a < goodVideo.length; a++) L.push(line(goodVideo[a].p, goodVideo[a].r));
    }

    if (badAny.length) {
      L.push('');
      L.push('🚫 未解锁平台');
      for (var b = 0; b < badAny.length; b++) L.push(line(badAny[b].p, badAny[b].r));
    }

    if (goodAI.length) {
      L.push('');
      L.push('🤖 AI 平台');
      for (var c = 0; c < goodAI.length; c++) L.push(line(goodAI[c].p, goodAI[c].r));
    }
  }

  L.push('');
  L.push('🕒 检测时间：' + nowText());

  // 传了 style 就会被系统图标顶掉，所以这里只用自定义 icon：
  // 全通 = 打开的锁（绿），有失败 = 警示三角（橙）
  $done({
    title: '流媒体解锁',
    content: L.join('\n'),
    icon: anyFail ? 'exclamationmark.triangle.fill' : 'lock.open.fill',
    'icon-color': anyFail ? '#F59E0B' : '#22C55E'
  });
}

// ---------------- 主流程 ----------------

function run() {
  var typed = splitList(ARG_GROUPS);
  var platforms = pickPlatforms(ARG_PLAT);

  setTimeout(function () { render(); }, DEADLINE);

  apiGet('/v1/rules', function (r) {
    var finName = 'Proxy';
    var rules = (r && r.rules) || [];
    for (var i = 0; i < rules.length; i++) {
      var m = /^FINAL,(.+?)(,|$)/.exec(String(rules[i]));
      if (m) { finName = m[1]; break; }
    }

    var list = typed.slice();
    if (list.indexOf(finName) < 0) list.push(finName);

    apiGet('/v1/policies', function (pol) {
      var groups = [];
      for (var k = 0; k < list.length; k++) {
        var nm = list[k];
        groups.push({
          input: nm, title: nm, ref: nm, node: '',
          isFinal: nm === finName,
          platforms: platforms,
          results: []
        });
      }

      // 补当前选中节点（异步，不阻塞探测）
      for (var n = 0; n < groups.length; n++) {
        (function (gr) {
          try {
            apiGet('/v1/policy_groups/select?group_name=' + encodeURIComponent(gr.ref), function (s) {
              if (s && s.policy) gr.node = String(s.policy);
            });
          } catch (e) {}
        })(groups[n]);
      }

      // 组按顺序跑，避免一次打太多并发请求
      var idx = 0;
      (function next() {
        if (idx >= groups.length) { render(); return; }
        var gr = groups[idx++];
        OUT.push(gr);
        probeGroup(gr, function (gg, results) {
          gg.results = results;
          next();
        });
      })();
    });
  });
}

run();
