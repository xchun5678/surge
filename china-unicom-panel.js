/**
 * 中国联通（Surge 面板版）
 *
 * 话费 / 流量 / 语音余量面板 + 登录信息捕获，单文件四模式（靠 Surge 全局变量分发）：
 *   1. type=generic       → 面板：显示话费/账户余额、流量（通用+定向口径）、定向流量、剩余语音
 *   2. type=http-request  → App 捕获：监听联通 App 请求（m.client.10010.com），抓 Cookie 与手机号
 *   3. type=http-response → 小程序解析：解析微信「中国联通」小程序响应（mina 首页接口 + mxx 余量查询页）
 *   4. type=cron          → 每 20 分钟保活查询一次，保持会话活跃（静默，不发通知）
 *
 * 适配自 moyuzaime/egern 的 ChinaUnicom_Widget.js（原作 iBL3ND）。
 * 数据层、捕获层、小程序解析层、查询层逻辑原样搬运，只换了平台 API 外壳；
 * 原 Egern 的 Widget DSL / SVG 渲染层（classic / dash / ios 三套）整体丢弃，
 * 换成 Surge 面板文字渲染（cuUiStyle 参数因此不再保留，数据口径不受影响）。
 * 全文除联通官方接口（*.10010.com）外无任何外发地址。
 *
 * 模块参数（对应原 Egern 版 Env）：
 *   cuCapture         App 数据抓取开关（默认 true；false = App 侧不写入任何数据）
 *   cuCaptureNotice   捕获成功通知（默认 true）
 *   cuPlanNotice      套餐查询成功通知（默认 true；保活模式下不生效）
 *   cuMiniCapture     微信小程序数据抓取开关（默认 true）
 *   cuGeneralFlow     流量统计包含通用流量（默认 true）
 *   cuDirectionalFlow 流量统计包含定向流量并单独显示一行（默认 true）
 *   cuDebug           调试日志（默认 false）
 *   CU_KEEPALIVE      'true' 走保活模式（模块里 cron 条目自动带上，其他条目不要带）
 *
 * 数据来源：
 *   https://m.client.10010.com/mobileserviceimportant/home/queryUserInfoSeven
 *   https://m.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune
 *   https://mina.10010.com/wxapplet/weixinNew/sspbigball（被动解析）
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

const CU_ENV = parseArgument();

// ctx.storage → $persistentStore（注意 Surge 的 write 是 (值, 键) 顺序）
const CU_STORE = {
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
  delete(key) {
    try { $persistentStore.write(null, key); return; } catch (e) {}
    try { $persistentStore.write('', key); } catch (e) {}
  },
};

// ctx.http.get/post(url, {headers, body, timeout 毫秒}) → $httpClient（回调式转 Promise，timeout 转秒）
// 返回 {status, headers, body, text(), json()}，网络错误时 reject（与原版 fetch 风格一致）
function httpRequest(method, url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const req = { url, method };
    if (opts.headers) req.headers = opts.headers;
    if (opts.body != null) req.body = opts.body;
    if (opts.timeout) req.timeout = Math.max(1, Math.round(opts.timeout / 1000));
    const cb = (error, response, data) => {
      if (error) { reject(new Error(String(error))); return; }
      const body = data == null ? '' : (typeof data === 'string' ? data : String(data));
      resolve({
        status: response ? response.status : 0,
        headers: response ? (response.headers || {}) : {},
        body,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body)),
      });
    };
    try {
      if (method === 'GET') $httpClient.get(req, cb);
      else $httpClient.post(req, cb);
    } catch (e) { reject(e); }
  });
}

const CU_HTTP = {
  get(url, opts) { return httpRequest('GET', url, opts); },
  post(url, opts) { return httpRequest('POST', url, opts); },
};

function buildCtx() {
  const ctx = {
    env: CU_ENV,
    storage: CU_STORE,
    http: CU_HTTP,
    notify(o) {
      try { $notification.post((o && o.title) || '中国联通', '', (o && o.body) || ''); } catch (e) {}
    },
    widgetFamily: 'systemMedium', // Surge 无小组件尺寸概念，仅占位
  };
  try { if (typeof $request !== 'undefined' && $request) ctx.request = $request; } catch (e) {}
  try {
    if (typeof $response !== 'undefined' && $response) {
      const body = $response.body == null ? '' : (typeof $response.body === 'string' ? $response.body : String($response.body));
      ctx.response = {
        status: $response.status,
        headers: $response.headers || {},
        body,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body)),
      };
    }
  } catch (e) {}
  return ctx;
}

/* =========================================================
 * 基础配置
 * ========================================================= */

const API_HOST = 'm.client.10010.com';
const MINI_PROGRAM_HOST = 'mxx.client.10010.com';
const KEY = 'unicom';
// 每 25 分钟最多一个采样点，96 个点约覆盖 24 小时，"今日流量使用"才有完整曲线（原来只留 24 个点，不足 10 小时）。
const HISTORY_LIMIT = 96;

const API_URL =
  'https://m.client.10010.com/mobileserviceimportant/home/queryUserInfoSeven';

// 微信小程序「中国联通」首页大球接口。返回结构与 App 的 queryUserInfoSeven 同构，
// 因此响应体可以直接复用 parseUnicomData 解析（协议来源见 README）。
// 流量明细接口（通用/定向分项）。参考 IBL3ND/module 的做法：App 侧 POST + Cookie 即可，不依赖小程序。
const FLOW_DETAIL_URL =
  'https://m.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune';

// 明细里按这些容器取子项（容器名参与「免流流量」判定）
const FLOW_CONTAINERS = {
  resources: '通用流量',
  RzbResources: '日租宝',
  MlResources: '免流流量',
  XsbResources: '限时流量',
};

