# 剪易 EasyCut CLI（试用版）

只需要 Node.js 18.3 或更高版本，无需安装 npm 依赖、Python 或 ffprobe。普通网页用户仍无需安装 Node.js。

CLI 创建网页可直接打开的本地草稿，暂不渲染视频、读取真实媒体时长、追加或覆盖已有草稿。网页调优和导出仍使用现有功能。

## 使用

在项目目录运行，先复制 `cli/example.json` 到自己的工作目录，修改其中的素材路径及时间：

```sh
node cli/jianyi.mjs validate /绝对路径/edit.json
node cli/jianyi.mjs create /绝对路径/edit.json --output /绝对路径/作品一
node cli/jianyi.mjs list /绝对路径/作品一
node cli/jianyi.mjs inspect /绝对路径/作品一 --draft 草稿ID
```

`create` 会建立 `作品一/jianyi-drafts/project-index.json` 和 `assets/`，复制所需素材，同一个真实路径只复制一次。已有 `jianyi-drafts` 时拒绝写入；再次生成请换一个输出目录。路径包含空格时加引号。输出参数相对于命令执行目录，素材路径相对于 JSON 所在目录。

打开剪易 →「草稿」→「选择本地草稿文件夹」→ 选择 **作品一**（不是内部的 jianyi-drafts）→ 点击生成的草稿。预览、修改后确认顶部显示「已保存 · 文件夹」。备份整个 `jianyi-drafts` 目录。

`list` 返回 ID 等摘要，`inspect` 只读返回最新完整内部草稿快照，便于 AI 检查网页调优结果。它不是可直接传给 create 的用户配置；当前版本不提供增量修改或配置反向转换。读取前请先在网页保存。

## 配置约定

顶层 `version: 1`、`name`、非空 `videos` 必填；可选 `ratio`（original/16:9/9:16/1:1）、`volume`（0–200，默认 100）、`texts`、`audio`、`stickers`。拒绝未知字段、无效数值、空文件和不存在的路径。每组最多 1000 项。

| 对象 | 参数及默认值 |
| --- | --- |
| videos | `file` 必填；`in` 默认 0；`out` 必填且大于 in。按数组顺序连续拼接。 |
| effect | 视频项内的 `{kind, strength}`；strength 为 0–1，默认 1。 |
| transition | 视频项内的 `{kind, duration}`；从第二段开始可用，表示该片段开头转场；duration 默认 0.5 秒，不超过该片段长度。 |
| texts | `text`、`end` 必填；`start` 默认 0；`size` 默认 100，范围 20–1000；`position` 默认 0.82，表示纵向位置；支持多段文字。 |
| audio | `file`、`end` 必填；`in`（素材起点）、`start`（作品起点）默认 0；`volume` 为 0–200，默认 100。 |
| stickers | 图片/GIF/视频的 `file`、`end` 必填；`start` 默认 0；视频可设素材 `in`，默认 0；`x/y` 为 0–1，默认 0.72/0.28；`size` 默认 0.3（范围 0.01–2），为画布相对宽度；`opacity` 为 0–1，默认 1。视频画中画静音。 |

叠加轨道的 start/end 均是**作品时间**，必须在拼接后的总时长内，且 end > start。视频的 in/out 是**原素材时间**。转场与当前网页一致，不扣减总时长。

文字另支持 `color`、`strokeColor`、`bgColor`（#RRGGBB）；`bold`、`outline` 默认 true，`background` 默认 false；`strokeWidth` 默认 4（0–30）；`align` 为 left/center/right，默认 center；`offsetX/offsetY` 为 -1–1 的画布相对偏移，默认 0。第一版使用通用 sans-serif 字体，可在网页继续选择样式和字体。

特效 kind：none、grayscale、sepia、blur、vignette、warm、cool、vivid、shake、pulse、pixelate。

转场 kind：none、black、white、dissolve、wipe-left、wipe-right、wipe-up、wipe-down、circle、zoom-fade。

实际转场时长沿用网页规则，会进一步限制为前一片段时长与当前片段一半时长之内。

素材扩展名：视频 mp4/mov/webm/m4v；音频 mp3/wav/m4a/aac/ogg/flac；图片 png/jpg/jpeg/webp/gif。扩展名支持不代表浏览器一定可以解码相应编码。

## 检查边界

validate 只检查配置和文件，不解码，也不创建输出目录。请明确填写 out/end，不支持自动使用整段视频。如果超出素材真实时长或编码无法解码，网页会拒绝恢复并保留当前作品。修正配置并生成到新目录后再打开。

视频未知完整时长时，草稿裁剪上界暂设为配置 out；网页里可以继续缩短，但不能直接向后延长超过该值。需要更多素材范围时修改配置 out 并重新生成。首个列表封面为空，打开并保存后生成封面。

所有命令成功向 stdout 输出 JSON，失败向 stderr 输出 JSON 并返回非零退出码。素材复制失败时删除本次新建的专用目录，不影响原始素材或既有草稿；进程被强制终止可能留下不完整目录，重新运行请使用新的输出目录。

运行不需要安装测试工具的检查：

```sh
node --check cli/jianyi.mjs
node --check cli/project.mjs
node --test cli/project.test.mjs
```
