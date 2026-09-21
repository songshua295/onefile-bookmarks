# 静态书签页面

以浏览器导出的 Netscape 书签 HTML 文件(如 `favorites_2026_9_20.html`)为**唯一数据源**,提供一个静态书签管理页面。页面不引入数据库,所有修改最终仍写回书签 HTML 文件。

## 功能

- **树形展示**:文件夹层级展开/折叠,收藏夹栏(工具栏文件夹)默认展开
- **搜索**:
  - 本地搜索:空格分隔**多关键字(AND)**,标题/路径/URL **模糊子序列匹配**,按相关度排序
  - **AI 搜索**:语义搜索,通过 OpenAI 兼容接口(OpenAI / DeepSeek / Moonshot / Ollama 等),服务端代理,Key 不暴露给前端
- **最近打开**:点击书签自动计数,顶栏按可用宽度显示最近打开的书签(宽度不够自动裁剪)
- **编辑**:重命名、改 URL、删除、文件夹间拖拽移动、添加书签/文件夹
  - 添加书签时可**浏览文件夹树或按关键字搜索选择目标文件夹**
  - 所有修改先保存在本地(localStorage),顶栏出现"● 未上传"徽标,点"⬆ 上传"才推送到远程
- **拖到浏览器书签栏**:书签是真实的 `<a>` 链接,直接拖到浏览器书签栏即可
- **快速添加**:把页面顶栏的 **「📌 快速添加」** 拖到浏览器书签栏;之后在任何网页点击它,会把当前页面的标题和 URL 传给本页面,弹窗确认后加入收藏(配置 `AUTO_UPLOAD=true` 时保存后自动上传)

## 本地运行

```bash
npm install     # 安装 aws4fetch(仅 S3 签名需要)
npm run dev     # http://localhost:3000
```

未配置远程存储时页面自动回退为读取本地 `favorites_2026_9_20.html`(只读模式)。

## 存储 / 上传配置

支持 **S3**(含 Cloudflare R2、阿里云 OSS、MinIO 等兼容服务)与 **WebDAV**。本地用 `.env`,Vercel 在项目 Settings → Environment Variables 配置同名变量(参考 `.env.example`):

| 变量 | 说明 |
|---|---|
| `STORAGE_TYPE` | `s3` / `webdav` / `none` |
| `UPLOAD_MODE` | `overwrite` 覆盖原文件;`dated` 生成带日期后缀新文件(如 `favorites_2026_9_20.html`)并维护 `latest.json` 指针 |
| `BOOKMARK_FILE` | 数据文件名,默认 `favorites_2026_9_20.html` |
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

1. **加载**:优先从远程(S3/WebDAV)拉取书签文件;无存储配置时读取本地文件
2. **缓存**:解析结果与远程内容指纹(ETag)存入 localStorage,内容未变时秒开;存在未上传修改时,刷新后仍显示本地版本并提示"远程文件已有更新"
3. **点击计数**:`bookmarks_meta.json`(与书签文件同目录存储,localStorage 同步缓存),点"⬆ 上传"时一并上传
4. **上传**:把当前树序列化回 Netscape 书签 HTML(完整保留 ICON 图标、添加日期等属性),按 `UPLOAD_MODE` 覆盖或加日期后缀写入

## 已知限制

- 浏览器书签栏拖入的链接是 `<a>` 原生拖拽,无需额外扩展
- 点击计数的"去重"以 URL 为键,同一书签改 URL 后计数重新开始
- AI 搜索返回的命中结果基于当前会话的节点 id,由服务端 LLM 语义匹配
