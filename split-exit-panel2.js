// ============================================================
// 分流出口检测 · Surge 面板（自制）v2
//
// 两部分：
//  1) 分站出口：对 Cloudflare 托管的目标站请求它自己的 /cdn-cgi/trace，
//     响应里的 ip= 就是该站按现行分流规则实际走的出口 IP，
//     再用 ipwho.is 给这个 IP 补归属地 / 运营商。
//  2) 分组出口：用 $httpClient 的 policy 参数把 ipwho.is 查询钉到
//     指定策略组，看每组当前真实出口；DIRECT 一行是本机真实出口。
//
// 数据来源：Cloudflare Trace + ipwho.is。
// （ipfinal 的 API 挂了 Cloudflare 机器人防护，脚本客户端一律 403，
//   所以本面板不使用它的数据，只复刻「分站出口汇总」这个功能。）
//
// 参数（模块里填）：分组
//   策略组名用 | 分隔（#!arguments 里逗号是参数之间的分隔符，
//   默认值内不能用逗号），按顺序逐个强制探测；DIRECT 恒在第一行，
//   不用写进参数。组名写错的那一行会显示「探测失败」，不影响其他行。
// ============================================================

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const DEFAULT_GROUPS = ['Proxy', '🇭🇰Hong Kong', '🇯🇵Japan', '🇸🇬Singapore', '🇺🇸America', 'AIGC'];
const ARG = (typeof $argument === 'string' ? $argument : '').trim();
const GROUPS = (ARG && ARG !== '默认' ? ARG.split(/[,，|;；]/) : DEFAULT_GROUPS)
  .map(s => s.trim()).filter(Boolean);

// 能用 /cdn-cgi/trace 报出访客 IP 的站（Cloudflare 托管）
// discord.com 的 trace 返回 403，已剔除；其余失败只影响自己那一行
const SITES = [
  { name: 'ChatGPT',  host: 'chatgpt.com' },
  { name: 'Claude',   host: 'claude.ai' },
  { name: 'Binance',  host: 'www.binance.com' },
  { name: 'Spotify',  host: 'open.spotify.com' },
  { name: 'Cloudflare', host: 'www.cloudflare.com' }
];

function get(url, policy, timeout) {
  return new Promise(resolve => {
    const req = { url, headers: { 'User-Agent': UA }, timeout: timeout || 10 };
    if (policy) req.policy = policy;
    $httpClient.get(req, (error, response, data) => {
      if (error || !response) return resolve({ error: true });
      resolve({ status: response.status, body: data || '' });
    });
  });
}

function parseTrace(body) {
  const m = /(?:^|\n)ip=([^\n\r]+)/.exec(body || '');
  return m ? m[1].trim() : '';
}

function parseGeo(body) {
  try {
    const j = JSON.parse(body);
    if (!j || j.success === false || !j.ip) return null;
    const conn = j.connection || {};
    return {
      ip: j.ip,
      country: j.country || '',
      city: j.city || '',
      isp: conn.isp || conn.org || ''
    };
  } catch (e) { return null; }
}

function geoText(g) {
  if (!g) return '';
  const place = [g.country, g.city].filter(Boolean).join(' ');
  return place + (g.isp ? ' · ' + g.isp : '');
}

(async () => {
  // ---- 分组出口（含 DIRECT 真实出口）----
  const groupNames = ['DIRECT'].concat(GROUPS);
  const groupTask = Promise.all(groupNames.map(async name => {
    const r = await get('https://ipwho.is/', name, 10);
    if (r.error || r.status !== 200) return { name, fail: true };
    const g = parseGeo(r.body);
    return g ? { name, ip: g.ip, text: geoText(g) } : { name, fail: true };
  }));

  // ---- 分站出口 ----
  const siteTask = Promise.all(SITES.map(async s => {
    const r = await get('https://' + s.host + '/cdn-cgi/trace', '', 10);
    if (r.error || r.status !== 200) return { name: s.name, fail: true };
    const ip = parseTrace(r.body);
    return ip ? { name: s.name, ip } : { name: s.name, fail: true };
  }));

  const [groupRes, siteRes] = await Promise.all([groupTask, siteTask]);

  // ---- 给分站出口的 IP 补归属地（同一 IP 只查一次）----
  const uniq = [...new Set(siteRes.filter(x => x.ip).map(x => x.ip))];
  const geoMap = {};
  await Promise.all(uniq.map(async ip => {
    const r = await get('https://ipwho.is/' + encodeURIComponent(ip), '', 8);
    if (!r.error && r.status === 200) {
      const g = parseGeo(r.body);
      if (g) geoMap[ip] = geoText(g);
    }
  }));

  const p2 = n => String(n).padStart(2, '0');
  const now = new Date();
  const time = p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds());

  const L = [];
  L.push('— 分站出口（按现行规则）—');
  for (const s of siteRes) {
    if (s.fail) L.push(s.name + ' · 探测失败');
    else L.push(s.name + ' · ' + s.ip + (geoMap[s.ip] ? ' · ' + geoMap[s.ip] : ''));
  }
  L.push('');
  L.push('— 分组出口（强制指定）—');
  for (const g of groupRes) {
    const label = g.name === 'DIRECT' ? '真实出口 DIRECT' : g.name;
    if (g.fail) L.push(label + ' · 探测失败');
    else L.push(label + ' · ' + g.ip + (g.text ? ' · ' + g.text : ''));
  }
  L.push('');
  L.push('数据来源：Cloudflare Trace / ipwho.is');
  L.push('🕒 检测时间：' + time);

  $done({
    title: '分流出口',
    content: L.join('\n'),
    icon: 'network',
    'icon-color': '#0A84FF'
  });
})().catch(() => {
  $done({
    title: '分流出口',
    content: '探测出错，请稍后刷新重试。',
    icon: 'exclamationmark.triangle.fill',
    'icon-color': '#F59E0B'
  });
});
