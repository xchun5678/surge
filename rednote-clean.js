/*
 * rednote-clean.js
 * 小红书 / RedNote（海外版 rnote.com）去水印、去广告 —— xchun5678 自制版
 *
 * 配套模块：RedNote-Clean.sgmodule（脚本由该模块按接口逐个挂载）
 * 设计原则：fail-open。任何解析失败或异常都原样放行响应，绝不弄坏 App。
 * 去水印的另一半在模块的 [Map Local] 里：拦截水印配置接口，
 * 客户端拿不到水印配置；本脚本负责响应体内的开关、广告与下载地址。
 */

const STORE_IMG = "xchun.rednote.images";   // 最近一次图片详情的图片列表（供实况照片保存接口取原视频地址）
const STORE_VID = "xchun.rednote.videos";   // 笔记 id -> 最佳视频流地址
const STORE_CMT = "xchun.rednote.comment";  // 评论媒体 video_id -> 最佳视频流地址

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

// 给对象型缓存封顶，超了丢最旧的键（按插入顺序）
function capMap(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const out = {};
  for (const k of keys.slice(keys.length - max)) out[k] = map[k];
  return out;
}

// 从流列表里挑最佳一条：优先 H265，同编码内先比分辨率面积、再比平均码率
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

// 笔记级处理：打开保存开关、关掉水印、补齐下载入口
function patchNote(item) {
  if (!item || typeof item !== "object") return;
  const cfg = item.media_save_config;
  if (cfg) {
    cfg.disable_save = false;       // 允许保存
    cfg.disable_watermark = true;   // 保存不带水印
    cfg.disable_weibo_cover = true; // 不要微博水印封面
  }
  if (Array.isArray(item.function_switch)) {
    for (const sw of item.function_switch) {
      if (sw && (sw.type === "image_download" || sw.type === "video_download")) {
        sw.enable = true;
        if (sw.reason) delete sw.reason;
      }
    }
  }
  const entries = item.share_info && item.share_info.function_entries;
  if (Array.isArray(entries) && entries.length) {
    if (!entries.some((e) => e && e.type === "video_download")) {
      entries.unshift({ type: "video_download" });
    }
  }
}

// 记录一条笔记的最佳视频流地址，供视频保存接口替换下载地址
function cacheVideo(item) {
  const stream = item && item.video_info_v2 && item.video_info_v2.media &&
    bestStream(item.video_info_v2.media.stream);
  if (item && item.id && stream && stream.master_url) {
    const map = readStore(STORE_VID) || {};
    map[item.id] = stream.master_url;
    writeStore(STORE_VID, capMap(map, 100));
  }
}

function handleImageFeed(obj) {
  const first = Array.isArray(obj.data) && obj.data[0];
  if (!first) return;
  if (Array.isArray(first.note_list)) {
    for (const item of first.note_list) patchNote(item);
    const imgs = first.note_list[0] && first.note_list[0].images_list;
    if (Array.isArray(imgs) && imgs.length) writeStore(STORE_IMG, imgs);
  }
}

function handleFeed(obj) {
  if (!Array.isArray(obj.data)) return;
  for (const item of obj.data) {
    patchNote(item);
    cacheVideo(item);
  }
}

function handleLivePhotoSave(obj) {
  const images = readStore(STORE_IMG);
  if (!Array.isArray(images) || !images.length) return;
  const datas = [];
  for (const img of images) {
    const lp = img && img.live_photo;
    const stream = lp && lp.media && bestStream(lp.media.stream);
    if (img && img.live_photo_file_id && stream && stream.master_url) {
      datas.push({
        file_id: img.live_photo_file_id,
        video_id: lp.media.video_id,
        url: stream.master_url,
      });
    }
  }
  if (!datas.length) return;
  if (obj.data && Array.isArray(obj.data.datas)) {
    // 已有应答结构：按 file_id 把地址换成无水印原流
    for (const d of obj.data.datas) {
      const hit = datas.find((x) => x.file_id === d.file_id);
      if (hit) d.url = hit.url;
    }
  } else {
    obj.code = 0;
    obj.success = true;
    obj.data = { datas: datas };
  }
}

function handleVideoSave(obj) {
  if (!obj.data) return;
  const map = readStore(STORE_VID) || {};
  if (obj.data.note_id && map[obj.data.note_id]) {
    obj.data.download_url = map[obj.data.note_id];
  }
  if (obj.data.disable) {
    delete obj.data.disable;
    delete obj.data.msg;
    obj.data.status = 2;
  }
}

function handleHomeFeed(obj) {
  if (!Array.isArray(obj.data)) return;
  obj.data = obj.data.filter((item) => {
    if (!item) return false;
    if (item.model_type === "live_v2") return false;              // 直播推广
    if ("ads_info" in item) return false;                          // 赞助广告
    if ("card_icon" in item) return false;                         // 带货卡片
    if (Array.isArray(item.note_attributes) &&
        item.note_attributes.includes("goods")) return false;      // 商品笔记
    if (item.related_ques) delete item.related_ques;               // 相关问题
    return true;
  });
}

