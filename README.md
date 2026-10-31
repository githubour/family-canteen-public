# 今日菜单 · 家庭点菜系统

> **公开仓定位（先读这个）**
>
> - 本仓库由私有仓 `family-canteen` **单向导出**生成（`scripts/export-public.sh` + PII/密钥扫描 + 清单校验），
>   **请勿直接向本仓提交代码**——下次导出会整体覆盖。发现问题请开 Issue，修复合并回私有仓后随下次导出生效。
> - 想跟踪上游更新：Watch 本仓库即可，导出即推送；想在自己的内网跑完整版，按下方「快速开始」部署即可，
>   功能与私有仓一致（仅家传菜谱数据换成了 3 道通用示意菜）。
> - 历史卫生说明：仓库曾做过一次 force-push 脱敏改写，GitHub 远端残留 3 个改写前的 dangling 提交
>   （2026-10-25 已逐文件验证内容干净：无密钥、无真实内网信息），等待 GitHub GC 自然回收；
>   如需立即清除可联系 GitHub Support。新克隆者不受任何影响。

一个给家庭内网用的点菜系统：家人在手机上选菜下单，系统自动汇总成「今天做什么」，
按菜品配料表（BOM）派生出采购清单和营养统计。SQLite 单文件存储，
Docker 一条命令部署到 NAS 或任意 Linux 主机，不暴露公网。

## 功能

- **点菜下单**：按（日期, 餐次）选菜，支持份数、人数、备注、截单时间（cutoff）与超时强制下单；提交幂等（clientToken），重试 / 双击不会重复建单
- **自动汇总**：当天订单按菜聚合，生成主厨视角的备菜清单；历史订单只认「下单那一刻」的快照，改菜不篡改历史
- **采购清单**：由每道菜的配料表（每人份克数）× 份数自动算量，按「必买 / 常备折叠 / 缺核心料」分组，支持勾选采购
- **菜品管理**：配料表（BOM）、做法步骤、餐别标签、辣度、难度、实拍图；菜品反馈随手记（偏咸、炖过头了…），提交后 AI 当场给出改动建议，逐条确认才落库
- **营养统计**：每个订单按 BOM 估算热量 / 三大营养素 / 钠，出趋势图；口径与《中国食物成分表》对齐
- **家庭成员**：头像区分身份（无账号体系，不做口令）；支持「忌口」标记
- **新菜建议池**：家人随口提的菜名先进建议池，确认后一键变成正式菜品（含 AI 辅助补齐配料表）
- **AI 助手（可选）**：首页右上角一个 AI 图标入口，说一句话由 AI 自动分流到「加菜」或「登记冰箱库存」；改菜不占入口，长在菜品反馈栏里。基于 DeepSeek（OpenAI 兼容接口），只产草稿、确认才落库；不配 key 则整体关闭、主流程零影响
- **推送通知**：新订单推送到手机，支持 Bark（iOS）/ Server酱（微信），失败静默降级
- **备份**：应用内每日 SQLite 一致性快照（WAL 安全），配 `deploy/backup.sh` 手动备份与恢复

## 技术栈

- 后端：Node.js（**≥22.5**，`node:sqlite` 自 22.5 内置；开发仓用 24，Docker 镜像基于 node:24）、Express、TypeScript、SSE 实时刷新
- 前端：React、Vite、PWA（可装到手机主屏幕、离线打开壳）
- 存储：SQLite 单文件（`data/mealtime.db`）+ 上传图片目录，结构化迁移内置于启动流程
- 部署：Docker（本地构建 + 瘦镜像）；可选 Tailscale 内网 HTTPS（见 `deploy/tailscale.md`）

## 快速开始（本地开发）

```bash
# 1. 安装依赖（npm workspaces，会同时装 web 与 server）
npm install

# 2. 导入预置数据：示意食材 + 3 道示意家常菜 + 2 位占位家庭成员
npm run seed

# 3. 同时启动前后端
npm run dev
#   前端  http://localhost:5173
#   后端  http://localhost:8787
```

想要有数据的图表（汇总页、趋势图）：

```bash
npm run seed:demo    # 生成最近 12 天演示订单，仅本地开发用
```

> 演示数据带护栏：**库里已有订单时会自动跳过**，不会累积假数据、也不会误污染生产库。
> 想重新生成就先删掉 `data/mealtime.db` 再 `npm run seed`。

装好后在「菜单」和「食材」页签里把示意菜换成自己家的菜谱即可——
种子只在空库时导入，不覆盖任何用户编辑。

## 配置（.env）

