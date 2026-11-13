/**
 * IP 纯净度（IPPure）· Surge 面板
 *
 * 跟 Egern 小组件（egern/scripts/IP_Purity_Widget.js）用同一套判断：
 *   纯净度  IPPure 接口的 fraudScore，按官网分六档：0–15 极度纯净，16–25 纯净，26–40 中性，
 *           41–50 轻度风险，51–70 中度风险，71–100 极度风险（分界值归前一档）。IPv6 不评分
 *   运营商  用 ASN 去 RIPEstat 查 AS 的持有者（跟官网 ASN 那一栏一致），按 ASN 缓存 30 天；
 *           查不到时用 IPPure 的 asOrganization
 *
 * 面板：标题写「分数% 档位名」，图标是官网那一档的颜色；内容一行一项：IP（标签写 IPv4 或 IPv6）、
 * 属性、来源、ASN、位置、运营商。面板只能显示文字，画不出色条。点面板可以手动刷新。
 *
 * 参数（模块里填）：
 *   Proxy   检测哪个策略组或节点的出口 IP；默认「跟随规则」，按 Surge 规则走
 *   MarkIP  IP 打码，默认 true
 */

const API_URL = 'https://my.ippure.com/v1/info';
const ASN_URL = 'https://stat.ripe.net/data/as-overview/data.json?resource=AS';
const TIMEOUT = 8; // 秒
const ASN_TIMEOUT = 4;
const ASN_TTL = 30 * 24 * 3600 * 1000; // 查到的持有者存 30 天
const ASN_RETRY = 3600 * 1000; // 没查到（超时、出错）1 小时后再试，免得每次刷新都多等几秒
const TITLE = 'IP 纯净度';
const ICON = 'shield.lefthalf.filled';
const GRAY = '#8E8E93';
const ERROR_COLOR = '#FF3B30';

// 官网色条的颜色（Tailwind 的 green-800、green-500、lime-500、yellow-500、orange-500、red-600），名称用官网全称
const BANDS = [
  { max: 15, name: '极度纯净', color: '#166534' },
  { max: 25, name: '纯净', color: '#22C55E' },
  { max: 40, name: '中性', color: '#84CC16' },
  { max: 50, name: '轻度风险', color: '#EAB308' },
  { max: 70, name: '中度风险', color: '#F97316' },
  { max: 100, name: '极度风险', color: '#DC2626' },
];

const COUNTRY_ZH = {
  HK: '香港', MO: '澳门', TW: '台湾', CN: '中国', JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚',
  TH: '泰国', VN: '越南', PH: '菲律宾', ID: '印尼', IN: '印度', AU: '澳大利亚', NZ: '新西兰', US: '美国',
  CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷', CL: '智利', GB: '英国', IE: '爱尔兰', DE: '德国',
  FR: '法国', NL: '荷兰', BE: '比利时', LU: '卢森堡', CH: '瑞士', AT: '奥地利', IT: '意大利', ES: '西班牙',
  PT: '葡萄牙', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', PL: '波兰', CZ: '捷克', RO: '罗马尼亚',
  BG: '保加利亚', HU: '匈牙利', GR: '希腊', UA: '乌克兰', TR: '土耳其', IL: '以色列', AE: '阿联酋',
  SA: '沙特', QA: '卡塔尔', ZA: '南非', EG: '埃及', NG: '尼日利亚', KZ: '哈萨克斯坦', RU: '俄罗斯',
  PK: '巴基斯坦', BD: '孟加拉',
};

class PanelError extends Error {
  constructor(title, hint) {
    super(title);
    this.title = title;
    this.hint = hint || '';
  }
}

// ───────────────────────────── 参数 ─────────────────────────────

// 模块传来的是「Proxy=…&MarkIP=…」。策略名里可能有 & 或 =，所以从后往前按参数名切。
// Surge 的模块参数不能没有默认值，Proxy 的默认值写「跟随规则」；它、空值和没被替换的 {{{Proxy}}} 都按 Surge 规则走
const FOLLOW_RULES = '跟随规则';

function readArgs(input) {
  const args = splitArgs(input, ['Proxy', 'MarkIP']);
  const proxy = clean(args.Proxy);
  const policy = proxy === FOLLOW_RULES ? '' : proxy;
  return {
    policy,
    markIP: !/^(false|0|no|off)$/i.test(clean(args.MarkIP)),
  };
}