function handleSearchNotes(obj) {
  if (obj.data && Array.isArray(obj.data.items)) {
    obj.data.items = obj.data.items.filter((i) => i && i.model_type === "note");
  }
}

function handleSystemConfig(obj) {
  if (!obj.data) return;
  for (const k of ["splash", "store", "app_theme", "loading_img", "ads"]) {
    if (k in obj.data) delete obj.data[k];
  }
}

function handleSplash(obj) {
  // 开屏广告的投放时间整体挪到 2090 年，等于永不展示
  const FAR_START = 3818332800; // 2090-12-31 00:00:00 UTC
  const FAR_END = 3818419199;   // 2090-12-31 23:59:59 UTC
  const groups = obj.data && obj.data.ads_groups;
  if (!Array.isArray(groups)) return;
  for (const g of groups) {
    if (!g) continue;
    g.start_time = FAR_START;
    g.end_time = FAR_END;
    if (Array.isArray(g.ads)) {
      for (const ad of g.ads) {
        if (!ad) continue;
        ad.start_time = FAR_START;
        ad.end_time = FAR_END;
      }
    }
  }
}

function handleWidgets(obj) {
  if (!obj.data) return;
  for (const k of ["cooperate_binds", "generic", "note_next_step", "widget_list"]) {
    if (k in obj.data) delete obj.data[k];
  }
}

function handleFollowFeed(obj) {
  if (obj.data && Array.isArray(obj.data.items)) {
    obj.data.items = obj.data.items.filter(
      (i) => i && i.recommend_reason !== "recommend_user"
    );
  }
}

function handleFollowRecommend(obj) {
  // 这个接口本身就是「可能感兴趣的人」推荐块，有内容就整块清空
  if (obj.data && Array.isArray(obj.data.rec_users) && obj.data.rec_users.length) {
    obj.data = {};
  }
}

function fixComment(c) {
  if (!c || typeof c !== "object") return;
  // 类型 3（实况/视频类）改回 2、媒体来源 1 改回 0，客户端才会按普通媒体给出保存入口
  if (c.comment_type === 3) c.comment_type = 2;
  if (c.media_source_type === 1) c.media_source_type = 0;
  const stash = (holder) => {
    if (!holder || !holder.video_id || !holder.video_info) return;
    try {
      const info = JSON.parse(holder.video_info);
      const stream = bestStream(info && info.stream);
      if (stream && stream.master_url) {
        const map = readStore(STORE_CMT) || {};
        map[holder.video_id] = stream.master_url;
        writeStore(STORE_CMT, capMap(map, 200));
      }
    } catch (e) {}
  };
  if (Array.isArray(c.pictures)) c.pictures.forEach(stash);
  if (Array.isArray(c.videos)) c.videos.forEach(stash);
}

function handleCommentList(obj) {
  const comments = obj.data && obj.data.comments;
  if (!Array.isArray(comments)) return;
  for (const c of comments) {
    fixComment(c);
    if (c && Array.isArray(c.sub_comments)) c.sub_comments.forEach(fixComment);
  }
}

function handleCommentDownload(obj) {
  const video = obj.data && obj.data.video;
  if (!video || !video.video_id) return;
  const map = readStore(STORE_CMT) || {};
  if (map[video.video_id]) video.video_url = map[video.video_id];
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
    if (url.includes("/note/live_photo/save")) handleLivePhotoSave(obj);
    else if (url.includes("/note/imagefeed")) handleImageFeed(obj);
    else if (url.includes("/note/videofeed") || url.includes("/note/feed")) handleFeed(obj);
    else if (url.includes("/note/video/save")) handleVideoSave(obj);
    else if (url.includes("/note/widgets")) handleWidgets(obj);
    else if (url.includes("/homefeed")) handleHomeFeed(obj);
    else if (url.includes("/search/notes")) handleSearchNotes(obj);
    else if (url.includes("/system/service/ui/config")) handleSystemConfig(obj);
    else if (url.includes("/system_service/splash_config")) handleSplash(obj);
    else if (url.includes("/system_service/config")) handleSystemConfig(obj);
    else if (url.includes("/followfeed")) handleFollowFeed(obj);
    else if (url.includes("/recommend/user/follow_recommend")) handleFollowRecommend(obj);
    else if (url.includes("/note/comment/list")) handleCommentList(obj);
    else if (url.includes("/interaction/comment/video/download")) handleCommentDownload(obj);
    else return $done({});
  } catch (e) {
    return $done({});
  }

  $done({ body: JSON.stringify(obj) });
}

main();