// 定向（免流）判定：命中任一即为定向，其余计入通用
function isDirectionalFlowItem(item, containerName) {
  const code = String((item && item.addupItemCode) || '');
  const name = String((item && item.addUpItemName) || '');
  const fee = String((item && item.feePolicyName) || '');
  return code === '40008' ||
    name === '套餐内专享免费流量' ||
    containerName === '免流流量' ||
    /（免流）|畅视/.test(fee);
}

// 把明细响应整理成组件用的结构（单位 MB）
function parseDetailFlow(body) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  let gR = 0, gT = 0, gU = 0, dR = 0, dT = 0, dU = 0;
  let percent = null;
  let voiceRemain = null;
  let smsRemain = null;

  for (const key of Object.keys(FLOW_CONTAINERS)) {
    const list = body[key];
    if (!Array.isArray(list)) continue;
    for (const res of list) {
      const details = res && res.details;
      if (!Array.isArray(details)) continue;
      for (const item of details) {
        const remain = Math.max(0, num(item && item.remain));
        const total = Math.max(0, num(item && item.total));
        const used = Math.max(0, num(item && item.use));
        if (isDirectionalFlowItem(item, FLOW_CONTAINERS[key])) {
          dR += remain; dT += total; dU += used;
        } else {
          gR += remain; gT += total; gU += used;
        }
        if (percent == null && item && item.usedPercent != null) {
          const p = num(item.usedPercent);
          if (p) percent = Math.min(1, Math.max(0, p / 100));
        }
      }
    }
  }

  for (const res of Array.isArray(body.resources) ? body.resources : []) {
    const type = String((res && res.type) || '').toLowerCase();
    if (type === 'voice' && voiceRemain == null) voiceRemain = num(res.remainResource);
    if (type === 'smslist' && smsRemain == null) smsRemain = num(res.remainResource);
  }

  let otherUsedMB = 0;
  for (const row of body.flowSumList || []) {
    if (String(row && row.flowtype) === '3') otherUsedMB += num(row.xusedvalue);
  }

  const directional = (dR + dT + dU) > 0 ? { usedMB: dU, remainMB: dR, totalMB: dT } : null;
  const percentFromTotals = (gU + dU) > 0 ? Math.min(1, (gU + dU) / Math.max(1, gU + dU + gR + dR)) : null;

  return {
    ts: Date.now(),
    packageName: body.packageName ? String(body.packageName) : '',
    time: body.time ? String(body.time) : '',
    remainMB: gR,
    usedMB: gU,
    totalMB: gT || null,
    percent: percent != null ? percent : percentFromTotals,
    otherUsedMB,
    general: { usedMB: gU, remainMB: gR, totalMB: gT },
    directional,
    voiceRemain,
    smsRemain,
  };
}

// 主动拉一次明细：App 侧 POST，带 Cookie 即可
async function fetchFlowDetail(ctx, cookie) {
  const resp = await ctx.http.post(FLOW_DETAIL_URL, {
    timeout: 5000,
    headers: {
      Cookie: cookie,
      'User-Agent': 'ChinaUnicom.x CFNetwork iOS/16.3',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: '',
    credentials: 'omit',
  });
  if (!resp || resp.status !== 200) throw new Error('HTTP ' + (resp ? resp.status : 'no-response'));
  const body = await resp.json();
  if (!body || String(body.code) !== '0000') throw new Error('code ' + String(body && body.code));
  return parseDetailFlow(body);
}

const MINI_API_PATH = '/wxapplet/weixinNew/';
const MINI_API_BASE = 'https://mina.10010.com' + MINI_API_PATH;
const MINI_SSP_BIGBALL = MINI_API_BASE + 'sspbigball';


/* =========================================================
 * 颜色
 * ========================================================= */


/* =========================================================
 * Cookie / 手机号捕获
 * ========================================================= */

function getRequestHeader(headers, name) {
  if (!headers) return '';

  try {
    if (typeof headers.get === 'function') {
      return headers.get(name) || '';
    }
  } catch (e) {}

  try {
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === name.toLowerCase()) {
        return headers[key] || '';
      }
    }
  } catch (e) {}

  return '';
}


// App 不同接口用的手机号参数名不一样，这里都试一遍，最后统一按 11 位号码校验，
// 避免把 pageNum / userNum 这类参数误当成手机号。
const PHONE_PARAM_NAMES = ['desmobiel', 'desmobile', 'usermobile', 'mobile', 'phone', 'mobileno', 'userNumber'];

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // 允许 86 前缀、空格和短横线
  const digits = raw.replace(/[\s-]/g, '').replace(/^\+?86/, '');
  return /^1\d{10}$/.test(digits) ? digits : '';
}

function extractPhone(url) {
  if (!url) return '';

  try {
    const query = String(url).split('#')[0].split('?')[1] || '';
    if (!query) return '';
    for (const pair of query.split('&')) {
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const key = pair.slice(0, idx).toLowerCase();
      if (!PHONE_PARAM_NAMES.some(name => name.toLowerCase() === key)) continue;
      let value = pair.slice(idx + 1);
      try {
        value = decodeURIComponent(value);
      } catch (e) {}
      const phone = normalizePhone(value);
      if (phone) return phone;
    }
  } catch (e) {}

  return '';
}


async function fetchUnicomData(
  ctx,
  cookie,
  phone
) {

  const url =
    `${API_URL}?version=iphone_c@10.0100` +
    `&desmobiel=${encodeURIComponent(phone)}` +
    `&showType=0`;

  const resp = await ctx.http.get(
    url,
    {
      timeout: 10000,

      headers: {
        Host: API_HOST,

        'User-Agent':
          'ChinaUnicom.x CFNetwork iOS/16.3',

        Cookie: cookie,
      },

      credentials: 'omit',
    }
  );


  if (!resp || resp.status !== 200) {
    const status = resp ? resp.status : 0;
    const err = new Error(
      `HTTP ${resp ? resp.status : 'no-response'}`
    );
    // 401/403/302 基本意味着登录态失效，需要用户重新抓一次凭据。
    err.kind = status === 401 || status === 403 || status === 302 ? 'auth' : 'http';
    throw err;
  }


  return await resp.json();
}


