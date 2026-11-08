// ============================================================
// 机场流量面板 · Surge 通用版  V1.0
// 数据源：订阅链接响应头 subscription-userinfo（V2board / SSPanel / 新V2 通用）
//
// 参数：一个机场一组三格（机场名 / 订阅链接 / 重置日），共 6 组
//   0 name1   1 url1   2 day1
//   3 name2   4 url2   5 day2
//   6 name3   7 url3   8 day3
//   9 name4  10 url4  11 day4
//  12 name5  13 url5  14 day5
//  15 name6  16 url6  17 day6
//  18 ua     19 policy
// 每组的重置日留空时，自动回退到第一个填了重置日的机场，再回退到 1 号
// ============================================================

var ARG = (typeof $argument !== 'undefined' && $argument) ? String($argument) : '';
var P = ARG.split('|');

function raw(i) {
  if (P[i] === undefined) return '';
  var v = String(P[i]).trim();
  if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function isBlank(v) {
  v = String(v || '').trim();
  if (!v) return true;
  if (/^(空|无|none|null|undefined|nil|-)$/i.test(v)) return true;
  // 参数页占位词：用户不填时这里会原样保留这些字，一律当空
  if (/^(留空|不填|空着|不用|无需|跳过|未填)$/.test(v)) return true;
  if (/^填写?(机场名|名称|url|链接|订阅|重置日|日期|号)$/i.test(v)) return true;
  if (/^填写.*(机场名|URL|链接|重置日|订阅)$/i.test(v)) return true;
  if (/^<.+>$/.test(v)) return true;
  if (/^请?填/.test(v)) return true;   // 参数页占位提示：填机场名 / 填订阅链接 / 填重置日
  if (/^(https?:\/\/)?example\.com/i.test(v)) return true;
  if (/^https?:\/\/订阅链接/i.test(v)) return true;
  if (/^机场\d+$/.test(v)) return true;
  return false;
}
function real(v) { return isBlank(v) ? '' : String(v).trim(); }

function hash(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

var GB = 1073741824;

// ---------------- 参数：6 组机场（名 + 链接 + 重置日） ----------------
// 改版：重置日填 0 = 该机场不重置（不参与公共重置日继承，面板显示「不重置」）；1-31 照旧；留空仍继承。
var AIRPORTS = [];
for (var gi = 0; gi < 6; gi++) {
  var nm = real(raw(gi * 3));
  var ur = real(raw(gi * 3 + 1));
  var dy = parseInt(real(raw(gi * 3 + 2)), 10);
  if (!ur) continue;
  AIRPORTS.push({
    name: nm || ('\u673a\u573a' + (gi + 1)),
    sub: ur,
    day: (dy === 0) ? 0 : ((dy >= 1 && dy <= 31) ? dy : null),
    key: 'apt_' + hash(ur),
    info: null,
    stale: false,
    err: ''
  });
}

// 公共重置日：第一个填了的值，都没有就 1
var FALLBACK_DAY = 1;
for (var fi = 0; fi < AIRPORTS.length; fi++) {
  if (AIRPORTS[fi].day) { FALLBACK_DAY = AIRPORTS[fi].day; break; }
}
AIRPORTS.forEach(function (a) { if (a.day === null || a.day === undefined) a.day = FALLBACK_DAY; });

var UA = 'Clash/1.18.0';

// ---------------- 工具 ----------------
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function md(d) { return pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function ymd(d) { return d.getFullYear() + '-' + md(d); }
function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

function fmtB(b) {
  if (b === null || b === undefined || isNaN(b)) return '--';
  var g = b / GB;
  if (g >= 1024) return (g / 1024).toFixed(2) + ' TB';
  if (g >= 10) return g.toFixed(1) + ' GB';
  return g.toFixed(2) + ' GB';
}
function fmtS(b) {
  if (b === null || b === undefined || isNaN(b)) return '--';
  var g = b / GB;
  if (g >= 1024) return (g / 1024).toFixed(1) + 'T';
  if (g >= 10) return g.toFixed(0) + 'G';
  if (g >= 1) return g.toFixed(1) + 'G';
  return (g * 1024).toFixed(0) + 'M';
}

function bar(pct, n) {
  n = n || 12;
  var f = Math.round(pct / 100 * n);
  if (!isFinite(f) || f < 0) f = 0;
  if (f > n) f = n;
  var s = '';
  for (var i = 0; i < n; i++) s += (i < f ? '\u2588' : '\u2591');
  return s;
}

function getHeader(h, key) {
  if (!h) return '';
  var lk = String(key).toLowerCase();
  for (var k in h) {
    if (String(k).toLowerCase() === lk) return h[k];
  }
  return '';
}

function parseUserInfo(s) {
  var o = {};
  String(s || '').split(';').forEach(function (seg) {
    var i = seg.indexOf('=');
    if (i < 0) return;
    var k = seg.slice(0, i).trim().toLowerCase();
    var v = seg.slice(i + 1).trim();
    if (/^\d+$/.test(v)) o[k] = parseInt(v, 10);
  });
  return o;
}

function parseBody(s) {
  if (!s || s.length > 400000) return null;
  var j;
  try { j = JSON.parse(s); } catch (e) { return null; }
  var cands = [j, j && j.data, j && j.data && j.data.user, j && j.user];
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    if (!c || typeof c !== 'object') continue;
    var up = c.upload !== undefined ? c.upload : c.up;
    var down = c.download !== undefined ? c.download : c.down;
    var total = c.total !== undefined ? c.total : c.transfer_enable;
    var expire = c.expire !== undefined ? c.expire : c.expired_at;
    if (up !== undefined || down !== undefined || total !== undefined) {
      return {
        upload: Number(up) || 0,
        download: Number(down) || 0,
        total: Number(total) || 0,
        expire: Number(expire) || undefined
      };
    }
  }
  return null;
}

// 按该机场自己的重置日算下次重置
function resetInfo(day) {
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  var dayCur = Math.min(day, new Date(y, m + 1, 0).getDate());
  var next, days;
  if (d <= dayCur) {
    next = new Date(y, m, dayCur);
    days = dayCur - d;
  } else {
    var nd = Math.min(day, new Date(y, m + 2, 0).getDate());
    next = new Date(y, m + 1, nd);
    days = Math.round((next - new Date(y, m, d)) / 86400000);
  }
  return { date: next, days: days };
}

function expireOf(v) {
  var t = Number(v) || 0;
  if (t <= 0) return null;
  if (t > 1e12) t = Math.floor(t / 1000);
  var d = new Date(t * 1000);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return null;
  return d;
}
function daysTo(d) {
  var t0 = new Date();
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
    new Date(t0.getFullYear(), t0.getMonth(), t0.getDate())) / 86400000);
}

