# Personal AI Workbench 项目管理模块设计

日期：2026-09-01

## 目标

在 Personal AI Workbench 中增加一个本机单用户的项目执行模块，让用户把项目、任务和知识库资料连接起来。首期提供项目总览、看板、列表、Backlog、任务详情、筛选、标签、文档关联和活动记录，同时保持现有的本地优先、回环地址和公开数据边界。

本设计借鉴 Kaneo 的轻量项目管理流程，但不引入 Kaneo 的多人账户、权限、PostgreSQL、Redis、对象存储或外部通知体系。

## 范围

首期包含：

- 多项目创建、编辑、排序和归档。
- 每个项目自定义状态列；新项目默认包含“待办”“进行中”“已完成”。
- Board、List 和 Backlog 三种视图。
- 任务创建、编辑、移动、排序和归档。
- 任务标题、Markdown 描述、优先级、开始日期、截止日期和项目内稳定编号。
- 全局标签及任务标签关联。
- 任务与现有 Vault 文档的关联。
- 任务活动记录。
- 关键词、状态、优先级、日期和标签筛选。

首期不包含：负责人、评论、附件、工时、Calendar、Gantt、登录、成员权限、多人实时同步、GitHub/Gitea、Webhook、外部通知和项目 MCP 工具。

## 产品行为

### 项目总览

本机版侧边栏增加“项目”入口，路由为 `/projects`。公开托管版本不显示入口，也不注册可变更项目数据的本地接口。

项目总览展示活跃项目、完成比例、逾期任务数、进行中任务数和最近活动。归档项目从默认列表隐藏，可通过筛选查看和恢复。

### 项目视图

项目页面路由为 `/projects/:projectId`，默认打开 Board。页面内提供 Board、List 和 Backlog 视图切换，视图选择保存在浏览器本地偏好中，不写入项目数据。

Board 按状态列展示未归档任务。用户可以在同一列内排序，也可以拖动到其他列。一次移动请求同时提交目标列和目标位置，服务端重新计算受影响列的连续位置。

List 以密集表格显示任务编号、标题、状态、优先级、标签、开始日期和截止日期。Backlog 显示尚未进入状态列的任务；把 Backlog 任务移入状态列即进入执行流程。

### 任务详情

点击任务打开详情抽屉，保持当前项目视图上下文。用户可以编辑标题、Markdown 描述、优先级、日期、标签和关联文档。字段修改必须经过服务端确认；保存失败时保留用户输入并展示错误。

任务编号在项目内递增，创建后不复用、不改变，例如 `PAW-23`。项目缩写由项目创建时生成并允许编辑，必须在当前数据文件内唯一。

### 筛选

Board、List 和 Backlog 共用筛选模型：关键词、状态、优先级、截止日期范围和标签。多个筛选条件之间使用 AND，同一标签条件内使用 OR。筛选只影响展示，不改变任务数据。

## 数据模型

所有记录使用 UUID。日期时间存储为 ISO 8601 UTC 字符串；纯日期字段存储为 `YYYY-MM-DD`。

### Project

- `id`
- `key`：项目缩写，唯一，用于任务编号展示
- `name`
- `description`
- `position`
- `lastTaskNumber`
- `archivedAt`
- `createdAt`
- `updatedAt`

### Column

- `id`
- `projectId`
- `name`
- `color`
- `position`
- `isFinal`
- `createdAt`
- `updatedAt`

### Task

- `id`
- `projectId`
- `columnId`：`null` 表示 Backlog
- `number`
- `title`
- `description`
- `priority`：`none | low | medium | high | urgent`
- `startDate`
- `dueDate`
- `position`
- `archivedAt`
- `createdAt`
- `updatedAt`

任务状态只以 `columnId` 表示，不额外保存容易漂移的状态字符串。

### Label

- `id`
- `name`
- `color`
- `createdAt`
- `updatedAt`

标签名称在规范化大小写和空白后唯一。

