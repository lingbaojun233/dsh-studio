# dsh-studio — 让 DSH 把一段想法做成真动画视频（manim）

想要一段讲解视频，又不想学剪辑和动画软件。给一个主题、一段稿子或一份分镜，DSH 自己写分镜、生成 manim 动画、配音、合成 mp4。

画面不是 AI 生成的像素，而是**可读、可改、可复现的 manim 脚本**渲染出来的：同样的分镜永远渲出同样的片子；用项目模式时每场片段都有缓存，改一句旁白不用重画整集。

> 这个仓库只是**客户端**。真正出片的是 studio 服务（默认 `127.0.0.1:8772`），它在 [DSH-MultiTool](https://github.com/lingbaojun233/DSH-MultiTool) 的 `studio/` 里，依赖 Python + manim + LaTeX + ffmpeg，还要有 speak（配音）和 io（写分镜）。

## 快速开始

### 1. 安装

```powershell
# 进入你的 DSH profile 目录（默认在 C:\Users\你\.dsh\profiles\desktop）
cd "$env:USERPROFILE\.dsh\profiles\desktop"   # 把 desktop 换成你的 profile 名

npm install https://github.com/lingbaojun233/dsh-studio/archive/refs/heads/main.tar.gz
```

约 2 秒装完，没有构建步骤、没有 npm 依赖。

### 2. 启用

`dependencies` 由 npm 自动写好，你只要把包名加进 `dsh.profile.bundles` 末尾：

```json
{
  "dependencies": {
    "dsh-studio": "https://github.com/lingbaojun233/dsh-studio/archive/refs/heads/main.tar.gz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "dsh-studio"
      ]
    }
  }
}
```

> 保留原有的其它 bundle 条目，只在最后追加。改完重启 DSH；headless 每次运行自动重新装配。

### 3. 验证

先确认服务就绪：

```powershell
curl.exe -s http://127.0.0.1:8772/v1/health
# {"ok":true,"width":1920,"height":1080,"fps":30,"ffmpeg":true,"font":true,"manim":true,"styles":3,...}
```

新开一个会话，先只让它写分镜（**不渲染，便宜、快**）：

> 用 `make_video` 做一个 15 秒的视频，主题：勾股定理，`plan_only:true`。

成功时返回分镜：标题、场次数、每场的 `text` / `narration` / `seconds`，以及这一场有没有 manim 代码（`scenes[].manim`）。

确认分镜没问题后，再说：

> 把「勾股定理」做成 15 秒的成片，这次不要 `plan_only`。

成功时返回 `jobId`、成片秒数、字节数，以及一句取片地址。**看到 `jobId` 和「成片已生成」就算成功**。

## 它提供哪些工具

| 工具 | 干什么 | 例子 |
|---|---|---|
| `gen_video` | 独立生成**一条 AI 片段**（wan3.0-video，人物/场景/动作/氛围）。慢（约 100 秒/条）、占额度，画不了公式图表 | 对 DSH 说「生成一段女生在雪原上飞的视频」 |
| `make_video` | 一个入口三种输入：`topic` 全自动 / `script` 写稿拆场 / `storyboard` 自己填分镜；`plan_only:true` 只出分镜 | 对 DSH 说「做一个 60 秒讲导数的视频」 |
| `project_create` | 建一个可编辑项目：每场渲成独立片段并缓存，之后只重画改动过的场 | 对 DSH 说「把这三场建成分镜项目，标题叫《导数》」 |
| `project_apply` | 给项目打补丁 / 渲染 / 查状态。`scope:"audio"` 只重做声音 | 对 DSH 说「把第 2 场台词改短，只重做声音」 |

### gen_video：AI 生成画面

```js
gen_video({
  prompt: "anime style, cel shading, wide shot, a girl flying over a snowy plain, wind blowing",
  seconds: 5
})
// → { ok:true, path:"…\\aivideo\\ai-xxxxxxxx.mp4", ms:124579, taskId:"…", bytes:22136672, seconds:5.04, width:1920, height:1080 }
```

- `prompt` **必须英文**：主体 + 动作 + 风格 + 镜头，≤120 字符；不要写公式、坐标轴、标题文字。
- 返回的片段是 **5 或 10 秒**（`seconds > 5` 就生成 10 秒），分辨率由 `size` 决定（默认 `1280*720`）。
- 实测量级：5 秒一条 **100~290 秒**（网关忙时更久），`timeoutMs` 给到 **480 秒**。
- 和 `make_video` 的分工：**人物/场景/氛围 → `gen_video`；公式/坐标/曲线/推导 → `make_video`（manim）**。
  一集里 `aivideo` 最多 4 场（studio 侧硬护栏，超了自动降级文字卡）。
- 密钥由 studio 从 `secrets/wan.key` 读（也接受 `secrets/qwen.key` / `video/secrets.json` 的 `apiKey`），
  插件自己**不碰密钥**。

### 三种创作模式

`topic` / `script` / `storyboard` **三选一**，给 0 个或 2 个都会直接返回 `CHOOSE_ONE_MODE`，不会乱猜。

**1）`topic`：全自动。** 给主题，它自己写分镜、生成动画、渲染。

```js
make_video({
  topic: "为什么一年有四季",
  seconds: 60,
  style: "whiteboard"
})
```

**2）`script`：写稿。** 你给稿子，它拆成 4~10 场，旁白尽量保留原话。适合先让 DSH 出分镜、你改稿，再渲染。

```js
make_video({
  script: "导数是变化率。先看一条曲线，在曲线上取两个点，连成割线。让第二个点一点点靠近第一个点，割线慢慢变成切线。切线斜率，就是这一点的导数。",
  seconds: 60,
  plan_only: true
})
```

**3）`storyboard`：分镜。** 每一场你自己填：画面上的标题、旁白、时长、画什么。`visual_hint` 会由 DSH 翻译成 manim 代码——这是控制力最强的方式。

```js
make_video({
  storyboard: [
    {
      text: "割线变切线",
      narration: "让两点越来越近，割线就慢慢变成了切线",
      seconds: 10,
      visual_hint: "画坐标轴和一条曲线，曲线上取两个点，连成割线；让第二个点逐渐靠近第一个点，割线变成切线",
      tool: "manim"
    },
    {
      text: "导数是斜率",
      narration: "切线斜率，就是这一点的导数",
      seconds: 6,
      tool: "text"
    }
  ],
  style: "oscilloscope-math"
})
```

通用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `seconds` | `60` | 目标总时长，8~900。成片会按旁白实际长度重算（旁白太长会把那场拉长） |
| `style` | `""` | `whiteboard` / `blueprint` / `oscilloscope-math`；**空 = 跟人设**（人设决定不了就用 `whiteboard`） |
| `voice` | `""` | 音色 id（`voc_xxx`）；空 = 跟人设 |
| `plan_only` | `false` | `true` 只出分镜，不渲染 |

三种风格长什么样：

| id | 名称 | 底色 | 主色 | 适合 |
|---|---|---|---|---|
| `whiteboard` | 白板讲解 | 米白 | 蓝 | 叙事、科普、轻松讲解 |
| `blueprint` | 工程蓝图 | 深蓝 | 浅蓝白 | 原理、结构、系统拆解 |
| `oscilloscope-math` | 示波器数学 | 近黑 | 荧光绿 | 数学、公式、物理 |

`style:""` 时由 studio 读人设关键词投票：讲到「数学/公式/导数」偏向示波器，「工程/系统/原理」偏向蓝图，「温柔/故事/陪伴」偏向白板。

## 依赖

**这不是装个 npm 包就能出片的插件**，studio 背后是一整条渲染链：

| 依赖 | 作用 | 怎么装 |
|---|---|---|
| studio 服务 | 编排、渲染、缓存（`8772`） | DSH-MultiTool 的 `studio/`，`node server.js` 或 `start-server.cmd` |
| io 服务 | studio 通过它调模型写分镜（`8765`） | DSH-MultiTool 的 `io/`；**io 不在，studio 就没法调模型写分镜** |
| speak 服务 | 合成旁白（`8770`） | 见 [dsh-speak](https://github.com/lingbaojun233/dsh-speak)；需要 BreezeBlue key |
| 记忆服务 | 提供人设，用来选音色/风格（`8767`） | 可选；挂了就用缓存或默认值 |
| Python 3.11 | 跑 manim（3.9+ 也可，实测 3.11） | `winget install Python.Python.3.11` |
| manim | 渲染真动画 | `python -m pip install manim` |
| LaTeX（MiKTeX） | `MathTex` 公式需要 | `winget install MiKTeX.MiKTeX` |
| ffmpeg | 合成片段、拼接、混音 | `winget install Gyan.FFmpeg` |

先把 studio 起起来（io / speak 也要在跑）：

```powershell
cd C:\Apps\DSH-MultiTool\studio
node server.js
# 或双击 start-server.cmd
```

> 服务端 `config.json` 里的 python / ffmpeg 路径默认按 `C:\Apps\DSH-MultiTool\` 布局写死；装在别处就改成你自己的路径。

装完逐个自检（**三条都要能跑**）：

```powershell
python -c "import manim; print(manim.__version__)"
latex --version
ffmpeg -version
```

> `GET /v1/health` 里的 `manim:true` 只代表「配置的 Python 路径存在」，**不代表 manim 包和 LaTeX 可用**。上面前两条才是准的。

首次渲染含 `MathTex` 的场次会慢一些（MiKTeX 首次约 25 秒，之后走缓存）。

**耗时参考**（实测，1920×1080@30）：3~5 场约 40~90 秒；60 秒 / 8 场全 manim ≈ **192 秒**，其中旁白串行约 30 秒、manim 约 143 秒、拼接混音约 20 秒。工具超时给到 2400 秒——**别因为等不及就重复调用，每一次重复都是再渲一遍**。

**配音失败整集失败**：所有旁白必须先全部合成成功，否则返回 `VOICE_UNAVAILABLE`（503），不会产出「一半有声音、一半没声音」的片子。

## 配置

插件没有 `config.json`，配置是**插件行的 `config` 字段**：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8772` | studio 服务根地址 |
| `videoUrl` | `http://127.0.0.1:8766` | **只用来拼取片地址** `${videoUrl}/api/studio/video?id=<jobId>`；插件不会去请求它 |

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_STUDIO_URL` | — | `baseUrl` 兜底 |
| `DSH_STUDIO_VIDEO_URL` | — | `videoUrl` 兜底 |

把 `videoUrl` 显式配成空串（`videoUrl: ''`）可以关掉「取回地址」那句提示——studio 和面板不在同一台机器、或没有面板时很有用。

服务在另一台机器：

```powershell
$env:DSH_STUDIO_URL = "http://192.168.1.20:8772"
$env:DSH_STUDIO_VIDEO_URL = "http://192.168.1.20:8766"
```

或写进 profile 的 `cordis.patch.yml`（`config` 整体替换，字段要写全）：

```yaml
- id: dsh-studio
  config:
    baseUrl: 'http://192.168.1.20:8772'
    videoUrl: ''
```

服务端自己的关键配置在 `studio/config.json`：`python`（Python 路径）、`ffmpeg`、`outDir`、`speakUrl`、`ioUrl`、`personaUrl`、`defaultStyle`、`manimQuality`。路径不对时，`/v1/health` 会给出 `ffmpeg:false` / `font:false` / `manim:false`。

## 常见问题

### 1. 返回 `UNREACHABLE`

studio 没起或地址不对：

```powershell
curl.exe -s http://127.0.0.1:8772/v1/health
```

有 JSON 就说明服务活着，问题在 `baseUrl`；连不上就先起 `studio/server.js`。

### 2. 分镜能写出来，但一渲染就失败

按阶段看返回里的 `stage`：

- `stage: "storyboard"`：写分镜/生成 manim 代码失败——多半是 io 不在，或模型没按 JSON 回；
- `stage: "render"`：渲染失败——看 `error`，常见是 `SCENE_CLIP_FAILED`（ffmpeg/字体）、`CONCAT_FAILED`（拼接）、`AUDIO_FAILED`（混音）。单场 manim 脚本出错时，那一场通常会降级成文字卡，不会拖垮整片。

`plan_only:true` 先跑一遍，能提前暴露分镜和 manim 代码的问题，不用等渲染。

### 3. 返回 `VOICE_UNAVAILABLE`

配音没拿到，**整集主动失败**，这是设计：宁可不出片，也不出一半音色不一致的片子。通常是：

- BreezeBlue key 没配 / 额度用完 / 401；
- 并发被占满，`QUEUE_TIMEOUT`；
- speak 服务没起。

```powershell
curl.exe -s http://127.0.0.1:8770/v1/usage
```

返回里会带 `speakError` 和 `attempts`（重试了几次），按 speak 的报错处理。等一会儿再重试，不要立刻连续重试。

### 4. 渲染很慢 / 超时 / 一次出来两版片子

60 秒 8 场 ≈ 3 分钟是 manim 的固有成本，不是卡住。建议：

- 先用 `plan_only:true` 改分镜，满意了再渲染；
- 改一句台词用 `project_apply { id, scope:"audio" }`，只重做声音，不重画；
- 改某一场用 `patches` + `scope:"auto"`，只重画改过的场；
- **不要重复调用 `make_video`**——每次都是真渲染，会多出成片。

### 5. 公式渲染失败 / 第一次特别慢

`MathTex` 需要 LaTeX。确认 `latex --version` 能跑、MiKTeX 在 PATH 里。首次渲染时 MiKTeX 会按需装宏包（约 25 秒），之后走缓存就快了。

### 6. 整片几乎全是文字卡，没有动画

manim 代码没生成出来，或被安全闸门拒了（只允许 `manim`/`numpy` import、≤60 行、禁止文件/网络/exec 等）。先用 `plan_only:true` 看 `stats.manim` 和 `scenes[].manim`；把 `visual_hint` 写得更具体（画什么图形、什么动作、先后顺序），命中的概率会高很多。

### 7. 取片地址 404

`videoUrl` 默认指向面板（`8766`），那个服务没起、或路径不对，链接就打不开。studio 自己只写文件：成片在 `outDir` 下的 `<jobId>.mp4`，也可以直接去那里拿。不想看到这句提示就把 `videoUrl` 设为 `''`。

## 实现说明

- 单文件 `index.js`（约 720 行），零依赖。HTTP 用 `node:http` 而不是 `fetch`：Node 的 undici 有一条 300 秒的 headers 超时，长片渲染会被它误杀。
- 三种输入最终汇到同一条流水线：**分镜 JSON → 逐场生成 manim 脚本 → 逐场渲染成 mp4（缓存）→ xfade 串联 + 旁白 + BGM → 成片**。
- 画面只有两条路：`manim`（真动画，默认占 ≥80% 场次）和 `text`（渐变底 + 一行大字，用于开场/转场/结论）。
- 三层缓存：旁白按（文本, 音色）、片段按（引擎, 素材, 时长, 风格, 分辨率）、拼接按（片段列表, 时长, fps）。所以 `scope:"audio"` 可以秒级出片，改一句只重合成那一句。
- 项目数据在服务端：`data/studio/projects/`（分镜与缓存索引）、`outDir`（成片 mp4）、`bgm/`（背景音乐）。`jobId` 就是本机的一个文件名，换一台 studio 取不到旧片。
- 风格是 `styles/*.json` 里的一份配置（配色/线宽/字体/节奏），注入是确定性的：颜色常量替换、背景色注入、字重/字体覆盖。加风格只要加一个 JSON，不用改渲染代码。
- 失败一律结构化：`{ ok:false, stage, error, hint?, speakError?, attempts? }`，模型能分清是分镜、配音还是渲染出的问题。

## License

MIT © 2026 lingbaojun233
