# dsh-studio

把 **studio（视频创作模块，默认 `127.0.0.1:8772`）** 暴露成 DSH 原生工具：
模型不用再自己 `curl`，工具表里直接有 `make_video`（`plan_only:true` 时只出分镜）、
`project_create` 和 `project_apply`（长片项目）。

## 它做什么，不做什么

```text
prompt ──► DSH 写分镜（每场：画面大字 / 旁白 / 时长 / 两色渐变）
        ──► ffmpeg 逐场出静帧、慢推成片段、xfade 串联、混旁白和 BGM
        ──► mp4（jobId）
```

- **模型不生成任何像素。** 它只写可读、可改、可复现的分镜 JSON；画面是 ffmpeg 画的。
- 同样的分镜永远渲出同样的片子；改一句旁白只需要重跑，不用"重画"全片。
- `make_video` **一次调用就会真的渲染**：实测 15~40 秒，工具超时给到 1200 秒。
  不要因为等不及就重复调用 —— 每一次重复都是再渲一遍，还会多出一份成片。
- 想先给人看分镜，传 `plan_only:true`：只写分镜、不渲染，便宜且可以反复调。

## 依赖

| 依赖 | 说明 |
| --- | --- |
| studio 服务 | 默认 `http://127.0.0.1:8772`，`GET /v1/health` 能回 `{ok:true,...}` 即可 |
| ffmpeg / 字体 / TTS | 由 studio 自己配置，本插件不碰 |
| Node.js | **>= 18**（需要全局 `fetch`；ESM） |
| npm 依赖 | **零** |

studio 必须自己起得来（它内部还要访问 io 写分镜、speak 合成旁白）。本插件只做 HTTP 转发。

## 安装

1. 先确认后端活着：

   ```powershell
   curl.exe -s http://127.0.0.1:8772/v1/health
   # {"ok":true,"width":1920,"height":1080,"fps":30,"ffmpeg":true,"font":true,...}
   ```

2. 在 DSH 里安装本目录：**插件 → 添加插件 → 选择这个仓库目录**。
   本地目录是"链接"安装（不是拷贝），改完 `index.js` 重载插件即可生效。

3. 新开一个会话，工具表里应出现 `make_video` / `project_create` / `project_apply`。
   插件详情页的标题和描述来自 `locale/en.json`、`locale/zh.json`。

## 配置

`cordis.patch.yml` 里的默认值：

```yaml
- insert:
    - id: dsh-studio
      name: 'dsh-studio'
      config:
        baseUrl: 'http://127.0.0.1:8772'
        videoUrl: 'http://127.0.0.1:8766'
```

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8772` | studio 服务地址；`DSH_STUDIO_URL` 兜底 |
| `videoUrl` | `http://127.0.0.1:8766` | **只用来拼取片地址**：`${videoUrl}/v1/video?id=<jobId>`，插件不会去请求它；`DSH_STUDIO_VIDEO_URL` 兜底 |

优先级：**插件配置 > 环境变量 > 默认值**。
`videoUrl` 显式配置成空串（`videoUrl: ''`）可以关掉"取回地址"那句提示 ——
适合 studio 和取片服务不在同一台机器、或者根本不想暴露取片服务的场景。

studio 在别的机器上：

```yaml
config:
  baseUrl: 'http://192.168.1.20:8772'
  videoUrl: 'http://192.168.1.20:8766'
```

## 工具

### `make_video`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 视频主题，一两句话 |
| `seconds` | integer | 否 | 目标总时长，8~30，默认 12（越界会被收敛） |
| `plan_only` | boolean | 否 | `true` 时只写分镜、不渲染（走 `/v1/plan`） |
| `voice` | string | 否 | TTS 音色，透传给 speak 模块 |
| `bgm` | string | 否 | studio BGM 目录里的文件名 |

返回：

```json
{
  "ok": true,
  "jobId": "0b6f0b52-7d5f-4e3c-9c4d-2b1a8f5e6c11",
  "title": "海边日落",
  "seconds": 12.4,
  "scenes": [
    { "text": "日落之前", "seconds": 3, "narration": "太阳快落下了" },
    { "text": "风起", "seconds": 4, "narration": "海风开始变凉" }
  ],
  "bytes": 987654,
  "ms": 22345
}
```

