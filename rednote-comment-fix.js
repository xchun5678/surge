/*
 * rednote-comment-fix.js
 * 小红书 / RedNote 评论区实况照片去水印 —— 补丁脚本（xchun5678）
 *
 * 背景：原版模块（RedPaper + 水印配置拦截）处理笔记图片保存是好的，
 * 但 9.55 里它对评论实况下载接口不再换流：服务器给的下载地址是带水印的 _7 流，
 * 评论列表里躺着的 _16 原流才是干净的。本脚本只做两件事：
 *   1. 评论列表响应：登记每条评论媒体的最佳原流（video_id -> master_url），
 *      并把评论者 user.red_id 改名为 fmz200（与原版同手法，幂等）；
 *   2. 评论下载响应：按 video_id 把 video_url 换成登记的原流。
 * 只挂评论两个接口，不碰笔记详情/信息流，不影响笔记图片保存。
 * fail-open：任何异常都原样放行。
 */

const STORE_CMT = "xchun.rednote.comment";
const url = ($request && $request.url) || "";

function readStore(key) {
  try {
    const raw = $persistentStore.read(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeStore(key, value) {
  try {
    $persistentStore.write(JSON.stringify(value), key);
  } catch (e) {}
}

function capMap(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const out = {};
  for (const k of keys.slice(keys.length - max)) out[k] = map[k];
  return out;
}

function bestStream(stream) {
  if (!stream) return null;
  const pick = (list) => {
    if (!Array.isArray(list)) return null;
    const ok = list.filter((v) => v && v.master_url);
    if (!ok.length) return null;
    ok.sort((a, b) => {
      const ra = (a.width || 0) * (a.height || 0);
      const rb = (b.width || 0) * (b.height || 0);
      if (rb !== ra) return rb - ra;
      return (b.avg_bitrate || 0) - (a.avg_bitrate || 0);
    });
    return ok[0];
  };
  return pick(stream.h265) || pick(stream.h264) || null;
}

// 只读收割：递归找带视频流的结构，把最佳流地址按身边的 id 登记进缓存
function harvestMedia(node, cache) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) harvestMedia(x, cache);
    return;
  }
  let vi = node.video_info;
  if (typeof vi === "string") {
    try { vi = JSON.parse(vi); } catch (e) { vi = null; }
  }
  const streamBoxes = [];
  if (vi && vi.stream) streamBoxes.push(vi);
  if (node.live_photo && node.live_photo.media && node.live_photo.media.stream) {
    streamBoxes.push(node.live_photo.media);
  }
  if (node.media && node.media.stream) streamBoxes.push(node.media);
  if (node.stream && (node.stream.h265 || node.stream.h264)) streamBoxes.push(node);
  for (const box of streamBoxes) {
    const best = bestStream(box.stream);
    if (!best) continue;
    const ids = [node.video_id, node.file_id, node.live_photo_file_id,
      vi && vi.video && vi.video.video_id,
      node.live_photo && node.live_photo.media && node.live_photo.media.video_id,
      box.video_id];
    for (const id of ids) {
      if (id) cache[String(id)] = best.master_url;
    }
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") harvestMedia(v, cache);
  }
}

function renameRedId(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) renameRedId(x);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(node, "red_id")) {
    node.fmz200 = node.red_id;
    delete node.red_id;
  }
  for (const k of Object.keys(node)) renameRedId(node[k]);
}

function fixComment(c) {
  if (!c || typeof c !== "object") return;
  if (c.comment_type === 3) c.comment_type = 2;
  if (c.media_source_type === 1) c.media_source_type = 0;
}

function handleCommentList(obj) {
  const comments = obj.data && obj.data.comments;
  if (Array.isArray(comments)) {
    for (const c of comments) {
      fixComment(c);
      if (c && Array.isArray(c.sub_comments)) c.sub_comments.forEach(fixComment);
    }
  }
  const cache = readStore(STORE_CMT) || {};
  harvestMedia(obj.data, cache);
  writeStore(STORE_CMT, capMap(cache, 300));
  renameRedId(obj);
}

function handleCommentDownload(obj) {
  if (!obj.data) return;
  const cache = readStore(STORE_CMT) || {};
  let hit = "";
  const swap = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(swap); return; }
    const id = node.video_id || node.file_id;
    if (id && cache[String(id)]) {
      hit = String(id);
      for (const f of ["video_url", "download_url", "master_url", "origin_url", "url"]) {
        if (typeof node[f] === "string" && node[f]) node[f] = cache[String(id)];
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") swap(v);
    }
  };
  swap(obj.data);
  console.log("[RedNote-CmtFix] 下载换流：" + (hit ? "命中 " + hit : "未命中缓存"));
}

function main() {
  if (!$response || !$response.body) return $done({});
  let obj;
  try {
    obj = JSON.parse($response.body);
  } catch (e) {
    return $done({});
  }
  if (!obj || typeof obj !== "object") return $done({});
  try {
    if (url.includes("/note/comment/list")) handleCommentList(obj);
    else if (url.includes("/interaction/comment/video/download")) handleCommentDownload(obj);
    else return $done({});
  } catch (e) {
    return $done({});
  }
  $done({ body: JSON.stringify(obj) });
}

main();
