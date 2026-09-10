# 剪易 EasyCut CLI（试用版）

只需要 Node.js 18.3 或更高版本，无需安装 npm 依赖、Python 或 ffprobe。普通网页用户仍无需安装 Node.js。

CLI 创建网页可直接打开的本地草稿，支持向同一草稿库追加作品，暂不渲染视频、读取真实媒体时长或覆盖已有草稿。网页调优和导出仍使用现有功能。

## 使用

在项目目录运行，先复制 `cli/example.json` 到自己的工作目录，修改其中的素材路径及时间：

```sh
node cli/jianyi.mjs create /绝对路径/edit.json
node cli/jianyi.mjs create /绝对路径/edit.json --open
node cli/jianyi.mjs open --draft 草稿ID
node cli/jianyi.mjs list
node cli/jianyi.mjs inspect --draft 草稿ID
```

默认草稿库为当前用户主目录下的 `EasyCut`（macOS 示例：`/Users/你的用户名/EasyCut`），不随终端目录改变。每次生成独立 ID，允许同名作品；连续或并发执行五次，会在同一库显示五份草稿。`--output /其他目录` 可指定其他草稿库，重复指定也是追加。

加 `--open` 会启动本地编辑服务并在默认浏览器直接打开新草稿，无需再选择文件夹。已有草稿用 `open --draft 草稿ID`；只运行 `open` 展示默认库的草稿列表。其他库用 `open /草稿库目录 --draft 草稿ID`（传 EasyCut 这一层父目录）。网页修改保存回启动时的同一个库。

**保持终端运行，结束前确认网页显示「已保存」，再按 Ctrl+C 停止。** 服务使用随机端口，仅监听本机 127.0.0.1，通过临时会话令牌连接；不会上传到外网。`--no-browser` 可配合 `open`、`create --open` 或 `update --open`，只输出编辑地址、不启动浏览器。`--json` 输出中的 `url` 可供工具打开；服务命令会持续运行，不应等待其退出才读取结果。

同库仅允许一个编辑服务。服务运行时请使用它打开的窗口；普通网页的文件夹写入会被库锁阻止。CLI 仍可继续向库追加草稿，网页点「刷新列表」即可看到。服务停止后可重新运行 open；强制结束可能留下 `.editor-server.lock`，确认原服务已停止后才能手动删除。服务模式暂不提供素材清理，可停止后通过普通网页清理。

不使用 --open 时，也可打开最新版剪易 →「草稿」→「打开本地草稿」→ 选择 `EasyCut` 或内部 `jianyi-drafts` → 点击作品。这种方式仍需浏览器目录授权。

普通网页仍默认使用浏览器草稿；CLI open 打开的页面固定连接指定库。Skill 不会自动读取普通网页的目录选择。两边使用不同目录时，草稿独立存储，不自动同步。需要共用时选择相同目录，或在 create 中用 `--output` 指定网页正在使用的草稿库。旧草稿目录不会自动迁入默认库。

库内主清单保存网页编辑记录，`cli-drafts/<ID>/` 保存独立发布的草稿和素材。CLI 完成复制后原子发布整个包，不改写主清单；网页合并显示，并记录已处理 ID，删除作品不会重新出现。旧网页不识别新包，请使用最新版页面，备份整个 jianyi-drafts。

单次生成的重复素材路径会去重，不同 CLI 任务暂不跨作品去重。普通网页文件夹模式首次保存会将素材写入公共 assets，旧包可通过「清理未引用素材」释放；本地服务模式沿用包内素材，仅新素材写入 assets。未发布的 `.pending-*` 不参与列表；强制终止可能遗留，需要确认没有任务后手动清理。初始化锁超时有提示，不自动抢占其他进程的锁。

支持多个 CLI 并发新增及与新版网页保存并行；不承诺不同浏览器同时编辑同一草稿。


`list` 返回 ID 等摘要，`inspect` 只读返回最新完整内部草稿快照，便于 AI 检查网页调优结果。它不是可直接传给 create 的用户配置；读取前请先在网页保存。

## 修改已有草稿

```sh
node cli/jianyi.mjs inspect --draft 草稿ID --json
node cli/jianyi.mjs update changes.json --draft 草稿ID --open --json
```

其他源库使用 `--library /草稿库父目录`；输出默认在源库中，`--output /其他目录` 可另选输出库。始终创建独立副本，原稿不变；下一轮修改使用副本 ID。网页未保存的编辑不会被读取。

修改 JSON 必填 `version: 1`、`revision`（inspect 返回的版本号），可选 `name`，默认原名加“修改版”。版本冲突需要重新 inspect；副本基于读取到的版本，不持续跟随原稿后续变化。

| 字段 | 支持修改的内容 |
| --- | --- |
| volume | 全片原声，0–200 |
| ratio | original / 16:9 / 9:16 / 1:1 |
| clips | 数组，每项含现有片段 `id`，可改 `in/out`，须在素材 lower / upper 边界内 |
| texts | 数组，每项含现有文字 `id`，可改 `text`（最多200字符）、`size`（20–1000）、`color`（#RRGGBB）、`position`（0–1）、`offsetX/offsetY`（-1–1）、`start/end` |
| audio | 数组，每项含现有音频 `id`，可改 `volume`（0–200）、`in`、`start/end` |
| stickers | 数组，每项含现有贴纸 `id`，可改 `x/y`（0–1）、`size`（0.01–2）、`opacity`（0–1）、`start/end`；视频画中画另支持 `in` |

片段 ID 从 inspect 对应数组读取，不使用数组序号，同组不能重复 ID。只填写要修改的字段；未指定的字体、样式、特效和转场保留。音频输入音量是百分比，而 inspect 内部 audio.volume 使用 0–2 的比例值。

in/out 为素材秒数，start/end 为作品秒数。主轨调整后连续拼接，叠加轨保持绝对时间；超出新结尾的内容裁短，完全位于结尾之后的内容从副本移除，warnings 列出调整。音频和视频画中画只能在原片段已知素材范围内裁剪或移动，不自动探测并扩展素材长度。

第一版不提供新增素材、分割、删除或重排指令，不覆盖原稿。副本复制引用的素材，会增加磁盘占用；缺失素材、非法参数或未知 ID 会拒绝发布。`--open` 与 create 用法相同；同库已有编辑服务时，在原窗口刷新草稿列表打开副本。

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

命令默认输出简短提示；加 `--json` 时成功向 stdout 输出 JSON，失败向 stderr 输出 JSON 并返回非零退出码。inspect 默认仍输出完整 JSON 快照。create 内置校验，通常不用先执行 validate；只检查不生成时可单独运行 validate。复制失败只删除本次未发布的包，不影响旧草稿，可在同一库重试。

运行不需要安装测试工具的检查：

```sh
node --check cli/jianyi.mjs
node --check cli/project.mjs
node --test cli/*.test.mjs
```