- `seconds` 是**成片总长**（studio 会按旁白实际长度重算；旁白太长会把那一场拉长）。
- `scenes[].seconds` 是**分镜计划时长**，两者对不上是正常的（还有 xfade 重叠转场）。
- 返回里**没有** `plan` 全量结构，也**没有**服务器本地文件路径：前者占 token，
  后者跨机没有意义，模型要做的是把 `jobId` 交给取片地址。

### `make_video { plan_only: true }`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 视频主题 |
| `seconds` | integer | 否 | 目标总时长，8~30，默认 12 |

`plan_only:true` 时走 `POST /v1/plan`，返回 `{ ok, title, seconds, scenes:[{text, seconds, narration}] }`，**不产生 mp4**。
文本输出会明确写"这只是分镜，还没有渲染"，避免模型把它当成成片。

## 行为细节

- 所有失败都是结构化结果，不抛异常：`{ ok:false, stage:'plan'|'create', error, raw? }`。
  `stage` 优先用 studio 返回的 `step`，这样"写分镜失败"和"ffmpeg 失败"分得清。
- `seconds` 在插件侧先收敛到 8~30，studio 内部还会按 `maxTotalSeconds` 再封一次顶。
- 渲染超时 1200 秒；`plan_only` 240 秒（studio 自己等 io 最多 180 秒）。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `UNREACHABLE` | studio 没起、`baseUrl` 写错、或被防火墙挡住。先 `curl /v1/health` |
| `TIMEOUT` | 渲染超过 1200 秒：视频太长、ffmpeg 卡住、TTS 卡住。看 studio 日志 |
| `PROMPT_REQUIRED` | 传了空 prompt |
| `PLAN_NOT_JSON` | studio 那侧的模型没按 JSON 回分镜。`raw` 里有原文；确认 io 正常、重试一次 |
| `HTTP 404` | `baseUrl` 指到了别的服务（studio 的路由是 `/v1/plan`、`/v1/create`） |
| `SCENE_STILL_FAILED` / `SCENE_CLIP_FAILED` | ffmpeg 或字体路径有问题，看 studio 日志 |
| `CONCAT_FAILED` / `AUDIO_FAILED` | 拼接/混音失败，通常是 BGM 文件或旁白 WAV |
| 取片地址 404 | `videoUrl` 指错，或那个服务没有 `/v1/video` 路由 |
| 成片比 `scenes` 时长之和短 | xfade 是重叠转场，4 场 × 3 秒会少 3 次 0.4 秒 |
| 一次对话出来两版片子 | 模型重复调用了 `make_video`。描述里给了耗时（15~40 秒）；宿主别自动重试 —— 一次调用就是一次真渲染 |

## 公开使用时的坑

- **工具名很通用**：`make_video` / `project_apply` 容易和别的视频插件撞名。同一个 profile 里只装一个。
- **没有鉴权**：studio 只监听回环，不要把它直接暴露到公网；要跨机就加反向代理和鉴权。
- **`jobId` 不是全局资源**：它就是 studio 输出目录里的 `<jobId>.mp4`。换一台 studio 就取不到旧片。
- **宿主自己的超时**：插件等 1200 秒，但宿主可能更早掐断工具调用。装之前先确认宿主上限。
- **分镜由谁写**：studio 通过 io 调模型写分镜。io 挂了，`plan_only` / `make_video` 都会在 `stage:plan` 失败。
- 插件只返回 mp4 的信息，不生成封面、字幕文件或缩略图。

## 自检

```powershell
node --check index.js
node test/verify.mjs
```

`test/verify.mjs` 会起一个本地桩服务（模拟 `/v1/plan`、`/v1/create`），
注入假的 `ctx.tools.register`，逐个调用工具并断言参数透传和返回值摘要 ——
**不会真渲染**，所以改插件时可以随手跑。

## License

MIT，见 [LICENSE](./LICENSE)。