### TaskLabel

- `taskId`
- `labelId`

### TaskLink

- `id`
- `taskId`
- `documentId`
- `relativePath`
- `kind`
- `createdAt`

关联仅保存 Vault 相对路径和文档 ID，不复制文档内容。读取时若文档已移动或删除，返回失效状态但保留关联记录，供用户修复或移除。

### Activity

- `id`
- `projectId`
- `taskId`
- `type`
- `data`
- `createdAt`

首期记录任务创建、字段修改、移动、标签变化、文档关联和归档。`data` 只保存结构化差异，不保存完整 Vault 文档内容。

## 存储

真实项目状态默认保存到：

`%LOCALAPPDATA%/PersonalAIWorkbench/<vault-id>/projects.json`

`vault-id` 是规范化 Vault 绝对路径的 SHA-256 摘要，不暴露本地路径。存储文件包含 `version`、`updatedAt` 和各实体集合。首版 schema 版本为 `1`。

项目仓库执行以下保护：

- Zod schema 校验和字段长度、集合数量、文件大小限制。
- 所有修改在进程内串行执行。
- 写入临时文件、刷新文件句柄并原子替换正式文件。
- 写入前后验证目标目录不是符号链接且仍位于预期应用数据根目录。
- 数据损坏、未知版本或超过容量限制时拒绝修改，不覆盖原文件。
- 存储文件缺失时返回空数据，不自动创建演示项目。

用户以后可以显式选择把状态放入仓库外部的个人 Vault。公开仓库的默认演示 Vault 不接收真实项目数据；如新增演示项目，必须完全合成并在文件和界面中标注。

## 模块与接口

### ProjectRepository 模块

服务端新增一个深模块，集中保存数据校验、不变量、排序、活动记录和原子写入。页面与路由不读取存储文件。

主要接口：

- `getWorkspace()`：返回项目总览所需的完整轻量快照。
- `getProject(projectId)`：返回项目、列、任务、标签关联和活动摘要。
- `createProject(input)`、`updateProject(id, patch)`、`archiveProject(id)`。
- `createColumn(input)`、`updateColumn(id, patch)`、`reorderColumns(projectId, orderedIds)`。
- `createTask(input)`、`updateTask(id, patch)`、`moveTask(command)`、`archiveTask(id)`。
- `setTaskLabels(taskId, labelIds)`。
- `addTaskLink(taskId, document)`、`removeTaskLink(linkId)`。

`moveTask` 接受任务 ID、目标列 ID 或 `null`、目标索引和调用方看到的项目修订号。修订号过期时返回冲突，前端重新加载，而不是覆盖较新的排序。

### HTTP 路由

本地 Vite 中间层把 `/api/projects/*` 委托给独立项目路由模块。路由负责 HTTP 解析、状态码和错误映射；业务不变量由 ProjectRepository 负责。

所有 POST、PATCH、DELETE 请求继续执行现有的同源、JSON Content-Type 和本机修改检查。托管构建和只读 profile 返回不可变更错误。

