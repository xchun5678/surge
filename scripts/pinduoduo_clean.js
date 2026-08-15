// 拼多多去广告脚本
// 处理首页/订单/个人中心等接口，移除广告模块
// author: xchun5678

// 定义需要处理的接口及对应的字段删除逻辑
const handlers = {
  // 首页 - 删除底部视频模块(dy_module)、icon_set、搜索热词
  "alexa/homepage/hub": (body) => {
    if (body.result) {
      delete body.result.dy_module;
      delete body.result.icon_set;
      delete body.result.search_bar_hot_query;
      // 底栏只保留首页、聊天、个人
      if (body.result.bottom_tabs) {
        body.result.bottom_tabs = body.result.bottom_tabs.filter(t =>
          ["index.html", "chat_list.html", "personal.html"].includes(t.link)
        );
      }
      if (body.result.buffer_bottom_tabs) {
        body.result.buffer_bottom_tabs = body.result.buffer_bottom_tabs.filter(t =>
          ["index.html", "chat_list.html", "personal.html"].includes(t.link)
        );
      }
    }
    return body;
  },

  // 搜索结果 - 删除 expansion 推广
  "/search?": (body) => {
    delete body.expansion;
    return body;
  },

  // 个人中心 - 删除会员卡、样式、图标等
  "philo/personal/hub": (body) => {
    delete body.monthly_card_entrance;
    delete body.personal_center_style_v2_vo;
    if (body.icon_set) {
      delete body.icon_set.icons;
      delete body.icon_set.top_personal_icons;
    }
    return body;
  },

  // 首页渲染/整合 - 删除底部栏、直播浮窗
  "oak/integration/render": (body) => {
    delete body.bottom_section_list;
    if (body.ui) {
      delete body.ui.bottom_section;
      if (body.ui.live_section) delete body.ui.live_section.float_info;
    }
    return body;
  },

  // 订单详情 - 删除营销banner
  "caterham/v3/query/order_detail_group": (body) => {
    if (body.data) delete body.data.goods_list;
    return body;
  },

  // 订单列表/订单页 - 删除banner和推荐
  "/order/": (body) => {
    delete body.marketing_banner_vo;
    if (body.shipping) delete body.shipping.banner_above_recommend;
    return body;
  },
  "aristotle/order_list_v4": (body) => {
    if (body.orders) {
      body.orders.forEach(order => {
        if (order.order_buttons) {
          order.order_buttons.forEach(btn => delete btn.order_growth_tip);
        }
      });
    }
    return body;
  },
};

// 主处理函数
function process() {
  const url = $request.url;
  let body = JSON.parse($response.body || "{}");

  let matched = false;
  for (const [pattern, handler] of Object.entries(handlers)) {
    if (url.includes(pattern)) {
      body = handler(body);
      matched = true;
    }
  }

  if (!matched) {
    $done({});
    return;
  }

  $done({ body: JSON.stringify(body) });
}

process();