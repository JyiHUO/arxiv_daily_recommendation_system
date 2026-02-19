# alphaxiv Daily

每 6 小时自动抓取 [alphaxiv](https://www.alphaxiv.org) 上最近 30 天 `cs.IR` 领域热门论文，为每篇**新**论文创建一个 GitHub Release，并维护 RSS feed。每篇 Release 包含中英对照内容，方便阅读。

---

## 效果预览

每篇论文生成一个 Release，内容格式如下：

```
# 论文英文标题
> 中文标题：...

arXiv | alphaxiv | PDF | GitHub(如有)
作者 | 发布日期 | 主题 | 热度

## Abstract
英文原文...
【中文】中文译文...

## Summary
英文摘要...
【中文】中文译文...

## Original Problem
- 英文问题1
  > 中文译文1
- 英文问题2
  > 中文译文2

## Solution / Key Insights / Results
（同上，每条英文后紧跟中文）
```

---

## 文件结构

```
alphaxiv_daily/
├── fetch.js                        # 主脚本（抓取 + 翻译 + 生成）
├── seen.json                       # 已处理论文 ID 记录（去重用）
├── feed.xml                        # RSS feed（最近 100 条）
├── package.json
├── README.md
├── releases/
│   └── YYYY-MM-DD/
│       └── <arxiv_id>.md           # 每篇论文的 release 正文
└── .github/
    └── workflows/
        └── fetch.yml               # GitHub Actions 定时任务
```

---

## 去重逻辑

- `seen.json` 记录所有已处理的 `universal_paper_id`（即 arXiv ID）
- 每次运行只处理 `seen.json` 中**不存在**的新论文
- GitHub Release 创建前额外检查 tag 是否已存在，防止重复
- 因此无论运行多少次，同一篇论文只会产生一个 Release

---

## 本地运行

### 环境要求

- Node.js 18+（无需安装任何 npm 包，全部使用内置模块）

### 步骤

```bash
# 1. 进入项目根目录
cd /path/to/your/repo

# 2. 首次运行（全量抓取，加 --limit 限制数量避免等太久）
HTTPS_PROXY=http://127.0.0.1:7897 \
REPO_URL=https://github.com/YOUR_USERNAME/YOUR_REPO \
node alphaxiv_daily/fetch.js --limit 5

# 3. 后续运行（只处理新论文）
HTTPS_PROXY=http://127.0.0.1:7897 \
REPO_URL=https://github.com/YOUR_USERNAME/YOUR_REPO \
node alphaxiv_daily/fetch.js
```

### 参数说明

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `HTTPS_PROXY` | 本地代理地址（访问 Google Translate 必须） | 无 |
| `REPO_URL` | 仓库地址，用于生成 RSS 链接 | `https://github.com/YOUR_USERNAME/YOUR_REPO` |

| 命令行参数 | 说明 |
|---|---|
| `--limit N` | 每次最多处理 N 篇新论文（本地测试用） |

> **注意：** 不设置 `HTTPS_PROXY` 时，Google Translate 在国内无法访问，翻译会静默跳过，论文内容仍正常生成（只是没有中文译文）。

---

## 部署到 GitHub Actions

### 步骤

**1. 新建 GitHub 仓库**，将整个项目推送上去（注意 `.github/` 目录要在仓库根目录）

**2. 开启 Actions 写权限**

仓库 → Settings → Actions → General → Workflow permissions → 选择 **Read and write permissions** → Save

**3. 触发运行**

- 自动：每天 UTC 0:00 / 6:00 / 12:00 / 18:00（北京时间 8:00 / 14:00 / 20:00 / 次日 2:00）
- 手动：仓库 → Actions → `alphaxiv Daily Paper Fetch` → Run workflow

**4. 订阅 RSS**

```
https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/alphaxiv_daily/feed.xml
```

**5. 查看 Releases**

仓库 Releases 页面，每篇论文一个 Release，tag 为 arXiv ID（如 `2602.15019`）

---

## API 参数配置

在 `fetch.js` 顶部 `FEED_PARAMS` 修改：

| 参数 | 当前值 | 可选值 |
|---|---|---|
| `sort` | `Hot` | `Hot` / `Comments` / `Views` / `Likes` / `GitHub` / `Recommended` |
| `interval` | `30 Days` | `3 Days` / `7 Days` / `30 Days` / `90 Days` / `All time` |
| `topics` | `["cs.IR"]` | 任意 arXiv 分类，如 `["cs.CV"]` / `["cs.IR","cs.LG"]` |
| `pageSize` | `200` | 最大 200 |

---

## 翻译说明

使用 **Google Translate 免费接口**（无需 API Key）：

- GitHub Actions 服务器在美国，可直接访问，**无需任何配置**
- 本地运行需要设置 `HTTPS_PROXY` 指向本地代理
- 翻译失败时静默跳过，不影响论文内容生成