建议端点：

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`
- `POST /api/projects/:projectId/archive`
- `POST /api/projects/:projectId/columns`
- `PUT /api/projects/:projectId/columns/order`
- `POST /api/projects/:projectId/tasks`
- `PATCH /api/tasks/:taskId`
- `POST /api/tasks/:taskId/move`
- `POST /api/tasks/:taskId/archive`
- `PUT /api/tasks/:taskId/labels`
- `POST /api/tasks/:taskId/links`
- `DELETE /api/task-links/:linkId`

### 前端模块

- `ProjectsPage`：项目总览。
- `ProjectPage`：加载项目并管理视图与筛选状态。
- `ProjectBoard`、`ProjectList`、`ProjectBacklog`：三种投影视图，共用同一任务快照。
- `TaskDrawer`：任务详情编辑和 Vault 文档关联。
- `project-api`：封装请求、错误归一化和返回 schema。
- `project-model`：纯函数形式的筛选、排序和展示派生逻辑。

拖拽首选 `@dnd-kit/core` 与 `@dnd-kit/sortable`，只为 Board 加入这两项依赖。键盘拖拽必须可用；窄屏下同时提供“移动到”菜单作为可靠替代。

## 数据流

1. 页面加载项目快照和修订号。
2. 用户编辑字段或移动任务。
3. 前端显示待保存状态并发送单个命令。
4. 路由验证 HTTP 请求并调用 ProjectRepository。
5. ProjectRepository 验证归属关系和修订号，执行修改，追加活动记录并原子写入。
6. 服务端返回新的项目修订号和受影响实体。
7. 前端以服务端结果更新本地快照。

首期不使用 WebSocket。页面自身的修改直接使用响应结果；重新聚焦页面或 Vault 同步修订变化时可重新加载项目。单用户本机模型无需 Redis 或通用实时广播。

## 不变量

- Project key 在当前项目存储内唯一。
- Task number 在项目内唯一且只递增。
- Column 和 Task 的 `projectId` 必须一致。
- Backlog 任务的 `columnId` 必须为 `null`。
- 非 Backlog 任务必须引用现存且属于同一项目的列。
- 每个活跃项目至少保留一个非最终列；不能删除仍含活跃任务的列。
- 同一项目内的项目、列和任务位置由仓库规范化为连续整数。
- `startDate` 晚于 `dueDate` 时拒绝保存。
- TaskLink 必须来自当前 Vault 索引允许返回的文档。
- 归档不物理删除记录；完成率只统计未归档任务，并以 `isFinal` 列判断完成。

## 错误处理

服务端错误包含稳定的 `code`、中文 `message` 和可选 `details`。主要错误包括输入无效、记录不存在、归属关系错误、修订冲突、只读模式、非本机请求、存储损坏和容量超限。

拖拽和快速编辑采用可回滚的待保存状态。发生修订冲突时前端重新加载并提示“项目已更新，请重试”。存储损坏时页面进入只读错误状态，提供数据文件位置但不自动修复或覆盖。

## 隐私与安全

- 服务继续默认只监听 `127.0.0.1`。
- 公开托管版本不暴露项目管理入口或本地修改接口。
- 不把真实项目、任务、评论、附件或本地路径加入公开仓库。
- 演示数据必须完全合成并显著标注。
- TaskLink 不允许绝对路径、父目录跳转或未被 Vault 索引接受的路径。
- 活动记录不保存完整文档内容或敏感请求头。

## 测试与验收

服务端测试覆盖：

- 空存储初始化、schema 校验、版本拒绝和损坏文件保护。
- 项目、列、任务、标签和文档关联的创建与修改。
- 项目内任务编号只递增。
- 同列排序、跨列移动、Backlog 进出和位置规范化。
- 非法跨项目引用、过期修订、日期错误和列删除约束。
- 并发修改串行化、临时文件清理和原子替换。
- 本机同源保护、JSON 请求要求、只读和托管模式。

前端测试覆盖：

- 项目入口与三种视图切换。
- 筛选组合及逾期判断。
- 任务创建、编辑、归档和详情抽屉。
- 拖拽成功、失败回滚、键盘移动和窄屏移动菜单。
- Vault 文档搜索、关联、失效关联展示和打开文档。

验收行为：用户可以创建项目和任务，把任务从 Backlog 移入看板，在列间排序，通过列表筛选逾期任务，关联并打开 Vault 文档，重启服务后数据仍存在。任何真实数据不会写入公开仓库。

完成实现后运行：

```bash
cd Workbench
npm test
npm run build
npm run privacy:scan
```

三项发布门禁必须全部通过。

## 后续扩展

核心流程稳定后，可以依次增加 Calendar、任务关系、工时、Markdown 评论、项目复盘和项目 MCP 工具。只有出现明确的多人协作需求时，才引入登录、权限、实时同步、外部通知或独立数据库。
