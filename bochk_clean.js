/*
BOCHK 去广告脚本
作者: @xchun5678
说明: 移除中国银行（香港）App 首页广告、推荐等
*/

let body = $response.body;
let url = $request.url;

try {
  let obj = JSON.parse(body);

  if (url.includes("homepage/homepageInfo")) {
    // 清空 banner、推荐等首页广告
    if (obj.data) {
      obj.data.bannerList = [];
      obj.data.topCardList = [];
      obj.data.bottomCardList = [];
      obj.data.newsList = [];
    }
  }

  if (url.includes("message/queryList")) {
    // 清空推荐消息列表
    if (obj.data) {
      obj.data = {
        list: [],
        total: 0
      };
    }
  }

  $done({ body: JSON.stringify(obj) });
} catch (e) {
  console.log("BOCHK 去广告脚本错误: ", e);
  $done({});
}
