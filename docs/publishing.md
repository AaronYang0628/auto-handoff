# GitHub Pages 发布

项目页面通过 `.github/workflows/pages.yml` 构建和发布，使用 GitHub 官方 Pages Actions，不需要个人访问令牌或第三方托管账号。

## 首次启用

仓库维护者在 GitHub 仓库中打开 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。本地生成工作流文件不会自动证明该仓库设置已经启用。

随后推送到 `main`，或在 Actions 中手动运行 **Build and deploy GitHub Pages**。

工作流依次：

1. 安装开发依赖，执行类型检查与测试
2. 运行 `npm run build:site`，构建到 `site-dist/`
3. 上传该目录作为 Pages artifact
4. 使用 `actions/deploy-pages` 发布到 `github-pages` 环境

只有发布任务拥有 `pages: write` 和 `id-token: write`；代码读取权限为 `contents: read`。上传范围只有网站产物，不包括源码工作区、会话记录或交接材料。

部署成功后，以工作流和 `github-pages` 环境显示的 URL 为准。工作流文件存在、构建成功与线上部署成功是三个不同状态。

## 本地预览

```bash
npm ci
npm run build:site
python3 -m http.server 8000 --directory site-dist
```

打开本机 `http://localhost:8000`。页面使用相对静态资源路径，可用于项目型 Pages 路径；浏览器中的复制按钮需要浏览器支持剪贴板 API。

若 `Configure Pages` 提示找不到站点或权限不足，先核对上述 Source 设置及仓库访问权限，不要把个人 token 写进仓库或工作流。

参考：[GitHub 官方自定义工作流说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
