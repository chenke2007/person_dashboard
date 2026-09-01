# Personal AI Workbench

一个本地优先、直接读取 Obsidian 风格 Markdown Vault 的个人 AI 工作台。本目录只保存应用代码；示例知识库位于旁边的 `../个人知识库/`。

Workbench 提供可复用的读取、索引和可视化能力，不包含任何作者的个人知识、账号数据、登录态或历史运行记录。仓库级 `个人知识库/` 是完全虚构的演示 Vault，用于展示素材阅读、Wiki、知识星图、灵感、内容与抖音数据页面。

## 当前公开范围

已包含：

- 本地 Vault 总览与实时索引
- Wiki 列表与知识星图
- 素材阅读、书架、笔记与本地搜索
- 每日热点（AI HOT 公共匿名 API）
- 社媒洞察的本地只读展示
- 灵感库与内容中心
- 抖音数据面板及完整数据模板

暂不公开展示：

- Brainstorm 执行功能
- `90_runs/` 运行档案
- 微信公众号账号面板

这些模块在原始个人实例中依赖特定 Skill、私有策略或账号数据，不能被包装成开箱即用的公共能力。

## 快速开始

环境要求：Node.js 22 或更新版本。

```bash
npm install
npm run dev
```

默认读取 `../个人知识库/`。浏览器打开终端输出中的本地地址即可查看演示。

### 连接自己的 Vault

复制环境变量示例并填写绝对路径：

```bash
cp .env.example .env
```

```text
PERSONAL_DASHBOARD_VAULT_ROOT=/absolute/path/to/your-vault
```

重启开发服务器后生效。建议先备份自己的 Vault；公开版默认仍只监听 `127.0.0.1`。

### 已有 Obsidian / DBA 资料库（只读）

在本地 `.env` 中设置真实 Vault 绝对路径，并增加：

```dotenv
PERSONAL_DASHBOARD_PROFILE=obsidian
PERSONAL_DASHBOARD_READ_ONLY=true
```

此模式直接读取原文件，不搬迁、不复制知识库到本仓库，也不混入演示库。`wiki/` 下的 Markdown 均进入知识列表和星图；`.raw/`、根目录以及其他非插件目录的资料进入“DBA 资料与脚本”。页面中的“原始资料”“其他文档”是虚拟分类，文档路径、链接和下载仍指向原文件。

- SQL、Shell、Python、PowerShell、Markdown、TXT 等可全文搜索和纯文本阅读；支持 UTF-8、带 BOM 的 UTF-16、GB18030 中文文本。
- Word `.doc/.docx`、文本型 PDF、Excel 在本机提取文字，不执行脚本、宏或公式。提取保留文本，不保证原排版。扫描 PDF 不自动做 OCR。
- 普通文本读取上限为 8 MiB，Office/PDF 文件上限为 64 MiB；提取文本最多保留 8 Mi 字符。超限、无文字、损坏/加密及不支持的格式保留文件名索引并提示限制。原文件下载上限为 64 MiB，压缩包不自动解压。
- 排除插件说明与源码目录、隐藏配置（`.raw/` 除外）、依赖/缓存、二进制程序、私钥、凭据文件及终端/数据库连接会话配置。不会将这些文件暴露到搜索或下载接口。
- 只读模式阻止笔记保存、待看写入、Wiki 入库、AI 工作流和本地程序启动；浏览不会创建知识库状态目录。正文中的外部图片不自动加载。
- 文件变化会自动重新索引。首次扫描在服务就绪前完成；丢失或不可访问的 Vault 会报错，不会回退到演示数据。

Windows 启动：在本目录运行 `npm run dev`。构建脚本包含 POSIX 环境变量语法，可从 Git Bash 执行 `npm run build`。

### 知识库助手：问答与确认入库

在本机 `.env` 中设置 `WORKBENCH_KNOWLEDGE_CHAT=true` 开启助手；设置 `WORKBENCH_KNOWLEDGE_CREATE=true` 允许用户确认后新建 Wiki 文档。保留 `PERSONAL_DASHBOARD_READ_ONLY=true`，不要为了问答开启其他写入或执行接口。

模型连接采用 Anthropic Messages 兼容网关。可以显式配置 `WORKBENCH_KNOWLEDGE_BASE_URL`、`WORKBENCH_KNOWLEDGE_MODEL`、`WORKBENCH_KNOWLEDGE_API_KEY`；也可以设置 `WORKBENCH_KNOWLEDGE_USE_CLAUDE_SETTINGS=true`，授权后端读取本机 Claude 配置中的网关地址、令牌和模型名。不会加载其 hooks、工具权限或系统提示词。凭据不发送给前端、不复制到本仓库。