function loadCache(key) {
  try {
    var s = $persistentStore.read(key);
    if (!s) return null;
    var o = JSON.parse(s);
    if (o && (o.total || o.upload || o.download)) return o;
  } catch (e) {}
  return null;
}
function saveCache(key, o) {
  try { $persistentStore.write(JSON.stringify(o), key); } catch (e) {}
}
function pctOf(d) {
  var t = Number(d.total) || 0;
  if (t <= 0) return null;
  return ((Number(d.upload) || 0) + (Number(d.download) || 0)) / t * 100;
}

// ---------------- 单机场详细块（只有 1 个机场时） ----------------
function blockFull(d, day, stale) {
  var up = Number(d.upload) || 0;
  var down = Number(d.download) || 0;
  var used = up + down;
  var total = Number(d.total) || 0;
  var L = [];

  if (total > 0) {
    var pct = used / total * 100;
    L.push('\u603b\u6d41\u91cf  ' + fmtB(total));
    L.push('\u5df2\u6d88\u8017  ' + fmtB(used) + '  ' + pct.toFixed(1) + '%');
    L.push('\u5269\u4f59    ' + fmtB(Math.max(0, total - used)));
    L.push(bar(pct) + ' ' + pct.toFixed(0) + '%');
  } else {
    L.push('\u603b\u6d41\u91cf  \u4e0d\u9650');
    L.push('\u5df2\u6d88\u8017  ' + fmtB(used));
  }

  L.push('\u2191 ' + fmtB(up) + '   \u2193 ' + fmtB(down));

  if (day === 0) {
    L.push('\u91cd\u7f6e  \u4e0d\u91cd\u7f6e');
  } else {
    var r = resetInfo(day);
    L.push('\u91cd\u7f6e  \u6bcf\u6708 ' + day + ' \u53f7 \u00b7 ' + md(r.date) +
      (r.days === 0 ? '\uff08\u4eca\u5929\uff09' : '\uff08' + r.days + ' \u5929\u540e\uff09'));
  }

  var exp = expireOf(d.expire);
  if (exp) {
    var dd = daysTo(exp);
    L.push('\u5230\u671f  ' + ymd(exp) + (dd >= 0 ? '\uff08' + dd + ' \u5929\u540e\uff09' : '\uff08\u5df2\u8fc7\u671f\uff09'));
  }

  if (stale) {
    var c0 = new Date(d.t || Date.now());
    L.push('\u26a0\ufe0f \u672c\u6b21\u62c9\u53d6\u5931\u8d25\uff0c\u4e3a ' + md(c0) + ' ' + hhmm(c0) + ' \u7f13\u5b58');
  }
  return L;
}