/* =========================================================
 * 数据解析
 * ========================================================= */

function parseUnicomData(res) {

  if (
    !res ||
    res.code !== 'Y' ||
    !res.feeResource ||
    !res.voiceResource ||
    !res.flowResource
  ) {
    const err = new Error(
      `API 返回异常：${res?.code || 'unknown'}`
    );
    err.kind = 'auth';
    throw err;
  }


  const feeResource =
    res.feeResource;

  const voiceResource =
    res.voiceResource;

  const flowResource =
    res.flowResource;


  return {
    fee: {
      title:
        feeResource.dynamicFeeTitle ||
        '剩余话费',

      value:
        feeResource.feePersent ??
        0,

      unit:
        feeResource.newUnit ||
        '元',
    },

    voice: {
      title:
        voiceResource.dynamicVoiceTitle ||
        '剩余语音',

      value:
        voiceResource.voicePersent ??
        0,

      unit:
        voiceResource.newUnit ||
        '分钟',
    },

    flow: {
      title:
        flowResource.dynamicFlowTitle ||
        '剩余流量',

      value:
        flowResource.flowPersent ??
        0,

      unit:
        flowResource.newUnit ||
        'MB',
    },

    updateTime:
      new Date().toLocaleTimeString(
        'zh-CN',
        {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Shanghai',
        }
      ),

    timestamp: Date.now(),
  };
}


/* =========================================================
 * 加载数据
 * ========================================================= */


function captureDebug(message) {
  try {
    if (typeof console !== 'undefined' && typeof console.log === 'function') {
      console.log('[ChinaUnicom Capture] ' + message);
    }
  } catch (e) {}
}

async function handleCapture(ctx) {
  const req = ctx.request || {};
  const url = String(req.url || '');
  // 日志只记录路径和布尔状态，绝不输出查询参数、手机号、Cookie 或 Token。
  const safePath = url.split('?')[0].split('#')[0];
  if (ctx.env && String(ctx.env.cuCapture).toLowerCase() === 'false') {
    captureDebug('skip(disabled): cuCapture=false; path=' + safePath);
    return;
  }
  const isAppRequest = url.includes(API_HOST);
  const isMiniProgramRequest = url.includes(MINI_PROGRAM_HOST);
  if (!isAppRequest && !isMiniProgramRequest) {
    captureDebug('skip(host): host mismatch; path=' + safePath);
    return;
  }

  // 微信小程序接口先只做脱敏侦察。未知请求结构不写入旧 App 凭据，也不尝试用旧接口解析。
  if (isMiniProgramRequest) {
    const method = String(req.method || 'unknown').toUpperCase();
    const headers = req.headers || {};
    let headerNames = [];
    try {
      if (typeof headers.keys === 'function') headerNames = Array.from(headers.keys());
      else headerNames = Object.keys(headers);
    } catch (e) {}
    headerNames = headerNames.map(k => String(k).toLowerCase()).sort();
    const body = req.body;
    const bodyType = body === null || body === undefined ? 'empty' : typeof body;
    let bodyLength = 0;
    let bodyKeys = [];
    try {
      if (typeof body === 'string') {
        bodyLength = body.length;
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bodyKeys = Object.keys(parsed).sort();
        } catch (e) {}
      } else if (body && typeof body === 'object') {
        bodyKeys = Object.keys(body).sort();
        bodyLength = JSON.stringify(body).length;
      }
    } catch (e) {}
    // Do not print request values. This diagnostic is intentionally metadata-only.
    captureDebug('mini-program request: method=' + method +
      '; path=' + safePath +
      '; headerNames=' + headerNames.join(',') +
      '; bodyType=' + bodyType +
      '; bodyLength=' + bodyLength +
      '; bodyKeys=' + bodyKeys.join(','));
    return;
  }

  const cookie = String(getRequestHeader(req.headers, 'cookie') || '').trim();
  const phone = extractPhone(url);

  // App 里大量接口（如 servicequerybusiness/yidingyewu）本来就不带 Cookie 和 desmobiel。
  // 这类请求只留一行日志就退出：既不误弹通知，也不会让日志看起来像报错。
  if (!cookie && !phone) {
    captureDebug('skip(no-creds): path=' + safePath);
    return;
  }

  // 只有套餐查询 / 登录类请求才值得提示「凭据不完整」。
  const planLike = Boolean(phone) ||
    /queryUserInfo|desmobiel|userinfo|login|home\/query/i.test(url);

  captureDebug('triggered: path=' + safePath +
    '; cookiePresent=' + Boolean(cookie) +
    '; phoneParamPresent=' + Boolean(phone) +
    '; planLike=' + planLike);

  let cookieChanged = false;
  let phoneChanged = false;
  if (cookie) {
    const previousCookie = ctx.storage.get('unicom_cookie') || '';
    if (cookie !== previousCookie) {
      ctx.storage.set('unicom_cookie', cookie);
      cookieChanged = true;
    }
  }
  if (phone) {
    const previousPhone = ctx.storage.get('unicom_phone') || '';
    if (phone !== previousPhone) {
      ctx.storage.set('unicom_phone', phone);
      phoneChanged = true;
    }
  }

  if (cookie && phone && (cookieChanged || phoneChanged)) {
    ctx.storage.set('unicom_captureTime', String(Date.now()));
    captureDebug('success: credentials updated; cookieChanged=' + cookieChanged + '; phoneChanged=' + phoneChanged);
    if ((!ctx.env || String(ctx.env.cuCaptureNotice).toLowerCase() !== 'false') && typeof ctx.notify === 'function') {
      const maskedPhone = phone ? '（尾号 ' + phone.slice(-4) + '）' : '';
      ctx.notify({
        title: '中国联通数据捕获成功',
        body: '已捕获登录信息' + maskedPhone + '，正在更新套餐数据',
        sound: false,
      });
    }
    return;
  }

  const captureNoticeEnabled = !ctx.env || String(ctx.env.cuCaptureNotice).toLowerCase() !== 'false';
  const notifyDiagnostic = (status) => {
    if (!captureNoticeEnabled || typeof ctx.notify !== 'function') return;
    // 限频，避免 App 连续请求时反复弹通知；通知内容只包含状态，不包含任何凭据。
    const now = Date.now();
    const last = Number(ctx.storage.get('unicom_captureDiagNotifyAt') || 0);
    if (now - last < 60000) return;
    ctx.storage.set('unicom_captureDiagNotifyAt', String(now));
    ctx.notify({
      title: '中国联通捕获诊断',
      body: '请求脚本已触发；Cookie：' + (cookie ? '已获取' : '缺失') +
        '；手机号参数：' + (phone ? '已获取' : '缺失') +
        '；状态：' + status,
      sound: false,
    });
  };

  if (!cookie || !phone) {
    captureDebug('incomplete: cookiePresent=' + Boolean(cookie) + '; phoneParamPresent=' + Boolean(phone));
    if (planLike) notifyDiagnostic('凭据不完整');
  } else {
    captureDebug('unchanged: credentials already match stored values');
    if (planLike) notifyDiagnostic('凭据未变化');
  }
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '刚刚';
  if (totalMin < 60) return totalMin + '分';
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (hours < 24) return hours + '小时' + (remMin > 0 ? remMin + '分' : '');
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return days + '天' + (remHours > 0 ? remHours + '小时' : '');
}

