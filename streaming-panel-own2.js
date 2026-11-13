// ============================================================
// 流媒体解锁（自制版）· Surge 面板
//
// 10 个平台并行实测：YouTube、Netflix、Disney+、Prime Video、HBO Max、
// Spotify、ChatGPT、Claude、Gemini、Grok。
// 判定用各家状态码 / 跳转 / 页面地区信号；地区显示对方实际看到的出口
// 归属（能从服务自身响应里读到的用它自己的，其余用出口 IP 归属地）。
// 排版为图标打头对齐格式。
//
// 参数（模块里填）：策略组
//   「跟随规则」= 按 Surge 分流规则发请求（App 实际吃到的结果）
//   填策略组名或节点名 = 全部请求钉在那个出口上测
// ============================================================

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ARG = (typeof $argument === 'string' ? $argument : '').trim();
const POLICY = (ARG && ARG !== '跟随规则') ? ARG : '';

function flag(cc) {
  if (!cc || cc === 'XX') return '🌐';
  return cc.toUpperCase().replace(/./g, c => String.fromCodePoint(c.charCodeAt(0) + 127397));
}

function get(url, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const req = { url, headers: { 'User-Agent': UA }, timeout: timeout || 10 };
    if (POLICY) req.policy = POLICY;
    $httpClient.get(req, (error, response, data) => {
      const ms = Date.now() - start;
      if (error || !response) return resolve({ error: true, ms });
      resolve({ status: response.status, headers: response.headers || {}, body: data || '', ms });
    });
  });
}

// st: ok 已解锁 / blocked 地区限制 / err 服务不可用
function verdict(r, okStatus, blockedStatus, regionFromBody) {
  if (r.error) return { st: 'err', ms: r.ms };
  if (blockedStatus && blockedStatus.indexOf(r.status) >= 0) return { st: 'blocked', ms: r.ms };
  if (okStatus.indexOf(r.status) >= 0) {
    const v = { st: 'ok', ms: r.ms };
    if (regionFromBody) { const cc = regionFromBody(r.body); if (cc) v.region = cc; }
    return v;
  }
  return { st: 'err', ms: r.ms };
}