// ---------------- 单机场紧凑块（多机场时） ----------------
function blockTight(d, name, day, stale) {
  var up = Number(d.upload) || 0;
  var down = Number(d.download) || 0;
  var used = up + down;
  var total = Number(d.total) || 0;
  var pct = pctOf(d);
  var L = [];

  L.push((stale ? '\u26a0\ufe0f ' : '\u2708\ufe0f ') + name + '   ' +
    (total > 0 ? fmtS(total) : '\u4e0d\u9650'));

  if (total > 0) {
    L.push('\u5df2\u7528 ' + fmtS(used) + '  \u5269 ' + fmtS(Math.max(0, total - used)) +
      '  ' + bar(pct, 8) + ' ' + pct.toFixed(0) + '%');
  } else {
    L.push('\u5df2\u7528 ' + fmtS(used) + '  \u4e0d\u9650');
  }

  if (day === 0) {
    L.push('\u2191' + fmtS(up) + '  \u2193' + fmtS(down) + '  \u4e0d\u91cd\u7f6e');
  } else {
    var r = resetInfo(day);
    L.push('\u2191' + fmtS(up) + '  \u2193' + fmtS(down) + '  ' + md(r.date) + ' \u91cd\u7f6e\u00b7' + day + '\u53f7');
  }

  var exp = expireOf(d.expire);
  if (exp) L.push('\u5230\u671f ' + ymd(exp) + ' \u00b7 ' + daysTo(exp) + ' \u5929');
  if (stale) L.push('\u7f13\u5b58\u6570\u636e');

  return L;
}

// ---------------- 汇总渲染 ----------------
function render(items) {
  var okN = 0, badN = 0, sumT = 0, sumU = 0;
  var anyUnlimited = false, maxPct = -1, stale = false;

  items.forEach(function (it) {
    if (!it.info) { badN++; return; }
    okN++;
    if (it.stale) stale = true;
    sumU += (Number(it.info.upload) || 0) + (Number(it.info.download) || 0);
    var t = Number(it.info.total) || 0;
    if (t > 0) sumT += t; else anyUnlimited = true;
    var p = pctOf(it.info);
    if (p !== null && p > maxPct) maxPct = p;
  });

  var multi = items.length > 1;
  var title = multi ? ('\u673a\u573a\u6d41\u91cf \u00b7 ' + items.length + ' \u4e2a')
    : (items[0] && items[0].name ? items[0].name : '\u673a\u573a\u6d41\u91cf');

  var L = [];

  items.forEach(function (it, idx) {
    if (multi && idx > 0) L.push('');
    if (!it.info) {
      L.push('\u2708\ufe0f ' + it.name);
      L.push('\u26a0\ufe0f \u83b7\u53d6\u5931\u8d25' + (it.err ? '\uff1a' + it.err : '') +
        '  \u00b7' + (it.day === 0 ? '\u4e0d\u91cd\u7f6e' : '\u6bcf\u6708' + it.day + '\u53f7\u91cd\u7f6e'));
      return;
    }
    L = L.concat(multi ? blockTight(it.info, it.name, it.day, it.stale)
      : blockFull(it.info, it.day, it.stale));
  });

  if (multi && okN > 1) {
    L.push('');
    L.push('\u5408\u8ba1\uff08' + okN + ' \u4e2a\u673a\u573a\uff09');
    L.push('\u5df2\u6d88\u8017 ' + fmtS(sumU) +
      (sumT > 0 ? ' / ' + fmtS(sumT) + (anyUnlimited ? '+\u4e0d\u9650' : '') : ''));
    if (sumT > 0) {
      L.push('\u5269\u4f59 ' + fmtS(Math.max(0, sumT - sumU)) +
        (anyUnlimited ? '' : '   ' + (sumU / sumT * 100).toFixed(0) + '%'));
      if (!anyUnlimited) L.push(bar(sumU / sumT * 100) + ' ' + (sumU / sumT * 100).toFixed(0) + '%');
    }
  }

  L.push('');
  L.push('\u66f4\u65b0 ' + md(new Date()) + ' ' + hhmm(new Date()));

  var style = 'good';
  if (okN === 0) style = 'error';
  else if (stale || badN > 0) style = 'alert';
  else if (maxPct >= 100) style = 'error';
  else if (maxPct >= 90) style = 'alert';
  else if (maxPct < 0) style = 'info';

  $done({
    title: (stale ? '\u26a0\ufe0f ' : '') + title,
    content: L.join('\n'),
    style: style
  });
}