// 数据新旧的自然描述（用于「缓存 X 前」），与凭据保持的紧凑格式分开
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + '分钟';
  const hours = Math.floor(min / 60);
  const restMin = min % 60;
  if (hours < 24) return hours + '小时' + (restMin > 0 ? restMin + '分' : '');
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return days + '天' + (restHours > 0 ? restHours + '小时' : '');
}

// 凭据保持时间：App 抓取的 captureTime 优先，只抓过小程序时用 miniTime 兜底
function captureTsOf(ctx) {
  return Number(ctx.storage.get('unicom_captureTime') || ctx.storage.get('unicom_miniTime') || 0);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function saveHistory(ctx, flow, fallback) {
  try {
    const stored = ctx.storage.getJSON(KEY + '.history');
    const old = Array.isArray(stored) && stored.length ? stored : (Array.isArray(fallback) ? fallback : []);
    if (flow == null || flow === '') return old;
    const n = Number(flow);
    if (!Number.isFinite(n)) return old;

    const now = Date.now();
    const next = old.filter(x => now - Number(x.ts) < 7 * 86400000);
    const last = next[next.length - 1];
    if (!last || now - Number(last.ts) >= 25 * 60 * 1000 || Number(last.flowKB) !== n) {
      next.push({ ts: now, flowKB: n });
    }
    const trimmed = next.slice(-HISTORY_LIMIT);
    if (JSON.stringify(trimmed) !== JSON.stringify(old)) {
      ctx.storage.setJSON(KEY + '.history', trimmed);
    }
    return trimmed;
  } catch (e) {
    return [];
  }
}


function calcPlanPercent(total, used, remain) {
  const t = Number(total), u = Number(used), r = Number(remain);
  if (Number.isFinite(t) && t > 0 && Number.isFinite(u) && u >= 0) return Math.max(0, Math.min(1, u / t));
  if (Number.isFinite(t) && t > 0 && Number.isFinite(r) && r >= 0) return Math.max(0, Math.min(1, 1 - r / t));
  return null;
}
function formatFlow(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { number: '--', unit: 'GB' };
  if (n >= 1024 * 1024) return { number: (n / (1024 * 1024)).toFixed(2), unit: 'GB' };
  if (n >= 1024) return { number: (n / 1024).toFixed(2), unit: 'MB' };
  if (n >= 1) return { number: n.toFixed(2), unit: 'KB' };
  return { number: (n * 1024).toFixed(2), unit: 'B' };
}
function formatVoice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(0) : '--';
}

