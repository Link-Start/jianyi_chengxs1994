# 第三方组件

## Mediabunny 1.55.7

`vendor/mp4-mov.js` 包含由 Mediabunny 1.55.7 构建的代码，负责 MP4 / MOV 封装。该依赖使用 Mozilla Public License 2.0，不适用本项目的个人非商业使用与学习许可证；本项目的非商业限制不适用于该第三方组件本身。

- 完整许可证：[MPL 2.0](vendor/MEDIABUNNY-LICENSE.txt)
- 对应版本源码与包：<https://www.npmjs.com/package/mediabunny/v/1.55.7>
- 上游仓库：<https://github.com/Vanilagy/mediabunny>

本项目未修改 Mediabunny 源码。使用 `npm ci` 获取锁定版本，再运行 `npm run build:export` 可从 `export-mux.js` 重建浏览器 bundle。分发时保留第三方许可证与源码获取说明。

## esbuild 0.28.2

仅用于开发时构建 bundle，使用 MIT 许可：<https://github.com/evanw/esbuild>。依赖版本及完整性信息记录在 `package-lock.json`。