function splitArgs(input, keys) {
  const out = {};
  let rest = String(input || '');
  for (let i = keys.length - 1; i >= 1; i--) {
    const marker = `&${keys[i]}=`;
    const at = rest.lastIndexOf(marker);
    if (at < 0) continue;
    out[keys[i]] = rest.slice(at + marker.length);
    rest = rest.slice(0, at);
  }
  const first = `${keys[0]}=`;
  out[keys[0]] = rest.startsWith(first) ? rest.slice(first.length) : rest;
  return out;
}

function clean(value) {
  const text = String(value || '').trim();
  return /^\{\{\{.*\}\}\}$/.test(text) ? '' : text;
}

// ───────────────────────────── 网络 ─────────────────────────────

function get(url, timeout, policy) {
  return new Promise(resolve => {
    const options = { url, timeout, headers: { Accept: 'application/json' }, 'auto-cookie': false };
    if (policy) options.policy = policy;
    $httpClient.get(options, (error, response, body) => {
      if (error) resolve({ error: String(error && error.message || error) });
      else resolve({ status: Number(response && (response.status || response.statusCode)) || 0, body: String(body || '') });
    });
  });
}

async function fetchInfo(cfg) {
  const res = await get(API_URL, TIMEOUT, cfg.policy);
  if (res.error) {
    const where = cfg.policy ? `检查策略「${cfg.policy}」是否可用。` : '检查网络和分流规则。';
    const title = /timed?\s*out|timeout/i.test(res.error) ? '连接 IPPure 超时' : '连不上 IPPure';
    throw new PanelError(title, `${where}${shorten(res.error, 60)}`);
  }
  if (res.status === 429) throw new PanelError('IPPure 请求太频繁', '稍后会自动重试，也可以把刷新间隔调大。');
  if (res.status === 403) {
    const node = cfg.policy ? `（当前策略「${cfg.policy}」）` : '';
    throw new PanelError('IPPure 拒绝了这次请求', `出口可能被它拦截，换个节点试试${node}。`);
  }
  if (res.status >= 400) throw new PanelError(`IPPure 出错，HTTP ${res.status}`, '稍后会自动重试。');
  const data = parseJSON(res.body);
  if (!data || typeof data !== 'object') throw new PanelError('IPPure 没返回数据', '接口可能在维护，稍后会自动重试。');
  if (!data.ip) throw new PanelError('IPPure 没返回 IP', '接口可能在维护，稍后会自动重试。');
  return data;
}

// 运营商：用 ASN 去 RIPEstat 查这个 AS 登记的持有者，官网 ASN 那一栏显示的就是它。
// IPPure 接口的 asOrganization 有时是这段 IP 的使用方（IIJ 分给 Stacks Inc. 的地址，接口给的是 Stacks Inc.）。
// 按 ASN 缓存：查到的存 30 天；没查到记下来，1 小时后再试，期间沿用上次查到的名称。从不抛错
async function asHolder(cfg, asn) {
  const num = Number(asn);
  if (!(num > 0)) return '';
  const key = `ippure_as_holder_${num}`;
  const now = Date.now();
  const cached = parseJSON(storageRead(key));
  const known = cached && typeof cached === 'object' ? String(cached.name || '') : '';
  if (cached && now - Number(cached.ts || 0) < (cached.failed ? ASN_RETRY : ASN_TTL)) return known;
  const res = await get(ASN_URL + num, ASN_TIMEOUT, cfg.policy);
  const holder = !res.error && res.status < 400 ? (parseJSON(res.body) || {}).data : null;
  if (!holder) {
    storageWrite(key, { name: known, ts: now, failed: true });
    return known;
  }
  const name = holderName(holder.holder);
  storageWrite(key, { name, ts: now });
  return name;
}