1. 点击左侧“知识库助手”，或打开 `/?assistant=1`。
2. 在“知识问答”模式提问；可用“@文件”选资料，或在阅读器点击“加入问答”。助手可多轮搜索和读取，并提供可点击的原文引用。
3. 切换“整理入库”，描述需要的知识文档。草稿可继续修改，点击“预览保存内容”查看最终 Markdown、来源和路径，再点“确认入库”。
4. 只允许在 `wiki/concepts`、`wiki/references`、`wiki/questions` 新建 Markdown。同名文件不覆盖，原始资料、脚本、索引/日志 Markdown 均不修改。来源变化、草稿变更或预览超过 30 分钟需要重新审核。

模型仅有搜索/读取工具，没有命令执行和文件写入工具。确认入库是独立的服务器动作。相关片段、问题和有限历史会发送到配置的模型服务，因此不是完全离线推理；HTTP 网关会提示未加密传输。现有路径过滤不保证识别正文中所有敏感信息，发送前请检查生产凭据。

聊天和草稿在系统用户应用数据目录 `PersonalAIWorkbench/<vault-id>/chat` 中保存，不在 Vault 或项目仓库。每次问答限 8 个附加文件、8 轮模型调用、16 次工具调用、64,000 字符资料，超时 180 秒。超限、失败或取消明确提示，不伪造成功或自动入库。点击“停止”可中止生成；收起面板不会停止。

服务重启后，未结束的回答显示中断状态并保留已持久化的部分内容。已写完文件但保存回执失败时，恢复会话后可“恢复核验 / 预览”，再确认恢复保存状态；必须仍是原文件、原内容和原来源，不会覆盖或重复创建。关闭确认入库开关不影响编辑、预览草稿。

传输格式参考 [Claude 流式消息](https://platform.claude.com/docs/en/build-with-claude/streaming) 和 [工具定义](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)。此功能仅在本地服务可用，不发布到静态托管版本。

### 本地项目管理

本地服务的“项目”模块提供项目总览、看板、列表、Backlog、任务筛选、拖拽排序、任务详情、标签、截止日期和活动记录。任务可以关联 Vault 中已索引的文档；关联只保存文档标识和 Vault 相对路径，不复制正文。文档被移动或删除后，任务详情会把关联标为失效并允许移除。

项目数据保存在系统用户应用数据目录 `PersonalAIWorkbench/<vault-id>/projects/projects.json`，不写入 Vault，也不进入 Git 仓库。写入采用修订号冲突保护和原子替换。项目 API 只接受同源、回环地址的本地请求；只读模式会拒绝修改。静态托管构建不显示项目导航和项目路由。

不要把真实项目、客户名称、内部任务、私人 Vault 路径或导出的项目数据加入这个公开仓库。测试和文档只能使用明确标记的虚构数据。

## 建议的 Vault 结构

```text
your-vault/
├── 10_raw/                 # 原始材料
├── 30_self_media/douyin/   # 可选：抖音固定数据层
├── 40_topics/ideas/        # 灵感
├── 50_scripts/             # 内容成果
└── wiki/
    ├── concepts/           # 概念
    └── frameworks/         # 框架
```

Workbench 可以索引其他文件，但示例版只承诺上述公开结构。不存在的字段不会被虚构为 `0`。

## 默认策略与个人覆盖

每日热点使用 `config/attention.default.json` 中的中性默认关注域。要定制时：

```bash
cp config/attention.local.example.json config/attention.local.json
```

修改 `attention.local.json` 后重启服务器。这个文件已被 Git 忽略，适合保存个人关注词；不要把私人客户名、项目名或内部策略提交到公共仓库。

## 抖音数据

- 可运行演示：`../个人知识库/30_self_media/douyin/current.json`
- 字段模板：`templates/douyin/current.template.json`
- 契约说明：`templates/douyin/README.md`

所有示例标题、账号指标、作品 ID 和时间序列均为人工虚构，并在数据中标记 `demoMode: true`。

演示数据覆盖账号 30 日趋势、作品月度分布、合集、累计快照、小时生命周期、留存、跳出、涨粉、流量来源、搜索词和受众维度。需要重新生成时执行：

```bash
npm run demo:generate
```

## 隐私边界

公开前请执行：

```bash
npm run privacy:scan
```

扫描不会代替人工审核。还需要检查 Git 历史、图片、录屏、测试夹具、构建产物和本地配置。详细清单见 [公开边界说明](docs/public-release-boundaries.md)。

## 许可证

代码许可证尚未由版权所有者确认。在明确选择许可证之前，不应把仓库对外宣称为已完成法律意义上的开源发行。
