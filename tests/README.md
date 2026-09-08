# 草稿回归验证

需要 Node.js、Playwright 和桌面 Chrome。Playwright 可安装在独立测试目录，并通过 `NODE_PATH` 指向其 `node_modules`，无需改变运行依赖。

将 `DRAFT_TEST_ASSETS` 设置为包含以下测试素材的目录：

- `sample.mp4`：约 3 秒的 H.264 / AAC 视频。
- `blue.mp4`：约 3 秒的第二段视频，用于画中画和转场。
- `music.wav`：不短于 6 秒的音乐或测试音。
- `sticker.png`：图片贴纸。
- `animated.gif`：动态 GIF。

运行：

```sh
DRAFT_TEST_ASSETS=/path/to/test-media node tests/drafts.cjs
```

可选环境变量：`CHROME_PATH` 指定浏览器；`LIGHTCUT_URL` 指定部署网址（默认本项目 file://）；`DRAFT_TEST_FONT` 指定测试字体；`DRAFT_TEST_OUTPUT` 保存恢复后导出的 MP4。

测试使用独立浏览器上下文，不访问日常浏览器的草稿。覆盖素材和全部轨道刷新恢复、字体、转场缓存、自动保存、复制删除共享素材、重命名、存储失败、损坏素材和版本拒绝、并发写入冲突、恢复后导出及无引用素材清理。

文件夹模式测试需先运行本地静态服务器，再执行：

```sh
LIGHTCUT_URL=http://127.0.0.1:8836 DRAFT_TEST_ASSETS=/path/to/test-media node tests/draft-folder.cjs
```

该测试仅将系统目录选择器替换为测试专用 OPFS 目录，其余读写使用真实 File System Access API。覆盖保存恢复、句柄持久化、素材复用、版本冲突、清理范围、清单写入失败回滚、取消选择和存储位置切换。系统原生目录弹窗及实际磁盘权限仍需手动检查：选择空目录、授权、保存、刷新重新授权并打开，然后撤销权限确认失败提示。`DRAFT_FOLDER_SCREENSHOT` 可指定截图路径。