// RIPEstat 的 holder 多是「AS 名 + 持有者」：去掉前面的 AS 名，只留持有者；剩下的像地址就不要
function holderName(holder) {
  const text = String(holder || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const dash = text.indexOf(' - ');
  if (dash > 0) return text.slice(dash + 3).trim();
  const parts = text.match(/^([A-Z0-9][A-Z0-9_-]*) (.+)$/);
  const rest = parts ? parts[2] : '';
  const name = rest && (/[a-z]/.test(rest) || rest.toUpperCase().includes(parts[1])) ? rest : text;
  return /\d\s*,|^No\.?\s*\d/i.test(name) ? '' : name;
}

function storageRead(key) {
  try {
    return $persistentStore.read(key);
  } catch {
    return null;
  }
}

function storageWrite(key, value) {
  try {
    $persistentStore.write(JSON.stringify(value), key);
  } catch {
    // 存不了下次再查
  }
}

// ───────────────────────────── 数据 ─────────────────────────────

function buildModel(data, cfg, holder) {
  const ip = String(data.ip);
  const score = readScore(data.fraudScore);
  const code = String(data.countryCode || '').trim().toUpperCase();
  const country = COUNTRY_ZH[code] || String(data.country || code || '未知地区');
  const city = String(data.city || data.region || '').trim();
  const sameAsCountry = !city || [country, data.country, code].some(x => x && String(x).toLowerCase() === city.toLowerCase());
  return {
    shownIP: cfg.markIP ? maskIP(ip) : ip,
    isV6: ip.includes(':'),
    score,
    band: score === null ? null : BANDS.find(band => Math.round(score) <= band.max),
    flag: flagEmoji(code),
    country,
    city: sameAsCountry ? '' : city,
    asn: Number(data.asn) > 0 ? `AS${Number(data.asn)}` : '',
    org: holder || String(data.asOrganization || '').trim(),
    residential: readBool(data.isResidential),
    broadcast: readBool(data.isBroadcast),
  };
}

function readScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

function readBool(value) {
  if (value === true || value === 'true' || value === 1) return true;
  if (value === false || value === 'false' || value === 0) return false;
  return null;
}

// ───────────────────────────── 面板 ─────────────────────────────

// 「标签　值」一行。面板文字是比例字体，标签用全角空格（一个汉字宽）补到四个汉字宽，值就从同一位置开始：
// 两个字的标签补两个，运营商补一个；ASN、IPv4、IPv6 这样的英文标签约两个汉字宽，也补两个
function field(label, value) {
  const width = /^[\x20-\x7E]+$/.test(label) ? 2 : label.length;
  return `${label}${'\u3000'.repeat(Math.max(1, 4 - width))}${value || '未知'}`;
}

// 标题：分数和官网档位名；图标用那一档的颜色。没有分数时（IPv6 或接口没给）图标是灰的
function panel(m) {
  const score = m.score === null ? null : Math.round(m.score);
  const verdict = score === null ? (m.isV6 ? 'IPv6 不评分' : '暂无评分') : `${score}% ${m.band.name}`;
  const place = [m.flag, m.country, m.city].filter(Boolean).join(' ');
  const lines = [
    field(m.isV6 ? 'IPv6' : 'IPv4', m.shownIP),
    field('属性', m.residential === null ? '' : m.residential ? '住宅宽带' : '机房'),
    field('来源', m.broadcast === null ? '' : m.broadcast ? '广播 IP' : '原生 IP'),
    field('ASN', m.asn),
    field('位置', place),
    field('运营商', m.org),
  ];
  return {
    title: `${TITLE} · ${verdict}`,
    content: lines.join('\n'),
    icon: ICON,
    'icon-color': m.band ? m.band.color : GRAY,
  };
}

// ───────────────────────────── 小工具 ─────────────────────────────

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shorten(value, max) {
  const text = String(value || '').replace(/^\w*Error:\s*/, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function maskIP(ip) {
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean);
    return parts.length >= 3 ? `${parts[0]}:${parts[1]}:••:${parts[parts.length - 1]}` : ip;
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.••.${parts[3]}` : ip;
}

function flagEmoji(code) {
  if (!/^[A-Z]{2}$/.test(code)) return '🌐';
  return String.fromCodePoint(...[...code].map(char => 127397 + char.charCodeAt(0)));
}

// ───────────────────────────── 入口 ─────────────────────────────
// 放在文件最后：Surge 按普通脚本从上往下执行，入口要等上面的常量都定义好再跑

(async () => {
  const cfg = readArgs(typeof $argument === 'string' ? $argument : '');
  try {
    const data = await fetchInfo(cfg);
    const m = buildModel(data, cfg, await asHolder(cfg, data.asn));
    $done(panel(m));
  } catch (error) {
    const err = error instanceof PanelError ? error : new PanelError('出错了', shorten(error && error.message || error, 80));
    $done({ title: TITLE, content: [err.title, err.hint].filter(Boolean).join('\n'), icon: 'exclamationmark.triangle.fill', 'icon-color': ERROR_COLOR });
  }
})();
