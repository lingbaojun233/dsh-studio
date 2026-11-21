# dsh-studio

把 **studio（视频创作模块，默认 `127.0.0.1:8772`）** 暴露成 DSH 原生工具：
模型不用再自己 `curl`，工具表里直接有 `make_video` —— **一个入口，三种输入**：
`topic`（全自动）/ `script`（写稿拆场）/ `storyboard`（自己填分镜，`visual_hint` 翻译成 manim 代码）。
另有 `project_create` / `project_apply` 管长片项目。

## 它做什么，不做什么

```text
topic / script / storyboard
  ──► DSH 写分镜（每场：画面大字 / 旁白 / 时长 / 画什么）
  ──► 逐场把「画什么」写成 manim 脚本，ffmpeg 合成片段并缓存
  ──► xfade 串联、混旁白和 BGM ──► mp4（jobId）
```

- **模型不生成任何像素。** 它只写可读、可改、可复现的分镜与 manim 脚本。
- 同样的分镜永远渲出同样的片子；改一句旁白只需要重跑，画面片段可以复用。
- 音色、配色、旁白的口气都跟**人设**走：`style` / `voice` 留空就是"跟人设"。
- `make_video` **不加 `plan_only` 就会真的渲染**：3~5 场实测 40~90 秒，工具超时给到 2400 秒。
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
| `videoUrl` | `http://127.0.0.1:8766` | **只用来拼取片地址**：`${videoUrl}/api/studio/video?id=<jobId>`，插件不会去请求它；`DSH_STUDIO_VIDEO_URL` 兜底 |

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

### `make_video`（一个入口，三种输入，三选一）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `topic` | string | 三选一 | 全自动：给主题，它自己写分镜并渲染 |
| `script` | string | 三选一 | 写稿：一段稿子拆成 4~10 场，旁白尽量用原话 |
| `storyboard` | array | 三选一 | 分镜：每项 `{text, narration, seconds, visual_hint, tool}` |
| `seconds` | integer | 否 | 目标总时长 8~900，默认 60 |
| `style` | string | 否 | 风格 id（`whiteboard` / `blueprint` / `oscilloscope-math`）；空 = 跟人设 |
| `voice` | string | 否 | 音色（`voc_xxx` / `yaoyao`）；空 = 跟人设 |
| `plan_only` | boolean | 否 | `true` 时只出分镜，不渲染 |
| `bgm` | string | 否 | studio BGM 目录里的文件名（仅项目工具） |

> `topic` / `script` / `storyboard` **只能给一个**，给 0 个或 2 个都直接返回
> `CHOOSE_ONE_MODE`，不会发任何请求。

三个例子（工具描述里也写了，模型靠它决定怎么填）：

```js
// 1) 全自动
make_video({ topic: "导数是什么", seconds: 60, plan_only: true })

// 2) 写稿：稿子原话被拆成 4~10 场，先只看分镜
make_video({ script: "导数是变化率。先看一条曲线……", seconds: 60, plan_only: true })

// 3) 分镜：visual_hint 会被翻译成 manim 代码
make_video({
  storyboard: [
    { text: "割线变切线", narration: "让两点越来越近", seconds: 10,
      visual_hint: "画坐标轴、曲线上两个点，连线，然后让点靠近变成切线", tool: "manim" },
    { text: "小结", narration: "导数就是变化率", seconds: 5, tool: "text" },
  ],
})
```

返回（渲染成功）：

```json
{
  "ok": true,
  "mode": "storyboard",
  "projectId": "p-2aa7fd6f",
  "jobId": "cb9d1f2e-c424-4968-9f0a-9039469a76cf",
  "title": "导数：割线变切线",
  "seconds": 22.2,
  "scenes": [
    { "index": 0, "text": "割线变切线", "narration": "让两点越来越近", "seconds": 10, "manim": true, "manim_chars": 2272 },
    { "index": 2, "text": "小结", "narration": "导数就是变化率", "seconds": 5, "tool": "text", "manim": false }
  ],
  "stats": { "total": 3, "manim": 2, "text": 1, "fallback": 0, "manimRatio": 67 },
  "bytes": 421847,
  "ms": 41681
}
```

- `seconds` 是**成片总长**（studio 会按旁白实际长度重算；旁白太长会把那一场拉长）。
- `scenes[].manim` 表示这一场有没有生成 manim 代码；`manim_head` 是代码前两行，够模型判断有没有画。
- 返回里**没有**全量 manim 代码：占 token，且模型不需要重发它。
- 取片地址是 `${videoUrl}/api/studio/video?id=<jobId>`。

`plan_only:true` 时：
- `storyboard` 模式会先生成 manim 代码再返回（`scenes[].manim=true`），但**不渲染**；
- `script` 模式只拆场（不含动画代码），适合先给人改稿；
- `topic` 模式走 `/v1/plan`，同样只出分镜。

## 行为细节

- 所有失败都是结构化结果，不抛异常：`{ ok:false, stage:'storyboard'|'render'|..., error, hint?, speakError?, attempts? }`。
- 配音失败会原样带回 `speakError`（`BREEZEBLUE_UNAVAILABLE` / `QUEUE_TIMEOUT`）和 `attempts`，
  模型才能解释"配音服务不可用、已重试 N 次"，而不是只说一句失败。
- `seconds` 在插件侧先收敛到 8~900，studio 内部还会按 `maxTotalSeconds` 再封一次顶。
- 超时预算：拆场 300 秒、逐场写代码 900 秒、渲染 1200 秒；单次工具调用上限 2400 秒。

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
| 取片地址 404 | `videoUrl` 指错，或那个服务没有 `/api/studio/video` 路由 |
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
