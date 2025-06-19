# Surge 规则合集 · xchun5678

📦 本仓库托管了多个适用于 Surge 的规则文件，包括分流规则（`.list`）、模块规则（`.module`）、广告屏蔽等内容，旨在优化网络体验并增强特定 App 使用体验。

## 📚 目录结构

| 名称 | 类型 | 描述 |
|------|------|------|
| `AI.list` | 分流规则 | 包含 OpenAI、Claude、Gemini、Midjourney 等 AI 平台域名 |
| `IBKR_Proxy.list` | 分流规则 | 盈透证券（IBKR）相关域名及服务分流 |
| `OKX.list` | 分流规则 | OKX 交易平台相关域名直连规则 |
| `RIOT.list` | 分流规则 | Riot Games 全家桶：LOL、Valorant 等平台域名 |
| `tradeup.list` | 分流规则 | Tradeup.com 域名相关直连规则 |
| `BOCHK.list` | 分流规则 | 中国银行（香港）相关 App 与服务域名 |
| `HSBC.list` | 分流规则 | 汇丰银行 App 及相关功能服务域名（含 LivePerson） |
| `meitu_clean.module` | 模块规则 | 美图秀秀 App 广告屏蔽模块 |
| `baidu_map_clean.module` | 模块规则 | 百度地图去广告（保留足迹功能）模块 |
| `amap_clean.module` | 模块规则 | 高德地图去广告模块 |
| `cmcc_clean.module` | 模块规则 | 中国移动 App 广告屏蔽模块 |

## 🔗 使用方法

### Surge 中订阅方法：

1. 打开 Surge App；
2. 前往 `模块` 或 `规则` 设置页面；
3. 点击「添加订阅」，填写以下链接之一；
4. 命名并保存，点击启用即可生效。

### 📎 示例订阅链接（原始链接）：

```
https://raw.githubusercontent.com/xchun5678/surge/main/AI.list
https://raw.githubusercontent.com/xchun5678/surge/main/IBKR_Proxy.list
https://raw.githubusercontent.com/xchun5678/surge/main/tradeup.list
https://raw.githubusercontent.com/xchun5678/surge/main/BOCHK.list
https://raw.githubusercontent.com/xchun5678/surge/main/HSBC.list
https://raw.githubusercontent.com/xchun5678/surge/main/meitu_clean.module
```

> ✅ 请务必使用 `.list` 或 `.module` 的 **Raw 地址链接** 用作 Surge 订阅路径。

## 🙋‍♂️ 作者

由 [@xchun5678](https://github.com/xchun5678) 创建并维护。