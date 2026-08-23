// 小红书/RedNote 去水印去广告脚本
// 处理评论/笔记接口返回的图片URL，去掉水印参数
// author: xchun5678

function process() {
  const url = $request.url;
  try {
    let body = typeof $response.body === 'string' ? JSON.parse($response.body) : $response.body;
    body = removeWatermark(body);
    $done({ body: JSON.stringify(body) });
  } catch (e) {
    $done({});
  }
}

function cleanImageUrl(u) {
  if (!u || typeof u !== 'string') return u;
  // 将带水印的图床域名替换为无水印图床域名
  u = u.replace(/sns-img[^.]*\.xhscdn\.com/g, 'sns-webpic-qc.xhscdn.com');
  u = u.replace(/ci\.xiaohongshu\.com/g, 'sns-webpic-qc.xhscdn.com');
  // 去掉水印/缩放参数
  u = u.replace(/[?&]imageView2[^\s&]*(&|$)/, '$1');
  u = u.replace(/[?&]imageMogr2[^\s&]*(&|$)/, '$1');
  u = u.replace(/[?&]wm=[^&]*/g, '');
  return u;
}

function walk(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(walk); return; }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      obj[k] = cleanImageUrl(v);
    } else if (typeof v === 'object') {
      walk(v);
    }
  }
}

function removeWatermark(body) {
  try { walk(body); } catch(e) {}
  return body;
}

process();