const checks = [
  { name: 'YouTube', group: 'media', run: async () => {
      const r = await get('https://www.youtube.com/premium');
      if (r.error) return { st: 'err', ms: r.ms };
      if (/not available in your country/i.test(r.body)) return { st: 'blocked', ms: r.ms };
      const m = /"countryCode":"([A-Z]{2})"/.exec(r.body);
      if (r.status === 200) return { st: 'ok', region: m ? m[1] : null, ms: r.ms };
      return { st: 'err', ms: r.ms };
  }},
  { name: 'Netflix', group: 'media', run: async () => {
      const r = await get('https://www.netflix.com/title/81280792');
      return verdict(r, [200], [404, 403]);
  }},
  { name: 'Disney+', group: 'media', run: async () => {
      const r = await get('https://www.disneyplus.com/');
      return verdict(r, [200], [403], b => { const m = /"location":"([A-Z]{2})"/.exec(b); return m && m[1]; });
  }},
  { name: 'Prime Video', group: 'media', run: async () => {
      const r = await get('https://www.primevideo.com/');
      return verdict(r, [200], [403], b => { const m = /"currentTerritory":"([A-Z]{2})"/.exec(b); return m && m[1]; });
  }},
  { name: 'HBO Max', group: 'media', run: async () => {
      const r = await get('https://www.max.com/');
      return verdict(r, [200], [403]);
  }},
  { name: 'Spotify', group: 'media', run: async () => {
      const r = await get('https://open.spotify.com/');
      return verdict(r, [200], [403]);
  }},
  { name: 'ChatGPT', group: 'ai', run: async (ctx) => {
      const r = await get('https://chatgpt.com/');
      const v = verdict(r, [200], [403, 429]);
      if (v.st === 'ok' && ctx.exitCC) v.region = ctx.exitCC;
      return v;
  }},
  { name: 'Claude', group: 'ai', run: async () => {
      // claude.ai 网页有 Cloudflare 人机墙（403 与地区无关），改测官方 API：
      // 401 = 地区可用（走到了要密钥这一步）；403 = 地区受限
      const r = await get('https://api.anthropic.com/v1/models');
      return verdict(r, [401], [403]);
  }},
  { name: 'Gemini', group: 'ai', run: async (ctx) => {
      const r = await get('https://gemini.google.com/app?hl=en');
      if (r.error) return { st: 'err', ms: r.ms };
      if (r.status === 403) return { st: 'blocked', ms: r.ms };
      if (r.status === 200) {
        if (/Gemini is not available|not currently available|isn'?t available|not available in your (country|region)/i.test(r.body)) return { st: 'blocked', ms: r.ms };
        // 页面没明说时按官方未开放地区兜底（Gemini 网页版不对这些地区开放，
        // 但页面外壳照样返回 200，光看状态码会误报已解锁）
        const UNSUPPORTED = ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU'];
        if (ctx.exitCC && UNSUPPORTED.indexOf(ctx.exitCC) >= 0) return { st: 'blocked', ms: r.ms };
        return { st: 'ok', ms: r.ms };
      }
      return { st: 'err', ms: r.ms };
  }},
  { name: 'Grok', group: 'ai', run: async () => {
      const r = await get('https://grok.com/');
      return verdict(r, [200], [403]);
  }},
];

async function fetchExit() {
  const r = await get('https://chatgpt.com/cdn-cgi/trace', 6);
  if (!r.error && r.status === 200) {
    const m = /^loc=([A-Z]{2})$/m.exec(r.body);
    if (m) return m[1];
  }
  const r2 = await get('http://ip-api.com/json/?fields=countryCode', 6);
  if (!r2.error && r2.status === 200) {
    try { const j = JSON.parse(r2.body); if (j.countryCode) return j.countryCode; } catch (e) {}
  }
  return null;
}

(async () => {
  const exitCC = await fetchExit();
  const ctx = { exitCC };
  const results = await Promise.all(checks.map(c => c.run(ctx).then(v => ({ name: c.name, group: c.group, ...v }))));
  for (const r of results) if (r.st === 'ok' && !r.region && exitCC) r.region = exitCC;

  const okCount = results.filter(r => r.st === 'ok').length;
  const errCount = results.filter(r => r.st === 'err').length;
  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const time = p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds());

  const CONCLUSION = { ok: '✅ 已解锁', blocked: '❌ 地区限制', err: '⚠️ 服务不可用' };
  function line(r) {
    const head = { ok: '✅ 已解锁　　　', blocked: '❌ 地区限制　　', err: '⚠️ 服务不可用' }[r.st];
    let s = head + ' ' + r.name;
    if (r.st === 'ok') s += ' ' + flag(r.region);
    else if (r.st === 'blocked' && r.region) s += ' ' + flag(r.region);
    return s;
  }

  const L = [];
  L.push('◆ ' + (POLICY || '跟随规则'));
  L.push('📊 解锁率 ' + okCount + '/' + results.length + ' 已解锁' + (exitCC ? ' · 出口 ' + flag(exitCC) + ' ' + exitCC : ''));
  L.push('');
  L.push('📺 影音平台');
  for (const r of results.filter(x => x.group === 'media')) L.push(line(r));
  L.push('');
  L.push('🤖 AI 平台');
  for (const r of results.filter(x => x.group === 'ai')) L.push(line(r));
  L.push('');
  L.push('🕒 检测时间：' + time);

  $done({
    title: '流媒体解锁',
    content: L.join('\n'),
    icon: errCount ? 'exclamationmark.triangle.fill' : 'play.tv.fill',
    'icon-color': errCount ? '#F59E0B' : '#22C55E'
  });
})();