复制 `.env.example` 为 `.env`，常用项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 服务端口 |
| `DB_PATH` | `../data/mealtime.db` | SQLite 文件位置 |
| `TZ` | `Asia/Shanghai` | 时区，影响截单判断与日期归属 |
| `DEEPSEEK_API_KEY` | 空 | AI 助手开关：不填 = 功能整体关闭，前端隐藏入口 |
| `AI_MODEL` / `AI_BASE_URL` | DeepSeek 默认 | OpenAI 兼容格式，可换其他供应商 |
| `AI_ENABLED` | 空 | 置 `false` 可在保留 key 的前提下临时关掉入口 |
| `BARK_ALLOW_PRIVATE_HOSTS` | `false` | 默认拒绝自建 Bark 地址指向内网（防 SSRF），确有需要再开 |
| `TRUST_PROXY` | 空 | 反向代理（tailscale serve / nginx）后设置信任跳数，如 `1`；不设时所有请求共享代理 IP |

推送 key 不进环境变量：在应用「汇总 → 设置 → 通知」里填，存数据库。密钥只留在部署机的 `.env`，不进仓库。

## 部署（Docker）

`deploy/` 下提供一套「本地构建 + 瘦镜像」的 NAS 部署方案（`deploy-nas.sh`）：
本机构建前端产物与 server bundle → rsync 到 NAS → 在 NAS 上构建镜像并重建容器 → 健康检查。
数据库落在宿主机 `data/` 目录，容器重建不丢数据，`rsync` 永远排除 `data/`。

```bash
# ~/.ssh/config 里配好 NAS 主机别名后：
NAS_HOST=nas                          # SSH 主机别名
NAS_DIR=/opt/mealtime                 # NAS 上的安装目录（脚本会自动创建）
npm run deploy:nas
```

纯 Docker 方式（NAS 上执行）：

```bash
cd <安装目录>
docker compose -f deploy/docker-compose.yml up -d --build
```

环境变量（AI key 等）放在安装目录的 `.env`，compose 以 `env_file` 挂进容器。

### 外网访问（可选，不暴露公网）

用 Tailscale 内网 HTTPS：家人设备加入同一 tailnet，`tailscale serve` 反代 8787，
自动签发续期证书、支持 PWA 安装。完整步骤见 [`deploy/tailscale.md`](deploy/tailscale.md)。

## 备份与恢复

- **应用内（自动）**：每天产出一份 SQLite 一致性快照（`.backup` / `VACUUM INTO`，WAL 模式安全）到 `data/auto-backup/`，数据库与 `uploads/` 图片成对打包
- **手动**：`./deploy/backup.sh [db路径] [备份目录] [保留天数]`，一致性优先，**绝不裸拷 WAL 主库文件**
- **恢复**：停容器 → 还原 `.db` + 对应 `.uploads` → 启动（详见 `deploy/backup.sh` 头部注释）

## 核心设计

### 一切由「菜品配料表（BOM）」派生

每道菜维护一份每人份克数的配料表，采购清单、营养摄入、库存匹配全部由它计算。
食材分「必有 / 可选」（点缀收尾、爆香去腥算可选）与「常备调料」（`is_pantry`，采购清单默认折叠）。

### 订单行快照：历史口径只认「下单那一刻」

下单时把菜名、emoji、标签、营养、BOM 冻结进 `order_items` 快照；之后改菜、删菜都不影响
历史订单与统计口径，删除菜品也不产生悬空引用。

### 数据模型与迁移

所有 schema 变更走有序迁移（`server/src/db/migrations.ts`），启动时自动补齐；
预置数据（种子）只在空库导入或对空列回填，永不覆盖用户改过的行。

## 目录结构

```
web/                        React 前端（Vite + PWA）
server/
  src/
    routes/                 REST API（dishes / orders / purchase / analytics / …）
    services/               业务逻辑（订单、采购、营养、AI 助手…）
    db/
      migrations.ts         有序 schema 迁移
      seed/                 预置食材与示意菜谱（空库时导入）
  test/                     node:test 集成测试（30+ 文件）
deploy/
  Dockerfile                NAS 侧构建镜像
  docker-compose.yml        编排：数据卷 + env_file
  deploy-nas.sh             一键发布（rsync + 远端重建 + 健康检查）
  backup.sh                 SQLite 一致性备份
  tailscale.md              内网 HTTPS 接入指南
shared/types.ts             前后端共享类型
tools/                      图标源文件与 secret-scan 等仓库工具
PUBLIC-MANIFEST.txt         公开仓导出清单（逐文件哈希）
```

## 开发

```bash
npm run typecheck     # TS 全量检查
npm run lint          # ESLint
npm run test          # 前后端测试
npm run build:deploy  # 构建发布产物
```

## 安全说明

按「家庭内网 / Tailscale 私有网络」场景设计：

- 身份区分靠「选头像」，不做账号、口令与角色；仅适用于家庭内网 / Tailscale 私有网络
- 自建 Bark 推送地址默认拒绝 localhost / 内网目标（SSRF 防护）
- 上传图片校验 MIME 与尺寸；AI 接口有独立限流

请勿把实例直接暴露到公网。

## License

[MIT](LICENSE)
