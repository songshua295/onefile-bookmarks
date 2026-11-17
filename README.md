# 静态书签页面

以 JSON 节点数据为云端数据源(S3/WebDAV 上的 `bookmarks.json`),按**单个书签/文件夹**的粒度增量同步;浏览器导出的 Netscape 书签 HTML 可用于首次迁移与导入。页面不引入数据库,所有修改最终写回云端 JSON 文件。

## 功能

- **树形展示**:文件夹层级展开/折叠,收藏夹栏(工具栏文件夹)默认展开
- **搜索**:
  - 本地搜索:空格分隔**多关键字(AND)**,标题/路径/URL **模糊子序列匹配**,按相关度排序
  - **AI 搜索**:语义搜索,通过 OpenAI 兼容接口(OpenAI / DeepSeek / Moonshot / Ollama 等),服务端代理,Key 不暴露给前端
- **最近打开**:点击书签自动计数,顶栏按可用宽度显示最近打开的书签(宽度不够自动裁剪)
- **编辑**:重命名、改 URL、删除、文件夹间拖拽移动、添加书签/文件夹
  - 添加书签时可**浏览文件夹树或按关键字搜索选择目标文件夹**
  - 所有修改先保存在本地(IndexedDB),顶栏出现"● 未上传"徽标,点"⬆ 上传"增量推送到云端(只传有改动的书签)
  - **同步云端**:别的设备改过数据后,点顶栏"同步云端"强制拉取云端最新数据覆盖本地缓存(有未上传修改时会先询问)
  - **按条合并**:每条书签/文件夹有稳定 id 与时间戳,两台设备的改动(增删改/移动/改名)由服务端逐条 LWW 合并,互不相干的修改不会互相覆盖
- **拖到浏览器书签栏**:书签是真实的 `<a>` 链接,直接拖到浏览器书签栏即可
- **快速添加**:把页面顶栏的 **「📌 快速添加」** 拖到浏览器书签栏;之后在任何网页点击它,会把当前页面的标题和 URL 传给本页面,弹窗确认后加入收藏(配置 `AUTO_UPLOAD=true` 时保存后自动上传)

## 本地运行

```bash
npm install     # 安装 aws4fetch(仅 S3 签名需要)
npm run dev     # http://localhost:3000
```

未配置远程存储时页面自动回退为读取本地 `favorites_2026_9_20.html`(只读模式)。首次访问配置了远程存储的环境时,自动把旧 HTML(或本地缓存)迁移为云端 `bookmarks.json`。

## 存储 / 上传配置

支持 **S3**(含 Cloudflare R2、阿里云 OSS、MinIO 等兼容服务)与 **WebDAV**。本地用 `.env`,Vercel 在项目 Settings → Environment Variables 配置同名变量(参考 `.env.example`):

| 变量 | 说明 |
|---|---|
| `STORAGE_TYPE` | `s3` / `webdav` / `none` |
| `DATA_FILE` | 云端 JSON 数据文件名,默认 `bookmarks.json`(节点级增量同步的数据文件) |
| `UPLOAD_MODE` / `BOOKMARK_FILE` | 仅影响**旧版 HTML 数据**:首次访问自动迁移(读该文件建立 JSON),之后云端只读写 `DATA_FILE` |
| `AUTO_UPLOAD` | `true` 时快速添加保存后自动上传 |
| `S3_ENDPOINT` `S3_REGION` `S3_BUCKET` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | S3 配置。`S3_ENDPOINT` 两种风格都支持:virtual-hosted(`https://桶名.s3.xxx.com`,桶名写在域名里)和 path style(`https://s3.xxx.com`,桶名拼在路径里),程序会自动识别,不会重复拼接桶名 |
| `S3_PREFIX` | S3 bucket 内的保存文件夹(前缀),如 `bookmarks`,不填则存根目录 |
| `WEBDAV_URL` `WEBDAV_USERNAME` `WEBDAV_PASSWORD` | WebDAV 配置 |
| `AI_BASE_URL` `AI_API_KEY` `AI_MODEL` | AI 搜索配置(OpenAI 兼容),不配则 AI 按钮提示未配置 |

**dated 模式的读取规则**:始终取日期最新的文件 —— 优先读 `latest.json` 指针;指针缺失(如手动往桶里拷过文件)时自动扫描目录(S3 ListObjectsV2 / WebDAV PROPFIND),取文件名日期最大的 `favorites_YYYY_M_D.html`。上传时先写内容文件、成功后再更新指针。

## 部署到 Vercel

目录结构即 Vercel 约定:根目录为静态站,`api/` 下为 Serverless Functions(`/api/config`、`/api/bookmark`、`/api/ai`),无需额外配置,配好环境变量后直接部署。

```bash
npx vercel
```

## 数据流说明

数据存储为**解析后的 JSON 节点**(不再是整份 Netscape HTML),同步粒度是单个书签/文件夹:

1. **数据文件**:云端一份 `bookmarks.json`(S3/WebDAV),内容是扁平节点数组 —— 每条记录含稳定 UUID、父节点、排序、时间戳,删除以墓碑标记(30 天后清理)
2. **加载**:缓存优先 —— 本地 IndexedDB 缓存解析结果,首屏秒开;后台带 `If-None-Match` 请求 `/api/sync?since=<上次同步时间>`,云端未变化返回 304,有变化只返回**增量节点**,本地按 id 合并
3. **上传**:与上次同步的基线做 diff,只上传有改动的节点(ICON 等未变的属性不重复传输);服务端按条 LWW 合并,`If-Match` 条件写防并发覆盖;谱系(lineage)被另一端重置时自动换基线重传
4. **迁移**:首次访问发现云端没有 JSON 时,自动读取旧 HTML(或带未上传修改的本地缓存)建立首份 JSON,原 HTML 文件保留不动
5. **导入/导出**:「导出书签 HTML」在浏览器端把当前数据序列化成 Netscape 格式;「用本地文件覆盖云端」支持 HTML 与 JSON 两种来源,整份替换
6. **点击计数**:`bookmarks_meta.json`(与 JSON 数据同目录)按 URL 记录,上传时同时写入节点的 `CLICKS` 属性,两端取较大值

## 已知限制

- 浏览器书签栏拖入的链接是 `<a>` 原生拖拽,无需额外扩展
- 点击计数的"去重"以 URL 为键,同一书签改 URL 后计数重新开始
- AI 搜索返回的命中结果基于当前会话的节点 id,由服务端 LLM 语义匹配