/* 联通数据加载：保留联通 API，并增加历史趋势与广电组件同款数据结构 */
function numericResourceValue(resource, keys) {
  if (!resource || typeof resource !== 'object') return null;
  for (const key of keys) {
    const v = resource[key];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
// App 接口与小程序接口返回同样的 feeResource/flowResource/voiceResource，
// 这里统一换算成小组件使用的数据结构。
function buildDataSource(ctx, parsed, raw, captureDuration) {
  const flowResource = raw.flowResource || {};
  const voiceResource = raw.voiceResource || {};
  const flowTotalRaw = numericResourceValue(flowResource, ['flowTotal', 'flowAll', 'totalFlow', 'total', 'totalValue', 'resourceTotal', 'sumValue']);
  const flowUsedRaw = numericResourceValue(flowResource, ['flowUsed', 'flowUserd', 'usedFlow', 'used', 'usedValue', 'consumeValue', 'usedResource']);
  const voiceTotal = numericResourceValue(voiceResource, ['voiceTotal', 'voiceAll', 'totalVoice', 'total', 'totalValue', 'resourceTotal', 'sumValue']);
  const voiceUsed = numericResourceValue(voiceResource, ['voiceUsed', 'usedVoice', 'voiceUserd', 'used', 'usedValue', 'consumeValue', 'usedResource']);

  const unit = String(parsed.flow.unit || 'MB').toUpperCase();
  const flowToKB = n => {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    if (unit === 'GB') return v * 1024 * 1024;
    if (unit === 'KB') return v;
    if (unit === 'B') return v / 1024;
    return v * 1024;
  };
  const remainKB = flowToKB(parsed.flow.value);
  const totalKB = flowTotalRaw == null ? null : flowToKB(flowTotalRaw);
  const usedKB = flowUsedRaw == null ? null : flowToKB(flowUsedRaw);
  const history = saveHistory(ctx, remainKB);
  const flowDisplay = formatFlow(remainKB);
  const ds = {
    stale: false,
    fee: { title: '剩余话费', number: Number(parsed.fee.value).toFixed(2), unit: '元' },
    flow: { title: '剩余流量', number: flowDisplay.number, unit: flowDisplay.unit },
    voice: { title: '剩余语音', number: String(parsed.voice.value), unit: parsed.voice.unit || '分钟' },
    updatedAt: Date.now(),
    captureDuration: captureDuration || '',
    history,
    plan: {
      total: totalKB, used: usedKB, remain: remainKB,
      percent: calcPlanPercent(totalKB, usedKB, remainKB),
      totalPath: flowTotalRaw == null ? null : 'flowResource',
      usedPath: flowUsedRaw == null ? null : 'flowResource',
      voiceTotal, voiceUsed, voiceRemain: Number(parsed.voice.value),
      voicePercent: calcPlanPercent(voiceTotal, voiceUsed, Number(parsed.voice.value)),
    },
  };
  return { ds, flowDisplay };
}

async function loadData(ctx) {
  const captureDisabled = !!(ctx.env && String(ctx.env.cuCapture).toLowerCase() === 'false');
  // 诊断日志：模块参数 cuDebug=true 时输出接口结构与关键字段，方便排查字段变化
  const debug = String((ctx.env && ctx.env.cuDebug) || '').toLowerCase() === 'true';
  const debugLog = (...args) => { if (debug) console.log(...args); };
  const readCache = () => {
    const cached = ctx.storage.getJSON('unicom_datasource') || null;
    if (!cached) return null;
    cached.stale = true;
    // 连续两次鉴权失败才提示，避免接口偶发异常时误报。
    cached.authFailed = Number(ctx.storage.get('unicom_authFail') || 0) >= 2;
    const ts = captureTsOf(ctx);
    // 冻结在数据生成时刻：数据过期后「凭据保持」不再随时间增长
    cached.captureDuration = ts > 0 ? formatDuration(Math.max(0, Number(cached.updatedAt || Date.now()) - ts)) : '';
    return cached;
  };

  if (captureDisabled) {
    const cached = readCache();
    return { data: cached, configured: !!cached, error: null, fromCache: true };
  }

  // 手动刷新识别：60 秒内再次渲染（下拉/点按刷新）且上一次渲染没有真正请求时，绕过缓存查询一次
  const lastRenderAt = Number(ctx.storage.get('unicom_lastRenderAt') || 0);
  const lastFetchAt = Number(ctx.storage.get('unicom_lastFetchAt') || 0);
  const lastRenderFetched = ctx.storage.get('unicom_lastRenderFetched') === '1';
  const manualRefresh = lastRenderAt > 0 && Date.now() - lastRenderAt < 60000
    && !lastRenderFetched && Date.now() - lastFetchAt > 5000;
  ctx.storage.set('unicom_lastRenderAt', String(Date.now()));
  ctx.storage.set('unicom_lastRenderFetched', '0');

  // 主屏 / 锁屏 / 画廊可能在同一轮里各自渲染一次，45 秒内复用同一份数据，避免重复打接口被风控。
  const fresh = ctx.storage.getJSON('unicom_datasource') || null;
  if (!manualRefresh && fresh && Number(fresh.updatedAt || 0) > 0 && Date.now() - Number(fresh.updatedAt) < 45000) {
    const ts = captureTsOf(ctx);
    fresh.captureDuration = ts > 0 ? formatDuration(Math.max(0, Number(fresh.updatedAt || Date.now()) - ts)) : '';
    return { data: fresh, configured: true, error: null, fromCache: false };
  }

  const captureTs = captureTsOf(ctx);
  const captureDuration = captureTs > 0 ? formatDuration(Date.now() - captureTs) : '';
  const cookie = ctx.storage.get('unicom_cookie') || '';
  const phone = ctx.storage.get('unicom_phone') || '';
  if (!cookie || !phone) {
    // 只做过微信小程序抓取（没有 App 凭据）时，直接用已缓存的小程序数据。
    const cached = readCache();
    if (cached) return { data: cached, configured: true, error: null, fromCache: true };
    return { data: null, configured: false, error: null, fromCache: false };
  }

  try {
    ctx.storage.set('unicom_lastFetchAt', String(Date.now()));
    ctx.storage.set('unicom_lastRenderFetched', '1');
    const raw = await fetchUnicomData(ctx, cookie, phone);
    const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 20).join(',') : String(o));
    debugLog(
      '[ChinaUnicom] API响应诊断: code=' + String(raw && raw.code) +
      ' | topKeys=' + keysOf(raw) +
      ' | feeKeys=' + keysOf(raw && raw.feeResource) +
      ' | flowKeys=' + keysOf(raw && raw.flowResource) +
      ' | voiceKeys=' + keysOf(raw && raw.voiceResource)
    );
    const parsed = parseUnicomData(raw);
    debugLog(
      '[ChinaUnicom] 套餐字段探测: fee=' + (parsed.fee && parsed.fee.number) + (parsed.fee && parsed.fee.unit) +
      ' | flow=' + (parsed.flow && parsed.flow.number) + (parsed.flow && parsed.flow.unit) +
      ' | voice=' + (parsed.voice && parsed.voice.number) + (parsed.voice && parsed.voice.unit) +
      ' | plan=' + JSON.stringify(parsed.plan || null)
    );
    const { ds, flowDisplay } = buildDataSource(ctx, parsed, raw, captureDuration);
    ctx.storage.setJSON('unicom_datasource', ds);
    ctx.storage.delete('unicom_authFail');
    // 流量明细（通用/定向分项）：15 分钟内不重复拉，失败静默降级
    try {
      const prevDetail = ctx.storage.getJSON('unicom_flowdetail');
      if (!prevDetail || !prevDetail.ts || Date.now() - Number(prevDetail.ts) > 15 * 60 * 1000) {
        ctx.storage.setJSON('unicom_flowdetail', await fetchFlowDetail(ctx, cookie));
      }
    } catch (e) {
      console.log('[ChinaUnicom] 流量明细获取失败: ' + String((e && e.message) || e));
    }
    const captureTime = String(ctx.storage.get('unicom_captureTime') || '');
    const notifiedCaptureTime = String(ctx.storage.get('unicom_notifiedCaptureTime') || '');
    if (captureTime && captureTime !== notifiedCaptureTime) {
      if ((!ctx.env || String(ctx.env.cuPlanNotice).toLowerCase() !== 'false') && typeof ctx.notify === 'function') {
        ctx.notify({
          title: '中国联通套餐查询成功',
          body: [
            '剩余话费：¥' + ds.fee.number,
            '剩余流量：' + flowDisplay.number + ' ' + flowDisplay.unit,
            '剩余语音：' + ds.voice.number + ' 分钟',
          ].join('\n'),
          sound: false,
        });
      }
      ctx.storage.set('unicom_notifiedCaptureTime', captureTime);
    }
    return { data: ds, configured: true, error: null, fromCache: false };
  } catch (e) {
    if (e && e.kind === 'auth') {
      ctx.storage.set('unicom_authFail', String(Number(ctx.storage.get('unicom_authFail') || 0) + 1));
    }
    return { data: readCache(), configured: true, error: e, fromCache: true };
  }
}
/* =========================================================
 * 微信小程序响应解析
 *
 * 小程序首页会把话费/流量/语音一次性拉下来：
 *   POST https://mina.10010.com/wxapplet/weixinNew/sspbigball
 *   -> {"code":"0000","data":{"feeResource":{...},"flowResource":{...},"voiceResource":{...}}}
 * 字段与 App 端同名（*Persent / newUnit / dynamic*Title），所以直接复用解析逻辑。
 * 这里只做被动解析：不重放请求，不需要 RSA 加密和 openid。
 * ========================================================= */
