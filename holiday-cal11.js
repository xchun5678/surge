// 节假日日历 · Surge 面板 v12（列表式・全角数字日期）
// 双周日历（农历/节气/传统节日，计算逻辑同 IBL3ND 的 CN_Cal）+ 中国法定节假日：
// 放假日、调休上班日按国务院办公厅公布安排内置（2026–2027 年），纯本地、不联网
const lunarInfo = [
  0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
  0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
  0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
  0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
  0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
  0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,
  0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
  0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,
  0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
  0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x05ac0,0x0ab60,0x096d5,0x092e0,
  0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
  0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
  0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
  0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,
  0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0
];
function lYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
  return sum + leapDays(y);
}
function leapDays(y) {
  if (lunarInfo[y - 1900] & 0xf) return (lunarInfo[y - 1900] & 0x10000) ? 30 : 29;
  return 0;
}
function leapMonth(y) { return lunarInfo[y - 1900] & 0xf; }
function monthDays(y, m) { return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
function getLunarDate(dObj) {
  let baseDate = new Date(Date.UTC(1900, 0, 31));
  let objDate = new Date(Date.UTC(dObj.getFullYear(), dObj.getMonth(), dObj.getDate()));
  let offset = Math.floor((objDate - baseDate) / 86400000);
  let y, m, i, days = 0;
  for (y = 1900; y < 2050 && offset > 0; y++) { days = lYearDays(y); offset -= days; }
  if (offset < 0) { offset += days; y--; }
  let leap = leapMonth(y), isLeap = false;
  for (i = 1; i < 13 && offset > 0; i++) {
    if (leap > 0 && i === (leap + 1) && !isLeap) { --i; isLeap = true; days = leapDays(y); }
    else days = monthDays(y, i);
    if (isLeap && i === (leap + 1)) isLeap = false;
    offset -= days;
  }
  if (offset === 0 && leap > 0 && i === leap + 1) {
    if (isLeap) isLeap = false; else { isLeap = true; --i; }
  }
  if (offset < 0) { offset += days; --i; }
  return { year: y, month: i, day: offset + 1, isLeap };
}
const lunarMonths = ['正月','二月','三月','四月','五月','六月','七月','八月','九月','十月','冬月','腊月'];
const lunarDaysStr = ['初一','初二','初三','初四','初五','初六','初七','初八','初九','初十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十','廿一','廿二','廿三','廿四','廿五','廿六','廿七','廿八','廿九','三十'];
function lunarDayStr(d) {
  const l = getLunarDate(d);
  if (l.day === 1) return (l.isLeap ? '闰' : '') + lunarMonths[l.month - 1];
  return lunarDaysStr[l.day - 1];
}
function lunarFullStr(d) {
  const l = getLunarDate(d);
  return (l.isLeap ? '闰' : '') + lunarMonths[l.month - 1] + lunarDaysStr[l.day - 1];
}

const SOLAR_TERM_NAMES = ['小寒','大寒','立春','雨水','惊蛰','春分','清明','谷雨','立夏','小满','芒种','夏至','小暑','大暑','立秋','处暑','白露','秋分','寒露','霜降','立冬','小雪','大雪','冬至'];
const SOLAR_TERM_OFFSETS = [0,21208,42467,63836,85337,107014,128867,150921,173149,195551,218072,240693,263343,285989,308563,331033,353350,375494,397447,419210,440795,462224,483532,504758];
function getSolarTerm(y, m, d) {
  for (let i = 0; i < 24; i++) {
    const ms = Date.UTC(1900,0,6,2,5,0) + 365.24219878*86400000*(y-1900) + SOLAR_TERM_OFFSETS[i]*60000;
    const t = new Date(ms);
    if (t.getUTCFullYear() === y && t.getUTCMonth()+1 === m && t.getUTCDate() === d) return SOLAR_TERM_NAMES[i];
  }
  return null;
}

const LUNAR_HOLIDAYS = { '1-1':'春节','1-15':'元宵节','5-5':'端午节','7-7':'七夕节','8-15':'中秋节','9-9':'重阳节','12-8':'腊八节' };
const SOLAR_HOLIDAYS = { '1-1':'元旦','3-8':'妇女节','5-1':'劳动节','6-1':'儿童节','10-1':'国庆节','10-24':'程序员节','12-25':'圣诞节' };
function getHoliday(d) {
  const l = getLunarDate(d);
  const lk = `${l.month}-${l.day}`;
  if (LUNAR_HOLIDAYS[lk]) return { text: LUNAR_HOLIDAYS[lk], type: 'holiday' };
  const sk = `${d.getMonth()+1}-${d.getDate()}`;
  if (SOLAR_HOLIDAYS[sk]) return { text: SOLAR_HOLIDAYS[sk], type: 'holiday' };
  const term = getSolarTerm(d.getFullYear(), d.getMonth()+1, d.getDate());
  if (term) return { text: term, type: 'term' };
  return null;
}

function getWeekNumber(date) {
  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  return 1 + Math.ceil((firstThursday - target) / 604800000);
}


// ==== 节假日（数据：国务院办公厅公布的 2026–2027 年放假安排，本地内置）====
const HOLIDAYS = {
  '2026-01-01':['元旦',1], '2026-01-02':['元旦',1], '2026-01-03':['元旦',1], '2026-01-04':['元旦',0],
  '2026-02-14':['春节',0], '2026-02-15':['春节',1], '2026-02-16':['春节',1], '2026-02-17':['春节',1],
  '2026-02-18':['春节',1], '2026-02-19':['春节',1], '2026-02-20':['春节',1], '2026-02-21':['春节',1],
  '2026-02-22':['春节',1], '2026-02-23':['春节',1], '2026-02-28':['春节',0], '2026-04-04':['清明',1],
  '2026-04-05':['清明',1], '2026-04-06':['清明',1], '2026-05-01':['劳动',1], '2026-05-02':['劳动',1],
  '2026-05-03':['劳动',1], '2026-05-04':['劳动',1], '2026-05-05':['劳动',1], '2026-05-09':['劳动',0],
  '2026-06-19':['端午',1], '2026-06-20':['端午',1], '2026-06-21':['端午',1], '2026-09-20':['国庆',0],
  '2026-09-25':['中秋',1], '2026-09-26':['中秋',1], '2026-09-27':['中秋',1], '2026-10-01':['国庆',1],
  '2026-10-02':['国庆',1], '2026-10-03':['国庆',1], '2026-10-04':['国庆',1], '2026-10-05':['国庆',1],
  '2026-10-06':['国庆',1], '2026-10-07':['国庆',1], '2026-10-10':['国庆',0], '2027-01-01':['元旦',1],
  '2027-01-02':['元旦',1], '2027-01-03':['元旦',1], '2027-01-31':['春节',0], '2027-02-05':['春节',1],
  '2027-02-06':['春节',1], '2027-02-07':['春节',1], '2027-02-08':['春节',1], '2027-02-09':['春节',1],
  '2027-02-10':['春节',1], '2027-02-11':['春节',1], '2027-02-12':['春节',1], '2027-02-13':['春节',1],
  '2027-02-14':['春节',0], '2027-04-03':['清明',1], '2027-04-04':['清明',1], '2027-04-05':['清明',1],
  '2027-05-01':['劳动',1], '2027-05-02':['劳动',1], '2027-05-03':['劳动',1], '2027-05-04':['劳动',1],
  '2027-05-05':['劳动',1], '2027-05-08':['劳动',0], '2027-06-09':['端午',1], '2027-09-15':['中秋',1],
  '2027-09-26':['国庆',0], '2027-10-01':['国庆',1], '2027-10-02':['国庆',1], '2027-10-03':['国庆',1],
  '2027-10-04':['国庆',1], '2027-10-05':['国庆',1], '2027-10-06':['国庆',1], '2027-10-07':['国庆',1],
  '2027-10-09':['国庆',0]
};

function dateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isNamesake(d, name) {
  const md = (d.getMonth() + 1) + '-' + d.getDate();
  if (name === '元旦') return md === '1-1';
  if (name === '劳动') return md === '5-1';
  if (name === '国庆') return md === '10-1';
  if (name === '清明') return getSolarTerm(d.getFullYear(), d.getMonth() + 1, d.getDate()) === '清明';
  const l = getLunarDate(d);
  if (name === '春节') return l.month === 1 && l.day === 1 && !l.isLeap;
  if (name === '端午') return l.month === 5 && l.day === 5 && !l.isLeap;
  if (name === '中秋') return l.month === 8 && l.day === 15 && !l.isLeap;
  return false;
}

// ==== Surge 面板渲染（列表式 + 节假日）====
const now = new Date();
const todayY = now.getFullYear(), todayM = now.getMonth(), todayD = now.getDate();
const monthNames = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
const weekNames = ['日','一','二','三','四','五','六'];
const lunarMonthNamesArr = ['正月','二月','三月','四月','五月','六月','七月','八月','九月','十月','冬月','腊月'];

function fmtMD(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
function periodOf(d) {
  const h = HOLIDAYS[dateKey(d)];
  if (!h || !h[1]) return null;
  const start = new Date(d); const end = new Date(d);
  for (;;) { const p = new Date(start); p.setDate(p.getDate() - 1); const ph = HOLIDAYS[dateKey(p)]; if (ph && ph[1] && ph[0] === h[0]) start.setTime(p.getTime()); else break; }
  for (;;) { const n = new Date(end); n.setDate(n.getDate() + 1); const nh = HOLIDAYS[dateKey(n)]; if (nh && nh[1] && nh[0] === h[0]) end.setTime(n.getTime()); else break; }
  return { name: h[0], start, end };
}

let summary = '';
const curPeriod = periodOf(now);
if (curPeriod) {
  summary = '\n' + curPeriod.name + '假期 · 至' + fmtMD(curPeriod.end);
} else {
  for (let k = 1; k <= 400; k++) {
    const d = new Date(now); d.setDate(d.getDate() + k);
    const p = periodOf(d);
    if (p) { summary = '\n' + p.name + '假期 ' + fmtMD(p.start) + '–' + fmtMD(p.end) + ' · 还有 ' + k + ' 天'; break; }
  }
}

const sunday = new Date(now);
sunday.setDate(now.getDate() - now.getDay());
const lines = [];
for (let w = 0; w < 2; w++) {
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + w * 7 + i);
    const isToday = d.getFullYear() === todayY && d.getMonth() === todayM && d.getDate() === todayD;
    const ds = String(d.getDate()).padStart(2, '0').replace(/[0-9]/g, c => String.fromCharCode(0xFF10 + Number(c)));
    const parts = [ds + '日', '周' + weekNames[d.getDay()], lunarDayStr(d)];
    const h = HOLIDAYS[dateKey(d)];
    let statName = null, stat = null;
    if (h) {
      if (!h[1]) stat = '调休上班';
      else if (isNamesake(d, h[0])) statName = h[0];
      else stat = '放假';
    }
    let fest = getHoliday(d);
    const nd = new Date(d); nd.setDate(nd.getDate() + 1);
    const nl = getLunarDate(nd);
    if (nl.month === 1 && nl.day === 1 && !nl.isLeap) fest = { text: '除夕' };
    if (fest && fest.text !== statName && fest.text !== (statName || '') + '节') parts.push(fest.text);
    if (statName) parts.push(statName);
    if (stat) parts.push(stat);
    if (isToday) parts.push('今天');
    lines.push(parts.join(' · '));
  }
  if (w === 0) lines.push('');
}

const panel = {
  title: monthNames[todayM] + todayD + '日 星期' + weekNames[now.getDay()] + ' · ' + lunarFullStr(now),
  content: todayY + '年 · 第' + getWeekNumber(now) + '周 · 农历' + lunarMonthNamesArr[getLunarDate(now).month - 1] + summary + '\n' + lines.join('\n'),
  icon: 'calendar',
  'icon-color': '#D43028'
};
if (typeof $done !== 'undefined') $done(panel);
