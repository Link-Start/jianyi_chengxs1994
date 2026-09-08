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