async function handleMiniResponse(ctx) {
  if (ctx.env && String(ctx.env.cuMiniCapture).toLowerCase() === 'false') return;

  const reqUrl = String((ctx.request && ctx.request.url) || '');
  // mina：小程序自有接口；mxx：小程序里的「余量查询」webview（字段最全）。
  if (!reqUrl.includes(MINI_API_PATH) && !reqUrl.includes('mxx.client.10010.com')) return;

  const res = ctx.response || {};
  if (Number(res.status) !== 200) return;

  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    return;
  }
  if (!body || String(body.code) !== '0000') return;

  // 小程序有些接口把字段放在响应根层（没有 data 包装），两种都要兼容。
  const data = body.data && typeof body.data === 'object' ? body.data : body;

  // ① 账户余额接口：curntbalancecust / canusefeecust
  if (body.curntbalancecust != null || body.canusefeecust != null) {
    try {
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      ctx.storage.setJSON('unicom_account', {
        ts: Date.now(),
        balance: num(body.curntbalancecust),
        available: num(body.canusefeecust ?? body.canuseprecust),
        monthCost: num(body.realfeecust ?? body.totalrealfee ?? body.allbillfee),
        carryOver: num(body.carryForwardFromLastMonth ?? body.newCarryForwardFromLastMonth ?? body.carryOverArrears),
        owed: num(body.allbowefeecust),
        queryTime: body.queryTime ? String(body.queryTime) : '',
        path: reqUrl.split('?')[0],
      });
      captureDebug('account captured: balance=' + body.curntbalancecust);
    } catch (e) {
      captureDebug('account parse failed: ' + e);
    }
    return;
  }

  // ② 余量查询接口：packageName + resources（flow/voice/sms）+ flowSumList
  if (body.packageName && Array.isArray(body.resources)) {
    try {
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const pick = (type) => body.resources.find(r => String(r && r.type).toLowerCase() === type) || null;
      const flow = pick('flow') || {};
      const voice = pick('voice') || {};
      const sms = pick('smslist') || {};
      const detail = (Array.isArray(flow.details) && flow.details[0]) || {};
      const parsed = parseDetailFlow(body);

      ctx.storage.setJSON('unicom_flowdetail', Object.assign(parsed, { path: reqUrl.split('?')[0] }));
      captureDebug('flow detail captured: pkg=' + body.packageName + '; remainMB=' + remainMB);
    } catch (e) {
      captureDebug('flow detail parse failed: ' + e);
    }
    return;
  }

  if (!data || typeof data !== 'object') return;

  if (reqUrl.indexOf(MINI_SSP_BIGBALL) === 0 && data.feeResource && data.flowResource && data.voiceResource) {
    try {
      const parsed = parseUnicomData({
        code: 'Y',
        feeResource: data.feeResource,
        voiceResource: data.voiceResource,
        flowResource: data.flowResource,
      });
      // buildDataSource 用的是原始资源对象里的 total/used 字段，小程序同样有。
      if (String((ctx.env && ctx.env.cuDebug) || '').toLowerCase() === 'true') {
        console.log(
          '[ChinaUnicom] 小程序响应诊断: keys=' + Object.keys(data).slice(0, 20).join(',') +
          ' | fee=' + JSON.stringify(data.feeResource || null) +
          ' | flow=' + JSON.stringify(data.flowResource || null) +
          ' | voice=' + JSON.stringify(data.voiceResource || null)
        );
      }
      const { ds, flowDisplay } = buildDataSource(ctx, parsed, data, '');
      ds.source = 'mini';
      ctx.storage.setJSON('unicom_datasource', ds);
      ctx.storage.set('unicom_miniTime', String(Date.now()));
      ctx.storage.delete('unicom_authFail');
      if ((!ctx.env || String(ctx.env.cuCaptureNotice).toLowerCase() !== 'false') &&
          typeof ctx.notify === 'function') {
        ctx.notify({
          title: '中国联通小程序数据已捕获',
          body: [
            '剩余话费：¥' + ds.fee.number,
            '剩余流量：' + flowDisplay.number + ' ' + flowDisplay.unit,
            '剩余语音：' + ds.voice.number + ' 分钟',
          ].join('\n'),
          sound: false,
        });
      }
    } catch (e) {
      captureDebug('mini parse failed: ' + e);
    }
    return;
  }

  // 顺手保存手机号，方便诊断时区分账号（不参与取数）
  if (reqUrl.includes('queryGoodsList')) {
    try {
      const rows = data.res || [];
      const main = rows[0] && rows[0].mainNumber;
      if (main) ctx.storage.set('unicom_phone', String(main));
    } catch (e) {}
    return;
  }

  // 账户总览：可用话费 / 本月消费 / 欠费 / 结转（暂只存档，供后续展示）
  if (reqUrl.includes('sspbalcbroadcast')) {
    try {
      const rows = data.res || data || [];
      const first = Array.isArray(rows) ? rows[0] : rows;
      if (first && typeof first === 'object') {
        ctx.storage.setJSON('unicom_account', {
          ts: Date.now(),
          available: Number(first.CANUSE_FEE_CUST),
          monthCost: Number(first.REAL_FEE_CUST),
          owed: Number(first.ALLBOWE_FEE),
          carryOver: Number(first.CARRY_INFO_ALL_FEE),
        });
      }
    } catch (e) {}
  }
}