// ---------------- 主流程 ----------------
if (AIRPORTS.length === 0) {
  $done({
    title: '\u673a\u573a\u6d41\u91cf',
    content: '\u5c1a\u672a\u914d\u7f6e\u673a\u573a\n\n' +
      '\u70b9\u6a21\u5757 \u2192 \u53c2\u6570\uff0c\u516d\u7ec4\u5404\u81ea\u4e09\u683c\uff1a\n' +
      '\u673a\u573aname1 / \u8ba2\u9605URL1 / \u91cd\u7f6e\u65e51\n' +
      '\u673a\u573aname2 / \u8ba2\u9605URL2 / \u91cd\u7f6e\u65e52\n' +
      '\u2026\u2026 \u76f4\u5230\u673a\u573aname6 / \u8ba2\u9605URL6 / \u91cd\u7f6e\u65e56\n\n' +
      '\u54ea\u7ec4\u4e0d\u7528\uff0c\u90a3\u4e09\u683c\u5199\u300c\u7559\u7a7a\u300d\u5373\u53ef',
    style: 'info'
  });
} else {
  var valid = AIRPORTS.filter(function (it) {
    return /^https?:\/\/[^\s]+\./i.test(it.sub);
  });
  var pending = valid.length;

  if (!pending) {
    $done({
      title: '\u673a\u573a\u6d41\u91cf',
      content: '\u8ba2\u9605\u94fe\u63a5\u683c\u5f0f\u4e0d\u5bf9\n\n\u5fc5\u987b\u662f\u5b8c\u6574 https \u94fe\u63a5',
      style: 'error'
    });
  } else {
    valid.forEach(function (it) {
      var req = {
        url: it.sub,
        headers: {
          'User-Agent': UA,
          'Accept': '*/*',
          'Accept-Encoding': 'identity'
        },
        timeout: 15
      };

      $httpClient.get(req, function (err, resp, data) {
        var info = null;
        if (!err && resp) {
          var hdr = getHeader(resp.headers, 'subscription-userinfo');
          if (!hdr) {
            var alts = ['userinfo', 'x-userinfo', 'traffic-userinfo'];
            for (var i = 0; i < alts.length && !hdr; i++) hdr = getHeader(resp.headers, alts[i]);
          }
          if (hdr) info = parseUserInfo(hdr);
          if (info && info.total === undefined && info.download === undefined && info.upload === undefined) info = null;
          if (!info && data) info = parseBody(data);
        }

        if (info) {
          info.t = Date.now();
          saveCache(it.key, info);
          it.info = info;
        } else {
          var c = loadCache(it.key);
          if (c) { it.info = c; it.stale = true; }
          else it.err = err ? String(err) : (resp ? 'HTTP ' + resp.status + ' \u65e0\u6d41\u91cf\u5934' : '\u65e0\u54cd\u5e94');
        }

        if (--pending === 0) render(AIRPORTS);
      });
    });
  }
}
