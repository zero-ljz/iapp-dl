# iapp-dl

通用下载分发服务：固定入口、外部 URL 跳转、本地文件和极简目录索引。

一个 Node.js 项目，同时支持自有服务器和 Cloudflare Workers。使用 Hono 的标准
Request/Response 接口共用路由逻辑；只有启动入口和静态文件读取方式不同。
只维护一份 `routes.json`，无需 KV、数据库或管理接口。

请求处理顺序：先按完整路径查映射，命中返回 302；否则读取 `public/` 中对应文件；
目录请求生成索引页；均不存在则返回 404。软件、模型及其他资源共用这套逻辑，
不要求目标平台遵循任何命名规则。仅支持 GET、HEAD，`/_iapp-dl/health` 为健康检查。

## 文件与配置

```text
iapp-dl/
  routes.json               # 唯一的资源映射配置，不公开
  public/                   # 唯一的静态资源目录
    snapneo/stable/windows-x64.json
    snapneo/models/formula/本地模型.zip
  src/                      # 服务代码，不公开
  deploy/                   # Nginx/systemd 示例，不公开
  wrangler.jsonc            # Worker 配置，不公开
```

`public/` 内的普通文件可被公开下载，不能放秘密或源代码。项目目录本身不会被当作静态目录。
首页及各级目录提供类似 Debian 镜像站的纯 HTML 索引，目录优先排列，显示名称、
修改时间（UTC）和大小，并提供返回父目录的链接。不自动使用 `index.html` 替代目录索引；
它仍可通过完整路径下载。隐藏路径和符号链接不会出现在索引中，也不可下载。
Node 的文件响应支持 HEAD 和单段 Range，使用流式读取，不会把大文件完整载入内存。
Worker 将 Range 交给 ASSETS，保留平台原生响应；平台可能返回完整的 200 响应，
因此不能保证 Worker 静态文件支持断点续传。外部资源由目标平台处理 Range。

开始时 `routes.json` 为空，所有普通请求都访问 `public/`。例如：
`/snapneo/stable/windows-x64.json` 对应 `public/snapneo/stable/windows-x64.json`。
准备好外部资源后再添加映射，以下 URL 仅为示例：

```json
{
  "schema": 1,
  "routes": {
    "/snapneo/models/formula/model-v1.zip": "https://cnb.cool/ORG/REPO/-/releases/download/model-v1/model-v1.zip",
    "/another-app/releases/2.0/setup.exe": "https://downloads.example.com/arbitrary/setup.exe"
  }
}
```

键使用解码后的完整路径，中文和空格不需要百分号编码。映射不匹配查询参数，也不把用户的
查询参数拼接到目标 URL；目标自身的查询参数会保留。目标必须是 HTTPS URL，不含用户名、
密码或片段。使用平台的固定下载入口，避免保存短期有效的签名 URL。

同一路径有映射和本地文件时，映射优先。删除映射后会恢复本地文件下载。
索引自动合并两者：上述映射会生成 `/snapneo/models/formula/` 等可浏览目录，
外部资源的大小和修改时间显示为 `-`，点击后仍通过自有域名路径返回 302。
索引不向外部服务器请求元数据。添加映射即表示公开该资源的入口路径。
同一个版本路径应始终返回相同字节；更新内容时换新版本路径，以兼容客户端 SHA256 校验。
文件、跳转和错误响应均设置 `Cache-Control: no-store`，以便后续切换；前置 CDN 不应覆盖它。

## Node.js 运行

要求 Node.js 22.12+，推荐 Node.js 24 LTS。在此项目目录执行：

```sh
npm ci
npm run check:config
npm start
```

默认监听 `127.0.0.1:8787`。配置文件和 `public/` 始终相对于项目定位，不依赖启动目录。
可使用 `npm start -- --host 0.0.0.0 --port 8787 --reload-ms 1000` 调整监听与重载间隔。

每秒检查 `routes.json`，有效的新配置一次性替换旧映射，无需重启 Node 或 Nginx。
无效 JSON、上传未完成或文件暂时丢失时，记录错误并继续使用最后一次正确配置。
首次启动时配置错误会直接退出。建议先写临时文件，校验后用重命名替换配置。

服务器可把整个项目放到 `/opt/iapp-dl`，将原静态站的**公开文件**复制到 `public/`。
安装运行依赖可用 `npm ci --omit=dev`，不需要 Wrangler。
`deploy/nginx.conf` 提供一个统一的反向代理规则；HTTPS、证书与域名沿用原站配置。
不要把 Nginx 的站点根目录指向本项目根目录。

`deploy/iapp-dl.service` 是 Linux systemd 示例。部署时创建 `iapp-dl` 系统用户，
给予项目、配置及公开文件读取权限，并根据实际安装位置调整 Node 路径。
配置及资源由部署用户维护，服务进程只需读权限。

## Cloudflare Worker 运行与迁移

同一个项目目录执行：

```sh
npm ci
npm run dev:worker
npm run build:worker
```

`dev:worker` 使用本地 Worker 运行时；`build:worker` 只打包和检查，不发布。
准备好 Cloudflare 账户后使用：

```sh
npx wrangler login
npm run deploy:worker
```

Wrangler 自动打包 `src/worker-entry.js`、共享代码和同一份 `routes.json`，上传 `public/`
作为 ASSETS 静态资源。Node 入口和项目配置不会成为公开静态文件。
`run_worker_first` 保证映射优先于同路径静态文件；未命中映射才调用 ASSETS。
在 Cloudflare 中绑定自有域名后再切换 DNS/入口；单独运行部署命令不会接管现有域名。

Worker 的配置随部署固定。修改映射或本地公开文件后重新运行 `deploy:worker` 即可，
无需同步 KV。可以将这条命令接入自己的发布流程，配置修改后自动发布。
切回自有服务器也使用同一份 `routes.json` 和 `public/`。
Node 的目录索引实时读取文件；Worker 在启动开发环境、构建或部署时自动扫描 `public/`，
生成内部目录信息 `build/asset-index.json`，并打包进 Worker。该文件不公开、不提交 Git，
也不需要手动维护。Worker 本地开发期间添加或删除文件后需重新运行 `dev:worker`。

Cloudflare 静态资源目前单文件上限为 25 MiB，发布检查会提前拒绝超限文件和符号链接。
因此约 55 MB 的公式模型和大型安装包应在迁移前改为外部 URL 映射，并将其文件移出 `public/`；
Node 自托管没有这项 25 MiB 限制。目标存储平台自己的容量、流量和访问限制仍适用。
迁移时需要完整携带 `public/`；其中的资源默认不提交 Git，Git 仓库不会自动备份这些文件。
GitHub 自动检查仅运行测试和构建，不会发布服务或上传这些资源。

## SnapNeo 接入边界

当前公式下载器可以跟随 HTTPS 302，并保留 Range 和 SHA256 校验。
当前软件更新器会拒绝跨域跳转；在完成客户端下载策略调整与旧版升级安排前，
更新安装包仍应使用自有域名下的真实文件，不能立即添加指向 CNB 的安装包映射。
本工具不修改应用的更新信任策略，也不生成或修改签名更新索引。

## 验证

```sh
npm test
npm run build:worker
```

覆盖真实 Node HTTP 请求、配置自动重载、错误配置保留、映射优先、Range、HEAD、
公开目录边界、隐藏文件、符号链接、目录索引、外部资源目录、HTML 转义，
以及 Worker 的 ASSETS 转交行为。