/* ==================== Surge 面板渲染（替代原 Widget DSL / SVG 渲染层） ==================== */

function panelDone(title, content) {
  $done({ title, content, icon: 'antenna.radiowaves.left.and.right', 'icon-color': '#E60012' });
}

// 面板模式：分支与提示文案与原 handleWidget 一致，数据组装（账户/明细合并、开关口径）
// 照原版，呈现换成多行文字
async function handleWidget(ctx) {
  const title = '中国联通';
  const result = await loadData(ctx);
  if (!result.configured) {
    panelDone(title, '⚠ 请打开微信中国联通小程序，进入流量查询页面刷新一次，或打开联通 App 查询');
    return;
  }
  if (!result.data) {
    panelDone(title, '⚠ ' + (result.error && result.error.kind === 'auth'
      ? '登录状态已失效，请重新打开中国联通 App 或微信小程序查询一次，让组件重新抓取凭据'
      : '数据获取失败，请刷新微信联通小程序流量查询或打开联通 App 重试'));
    return;
  }
  const ds = result.data;
  // 通用/定向显示开关（与参考模块 CU_SHOW_GENERAL_FLOW / CU_SHOW_DIRECTIONAL_FLOW 对应）
  const showGeneral = !(ctx.env && String(ctx.env.cuGeneralFlow).toLowerCase() === 'false');
  const showDirectional = !(ctx.env && String(ctx.env.cuDirectionalFlow).toLowerCase() === 'false');

  // 账户余额 / 余量明细单独缓存（比大球数据更精确），渲染时实时读取。
  ds.account = ctx.storage.getJSON('unicom_account') || null;
  const fd = ctx.storage.getJSON('unicom_flowdetail') || null;
  // 余量明细是快照：超过 6 小时回落到首页大球数据，避免旧数据盖住新数据。
  const fdFresh = Boolean(fd) && Boolean(fd.ts) && Date.now() - Number(fd.ts) < 6 * 60 * 60 * 1000;
  if (fd && fdFresh) {
    const toKB = (mb) => (mb == null ? null : Math.round(Number(mb) * 1024));
    const g = fd.general || null;
    const d = fd.directional || null;
    // 两个开关控制「哪些流量参与统计」：默认通用 + 定向一起算
    const incG = showGeneral ? g : null;
    const incD = showDirectional ? d : null;
    const sumRemainMB = (incG && incG.remainMB != null ? incG.remainMB : 0) + (incD && incD.remainMB != null ? incD.remainMB : 0);
    const sumUsedMB = (incG && incG.usedMB != null ? incG.usedMB : 0) + (incD && incD.usedMB != null ? incD.usedMB : 0);
    const sumTotalMB = (incG && incG.totalMB != null ? incG.totalMB : 0) + (incD && incD.totalMB != null ? incD.totalMB : 0);
    const hasSum = Boolean(incG || incD);

    const remainKB = hasSum ? toKB(sumRemainMB) : toKB(fd.remainMB);
    const display = formatFlow(remainKB);
    const flowLabel = hasSum ? (incG && incD ? '流量' : (incD ? '定向流量' : '通用流量')) : '通用流量';
    ds.flow = { title: flowLabel, number: display.number, unit: display.unit };
    ds.plan = Object.assign({}, ds.plan, {
      remain: remainKB,
      total: hasSum ? (sumTotalMB > 0 ? toKB(sumTotalMB) : null) : toKB(fd.totalMB),
      used: hasSum ? toKB(sumUsedMB) : toKB(fd.usedMB),
      percent: hasSum && sumTotalMB > 0
        ? Math.min(1, sumUsedMB / sumTotalMB)
        : (fd.percent != null ? fd.percent : (ds.plan ? ds.plan.percent : null)),
    });
    if (fd.voiceRemain != null) ds.voice = { title: '剩余语音', number: String(fd.voiceRemain), unit: '分钟' };
    if (fd.smsRemain != null) ds.smsRemain = fd.smsRemain;
    ds.packageName = fd.packageName;
    ds.otherUsedMB = fd.otherUsedMB;
    ds.detailTime = fd.time;
    // 定向流量单独展示（关闭「显示定向流量」时连这一行也不出现）
    if (d && d.totalMB && d.remainMB != null) {
      ds.directionalPct = Math.max(0, Math.min(1, d.remainMB / d.totalMB));
    }
    if (d && showDirectional && (d.usedMB != null || d.remainMB != null || d.totalMB != null)) {
      ds.directional = {
        used: d.usedMB != null ? formatFlow(toKB(d.usedMB)) : null,
        remain: d.remainMB != null ? formatFlow(toKB(d.remainMB)) : null,
        total: d.totalMB ? formatFlow(toKB(d.totalMB)) : null,
      };
    }
  }
  // 有账户余额时，话费数字用「账户当前可用余额」，比大球口径更准。
  if (ds.account && ds.account.balance != null) {
    ds.fee = { title: '账户余额', number: Number(ds.account.balance).toFixed(2), unit: '元' };
  }

  // 渲染时也补一个采样点（saveHistory 内部 25 分钟去重）：命中小程序/本地缓存
  // 或没有 App 凭据时不会走网络请求，若不在这里记录，「今日流量」就永远停在旧值。
  try {
    const remainForHistory = ds.plan && ds.plan.remain != null ? ds.plan.remain : null;
    if (remainForHistory != null) {
      const hist = saveHistory(ctx, remainForHistory, Array.isArray(ds.history) ? ds.history : []);
      if (Array.isArray(hist)) ds.history = hist;
    }
  } catch (e) {
    // 采样失败不影响渲染
  }

  const lines = [];
  const pctText = (p) => (p == null || !Number.isFinite(Number(p)) ? '' : ` · 已用 ${Math.round(Number(p) * 100)}%`);

  // 话费 / 账户余额（有账户余额时 ds.fee 已在组装阶段替换为账户口径）
  lines.push(`${ds.fee.title} ¥${ds.fee.number}`);

  // 流量（统计口径由 cuGeneralFlow / cuDirectionalFlow 决定，见组装阶段）
  let flowLine = `${ds.flow.title} ${ds.flow.number} ${ds.flow.unit}`;
  if (ds.plan && ds.plan.total) {
    const ft = formatFlow(ds.plan.total);
    flowLine += ` / ${ft.number} ${ft.unit}`;
  }
  if (ds.plan) flowLine += pctText(ds.plan.percent);
  lines.push(flowLine);

  // 定向流量单独一行（仅 cuDirectionalFlow 开启且明细新鲜时 ds.directional 才存在）
  if (ds.directional && ds.directional.remain) {
    let dLine = `定向流量 剩余 ${ds.directional.remain.number} ${ds.directional.remain.unit}`;
    if (ds.directional.total) dLine += ` / ${ds.directional.total.number} ${ds.directional.total.unit}`;
    if (ds.directionalPct != null) dLine += ` · 剩余 ${Math.round(ds.directionalPct * 100)}%`;
    lines.push(dLine);
  }

  // 语音
  let voiceLine = `${ds.voice.title} ${ds.voice.number} ${ds.voice.unit}`;
  if (ds.plan) voiceLine += pctText(ds.plan.voicePercent);
  lines.push(voiceLine);

  // 短信（明细里有才显示）
  if (ds.smsRemain != null) lines.push(`剩余短信 ${ds.smsRemain} 条`);

  // 账户行：本月消费 / 结转 / 欠费（小程序账户接口抓到才有）
  if (ds.account) {
    const parts = [];
    if (ds.account.monthCost != null) parts.push(`本月消费 ¥${Number(ds.account.monthCost).toFixed(2)}`);
    if (ds.account.carryOver != null) parts.push(`结转 ¥${Number(ds.account.carryOver).toFixed(2)}`);
    if (ds.account.owed != null && Number(ds.account.owed) > 0) parts.push(`欠费 ¥${Number(ds.account.owed).toFixed(2)}`);
    if (parts.length) lines.push(parts.join(' · '));
  }

  // 更新时间（缓存回退时标注；连续鉴权失败时提示登录可能失效）
  lines.push(`${result.fromCache ? '缓存 · ' : ''}更新 ${ds.updatedAt ? fmtTime(ds.updatedAt) : '--'}${ds.authFailed ? ' · 登录可能已失效' : ''}`);

  panelDone(title, lines.join('\n'));
}

