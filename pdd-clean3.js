// 拼多多去广告（自制版）v3 — Surge http-response
// 原则：只删广告字段，不改响应结构、不喂空响应、不写存储、不发请求；
// 任何异常（非 JSON、服务器错误、结构不认识）一律原样放行（fail-open）。
// v3 改动：filterTabs 放宽——个别标签项结构异常（无 link 字段）时不再整份放弃过滤，
// 只跳过认不出的那一项，其余照常清（v2 的全有全无检查会被服务器 A/B 变体整份绕过）。
(function () {
  var ROUTES = {
    "/api/alexa/homepage/hub": "home",
    "/api/philo/personal/hub": "personal",
    "/api/oak/integration/render": "integration",
    "/api/aristotle/order_list_v4": "orderlist",
    "/search": "search"
  };
  var KEEP_TABS = ["index.html", "chat_list.html", "personal.html"];

  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

  function delPath(root, path) {
    var keys = path.split("."), node = root, i;
    for (i = 0; i < keys.length - 1; i++) {
      if (!isObj(node)) return;
      node = node[keys[i]];
    }
    if (isObj(node)) delete node[keys[keys.length - 1]];
  }

  function filterTabs(tabs) {
    if (!Array.isArray(tabs) || !tabs.length) return tabs;
    var i, item;
    // 首页/聊天/个人三个核心入口缺一不可（只在带 link 的项里找），缺了说明结构变了，整份导航原样保留
    for (i = 0; i < KEEP_TABS.length; i++) {
      var found = false;
      for (var j = 0; j < tabs.length; j++) {
        item = tabs[j];
        if (isObj(item) && item.link === KEEP_TABS[i]) { found = true; break; }
      }
      if (!found) return tabs;
    }
    // 带 link 的只留核心三项；认不出（无 link）的项原样保留，不再因一项异常整份放弃
    return tabs.filter(function (t) {
      if (!isObj(t) || typeof t.link !== "string") return true;
      return KEEP_TABS.indexOf(t.link) !== -1;
    });
  }

  function serverFailed(d) {
    if (d.success === false || d.is_success === false) return true;
    var ec = d.error_code;
    return ec !== undefined && ec !== null && ec !== "" && ec !== 0 && ec !== "0";
  }

  function clean(d, route) {
    var i, j;
    if (route === "home" && isObj(d.result)) {
      var root = d.result;
      if (Array.isArray(root.bottom_tabs)) root.bottom_tabs = filterTabs(root.bottom_tabs);
      if (Array.isArray(root.buffer_bottom_tabs)) root.buffer_bottom_tabs = filterTabs(root.buffer_bottom_tabs);
      if (Array.isArray(root.all_top_opts)) {
        for (i = 0; i < root.all_top_opts.length; i++) {
          var opt = root.all_top_opts[i];
          if (!isObj(opt)) continue;
          delete opt.selected_image; delete opt.image; delete opt.height; delete opt.width;
        }
      }
      delPath(root, "dy_module.irregular_banner_dy");
      delete root.icon_set;
      delete root.search_bar_hot_query;
    } else if (route === "personal") {
      delete d.monthly_card_entrance;
      delete d.personal_center_style_v2_vo;
      delPath(d, "icon_set.icons");
      delPath(d, "icon_set.top_personal_icons");
    } else if (route === "integration") {
      delete d.bottom_section_list;
      delPath(d, "ui.bottom_section");
      delPath(d, "ui.live_section.float_info");
    } else if (route === "order") {
      delete d.marketing_banner_vo;
      delPath(d, "shipping.banner_above_recommend");
    } else if (route === "orderlist" && Array.isArray(d.orders)) {
      for (i = 0; i < d.orders.length; i++) {
        var order = d.orders[i];
        if (!isObj(order) || !Array.isArray(order.order_buttons)) continue;
        for (j = 0; j < order.order_buttons.length; j++) {
          if (isObj(order.order_buttons[j])) delete order.order_buttons[j].order_growth_tip;
        }
      }
    } else if (route === "search") {
      delete d.expansion;
    }
  }

  try {
    if (typeof $request === "undefined" || !$request || typeof $response === "undefined" || !$response) { $done({}); return; }
    var status = Number($response.status);
    if (status < 200 || status >= 300) { $done({}); return; }
    var url;
    try { url = new URL($request.url); } catch (e) { $done({}); return; }
    // 拼多多 App 大量请求走裸 IP 直连（靠 Host 头区分），域名与裸 IP 两种形态都要认，
    // 但裸 IP 必须 Host 头精确等于官方 API 域名才处理，避免误伤其他流量。
    var host = url.hostname.toLowerCase();
    var owned = (host === "api.pinduoduo.com" || host === "api.yangkeduo.com");
    if (!owned) {
      var bareIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[?[0-9a-f:]+\]?$/i.test(host);
      if (bareIP) {
        var headers = $request.headers || {};
        var hostHeader = "";
        for (var hk in headers) { if (String(hk).toLowerCase() === "host") { hostHeader = String(headers[hk]).trim().toLowerCase(); break; } }
        var m = /^(api\.(?:pinduoduo|yangkeduo)\.com)(?::([0-9]{1,5}))?$/.exec(hostHeader);
        owned = !!m;
      }
    }
    if (!owned) { $done({}); return; }
    var route = ROUTES[url.pathname] || (url.pathname.indexOf("/order/") === 0 ? "order" : "");
    if (!route) { $done({}); return; }
    var body = $response.body;
    if (typeof body !== "string" || !body) { $done({}); return; }
    var data;
    try { data = JSON.parse(body); } catch (e) { $done({}); return; }
    if (!isObj(data) || serverFailed(data)) { $done({}); return; }
    clean(data, route);
    var after = JSON.stringify(data);
    if (after === body) { $done({}); return; }
    $done({ body: after });
  } catch (e) {
    try { $done({}); } catch (_) {}
  }
})();