/* ==================== 保活（cron）：静默跑一次查询链，保持会话活跃 ==================== */

async function handleKeepAlive(ctx) {
  // 保活不发「套餐查询成功」通知：临时关掉 cuPlanNotice 后走原版 loadData 查询链；
  // 没抓过登录信息时 loadData 直接返回未配置，安静结束；捕获逻辑不在此触发。
  const quietCtx = Object.assign({}, ctx, {
    env: Object.assign({}, ctx.env, { cuPlanNotice: 'false' }),
  });
  try { await loadData(quietCtx); } catch (e) { /* 保活失败安静结束，不通知 */ }
}

/* ==================== 入口：按 Surge 全局变量分发四模式 ==================== */

(async () => {
  const ctx = buildCtx();
  // 有 $response → 小程序响应解析（http-response 脚本同时带 $request，优先按响应处理）
  if (ctx.response) {
    try { await handleMiniResponse(ctx); } catch (e) { /* 解析出错也必须放行原响应 */ }
    $done({});
    return;
  }
  // 有 $request → App 请求捕获
  if (ctx.request && ctx.request.url) {
    try { await handleCapture(ctx); } catch (e) { /* 捕获出错也必须放行原请求 */ }
    $done({});
    return;
  }
  // 无 $request + CU_KEEPALIVE=true → cron 保活
  if (ctx.env && ctx.env.CU_KEEPALIVE === 'true') {
    try { await handleKeepAlive(ctx); } catch (e) {}
    $done();
    return;
  }
  // 其余 → 面板
  try {
    await handleWidget(ctx);
  } catch (e) {
    panelDone('中国联通', `⚠ 查询失败：${String((e && e.message) || e).slice(0, 80)}`);
  }
})();
