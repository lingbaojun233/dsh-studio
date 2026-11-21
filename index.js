/**
 * dsh-studio —— 把 studio 模块（视频创作，默认 8772 端口）注册成 DSH 原生工具。
 *
 * 为什么要这一层：studio 的 /v1/create 只是个普通 HTTP 接口。模型看到"8772 上有个服务"时
 * 不会主动去 curl，而是继续用 ls/find 翻文件；注册成工具后，它和 bash/fs 一样出现在工具表里，
 * 才会真的被调用。
 *
 * 这个仓库刻意完全独立：只 import Node 内置模块，用全局 fetch，不 import 主项目任何文件，
 * 所以任何 DSH profile 都能单独 clone + 安装。
 */

export const name = 'dsh-studio';
export const inject = ['tools'];

const DEFAULT_BASE_URL = 'http://127.0.0.1:8772';
const DEFAULT_VIDEO_URL = 'http://127.0.0.1:8766';

// 渲染慢：写分镜要等一次模型，ffmpeg 再出片，实测 15~40 秒，长视频更久。
// 超时给到 20 分钟：宁可等，也不要让模型看到"超时"后重试 —— 一次重试就是重渲一遍。
const CREATE_TIMEOUT_MS = 1200 * 1000;
// 只写分镜也要过一次模型（studio 自己等 io 最多 180 秒），所以给 4 分钟而不是 30 秒。
const PLAN_TIMEOUT_MS = 240 * 1000;

/** 去掉结尾斜杠：否则 baseUrl 以 / 结尾时会拼出 //v1/create。 */
function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 所有 HTTP 一律走这里，返回 { status, data }，永不抛异常。
 * 为什么吞异常：工具失败应该变成模型看得懂的结构化结果（ok:false + 原因），
 * 而不是一段堆栈 —— 堆栈对模型没有信息量，宿主还会把这次调用记成"崩了"。
 */
/**
 * 请求头。
 * 关键一条：把当前用户 id 带给 studio。studio 需要替模型去调 io 写分镜，
 * 而插件运行在 DSH 进程里，没有用户 token；带上 x-dsh-user 后，studio 可以用
 * 内部令牌 + 这个 id 完成鉴权（踩过：不带就是 E_UNAUTHORIZED）。
 */
function headersFor(body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const uid = Number(process.env.DSH_USER_ID || 0);
  if (Number.isInteger(uid) && uid > 0) headers['x-dsh-user'] = String(uid);
  const sessionId = String(process.env.DSH_SESSION_ID || '').trim();
  if (sessionId) headers['x-dsh-session'] = sessionId;
  return headers;
}

async function requestJson(method, url, { body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: headersFor(body),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      // 服务异常时可能返回 HTML 或纯文本，包一层，调用方仍然有 error 可看
      return { status: res.status, data: { ok: false, error: text.slice(0, 800) } };
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return {
        status: 0,
        data: { ok: false, error: 'TIMEOUT', message: `请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回` },
      };
    }
    return { status: 0, data: { ok: false, error: 'UNREACHABLE', message: String((err && err.message) || err) } };
  } finally {
    clearTimeout(timer);
  }
}

function textBlock(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

/** 秒数收敛到 8~30。schema 已经限制了范围，但模型可能绕过 schema，服务端也另有自己的上下限。 */
function clampSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 12;
  return Math.min(30, Math.max(8, n));
}

/**
 * 把整份 plan 摘成 {text, seconds, narration}。
 * 为什么不直接返回 plan：scene 里还有 bg/textSize/image/motion/narrationMs/actualSeconds，
 * 全塞给模型既占 token 又没信息量；它真正需要的是"每场说什么、多长"。
 * 注意 seconds 是分镜计划时长；旁白更长时成片会变长，真实总长看顶层 seconds。
 */
function summarizeScenes(plan) {
  const scenes = plan && Array.isArray(plan.scenes) ? plan.scenes : [];
  return scenes.map((s) => ({
    text: String((s && s.text) || ''),
    seconds: Number((s && s.seconds) || 0),
    narration: String((s && s.narration) || ''),
  }));
}

/** 顶层总时长：服务端会先按旁白重算（data.seconds 就是重算后的 totalSeconds）。 */
function totalSeconds(data, plan) {
  const fromData = Number(data && data.seconds);
  if (Number.isFinite(fromData) && fromData > 0) return fromData;
  const fromPlan = Number(plan && plan.totalSeconds);
  return Number.isFinite(fromPlan) ? fromPlan : 0;
}

/** 失败结果统一带上"失败在哪一步"，否则模型分不清是写分镜失败还是 ffmpeg 失败。 */
function failure(data, fallbackStage, status) {
  const error = (data && (data.error || data.code)) || `HTTP ${status || 0}`;
  // 服务端自己知道失败在 plan 还是 render（data.step），优先用它，客户端猜的 stage 只做兜底。
  const stage = String((data && data.step) || fallbackStage);
  const out = { ok: false, stage, error: String(error) };
  if (data && data.message) out.message = String(data.message);
  if (data && data.raw) out.raw = String(data.raw).slice(0, 400);
  return out;
}

export function apply(ctx, config) {
  const baseUrl = trimBase((config && config.baseUrl) || process.env.DSH_STUDIO_URL || DEFAULT_BASE_URL)
    || DEFAULT_BASE_URL;

  // videoUrl 允许显式配置成空串来关掉"取片地址"那句提示（studio 和取片服务可能不在同一台机器）。
  // 这里刻意用 hasOwnProperty 判断：空串是有效配置，不能被 || 当成没配。
  const videoUrlConfigured = config && Object.prototype.hasOwnProperty.call(config, 'videoUrl');
  const videoUrlRaw = videoUrlConfigured
    ? config.videoUrl
    : (process.env.DSH_STUDIO_VIDEO_URL || DEFAULT_VIDEO_URL);
  const videoUrl = videoUrlRaw ? trimBase(videoUrlRaw) : '';

  // 1) 一步到底：写分镜 + 真渲染 -----------------------------------------
  ctx.tools.register({
    name: 'make_video',
    description:
      'Render a short video from a written prompt. DSH writes only the storyboard (per-scene on-screen text, narration, seconds, gradient colors); ffmpeg renders the mp4 — no model generates imagery. This call really renders: it normally takes 15–40 s and the tool timeout is 1200 s, so do not call it twice for the same request. To review the storyboard with a human first, call make_plan and then call this once approved. Returns {ok, jobId, title, seconds, scenes:[{text, seconds, narration}], bytes, ms}, where seconds is the final video length (narration can stretch a scene).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'What the video is about, in one or two sentences' },
        seconds: {
          type: 'integer',
          minimum: 8,
          maximum: 30,
          description: 'Target total length in seconds. Default 12. Clamped to 8–30',
        },
        voice: { type: 'string', description: 'TTS voice name passed to the speech module; optional' },
        bgm: {
          type: 'string',
          description: 'Background music file name in the studio bgm directory; optional',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(describeVideo(value, videoUrl)),
    },
    async execute(args) {
      const a = args || {};
      const prompt = String(a.prompt || '').trim();
      if (!prompt) return { ok: false, stage: 'create', error: 'PROMPT_REQUIRED' };

      const payload = { prompt, seconds: clampSeconds(a.seconds) };
      if (a.voice) payload.voice = String(a.voice);
      if (a.bgm) payload.bgm = String(a.bgm);

      const { status, data } = await requestJson('POST', `${baseUrl}/v1/create`, {
        body: payload,
        timeoutMs: CREATE_TIMEOUT_MS,
      });
      if (!data || !data.ok) return failure(data, 'create', status);

      const plan = data.plan || {};
      return {
        ok: true,
        jobId: String(data.jobId || ''),
        title: String(plan.title || ''),
        seconds: totalSeconds(data, plan),
        scenes: summarizeScenes(plan),
        bytes: Number(data.bytes) || 0,
        ms: Number(data.ms) || 0,
      };
    },
  });

  // 2) 只写分镜，不渲染 ---------------------------------------------------
  ctx.tools.register({
    name: 'make_plan',
    description:
      'Write a storyboard only, without rendering anything: per-scene on-screen text, narration and seconds. Use it when the user wants to read or adjust the storyboard before spending a real render, or when only the scene breakdown is needed. Cheap and repeatable. Returns {ok, title, seconds, scenes:[{text, seconds, narration}]}. Producing the mp4 needs make_video.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'What the video is about, in one or two sentences' },
        seconds: {
          type: 'integer',
          minimum: 8,
          maximum: 30,
          description: 'Target total length in seconds. Default 12. Clamped to 8–30',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(describePlan(value)),
    },
    async execute(args) {
      const a = args || {};
      const prompt = String(a.prompt || '').trim();
      if (!prompt) return { ok: false, stage: 'plan', error: 'PROMPT_REQUIRED' };

      const payload = { prompt, seconds: clampSeconds(a.seconds) };
      const { status, data } = await requestJson('POST', `${baseUrl}/v1/plan`, {
        body: payload,
        timeoutMs: PLAN_TIMEOUT_MS,
      });
      if (!data || !data.ok) return failure(data, 'plan', status);

      const plan = data.plan || {};
      return {
        ok: true,
        title: String(plan.title || ''),
        seconds: totalSeconds(data, plan),
        scenes: summarizeScenes(plan),
      };
    },
  });

  // 2) 项目模式：长片的分段增量编辑 --------------------------------
  // 为什么要有它：make_video 每次都整片重渲。改一句台词也要重渲几十秒的画面，
  // 既慢又浪费。项目模式把每个场景渲成独立片段并缓存，改哪场只重渲哪场。
  ctx.tools.register({
    name: 'project_create',
    description:
      'Create an editable video project (for longer videos: explainers, tutorials, 10+ scenes). Unlike make_video, a project keeps each scene as a cached clip, so later edits only re-render what changed. Pass the full storyboard once; afterwards use project_patch for edits and project_render to produce (or re-produce) the mp4. Returns {ok, project:{id, title, scenes:[...]}}.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Project title' },
        scenes: {
          type: 'array',
          description: 'Optional initial storyboard. Each scene: {text, narration, seconds, bg:{c0,c1}, image, motion}',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              text: { type: 'string', description: 'On-screen text, keep it short' },
              narration: { type: 'string', description: 'Spoken line for this scene' },
              seconds: { type: 'number', description: 'Planned seconds (2–12)' },
              bg: { type: 'object', additionalProperties: true, description: 'Gradient colors {c0,c1} as #rrggbb' },
              image: { type: 'string', description: 'Image filename or absolute path (optional)' },
              motion: { type: 'string', description: 'zoom-in | zoom-out | pan-left | pan-right' },
            },
          },
        },
        voice: { type: 'string', description: 'TTS voice used for every narration line' },
        bgm: { type: 'string', description: 'Background music filename (optional)' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textBlock(describeProject(v)) },
    async execute(args) {
      const { status, data } = await requestJson('POST', `${baseUrl}/v1/project`, {
        body: {
          title: String(args.title || ''),
          scenes: Array.isArray(args.scenes) ? args.scenes : [],
          voice: args.voice,
          bgm: args.bgm,
        },
        timeoutMs: 60000,
      });
      if (!data || !data.ok) return failure(data, 'project', status);
      const p = data.project || {};
      return {
        ok: true,
        project: {
          id: String(p.id || ''),
          title: String(p.title || ''),
          scenes: summarizeScenes(p),
          cache: Object.keys(p.cache || {}).length,
        },
      };
    },
  });

  ctx.tools.register({
    name: 'project_patch',
    description:
      'Edit an existing project by sending ONLY the changes — never resend the whole storyboard (that wastes tokens and time). Each patch targets one scene by index: {op:"patch", index, patch:{text?|narration?|seconds?|bg?|image?|motion?}}, or {op:"insert", index, scene:{...}}, or {op:"delete", index}. Changing narration alone never re-renders imagery. Returns {ok, touched, scenes, willRebuild:[indices], willReuse:[indices]} so you can tell the human how much will be re-rendered.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'patches'],
      properties: {
        id: { type: 'string', description: 'Project id from project_create' },
        patches: {
          type: 'array',
          description: 'List of edits; each is a small object, not a full scene list',
          items: { type: 'object', additionalProperties: true },
        },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textBlock(describePatch(v)) },
    async execute(args) {
      const { status, data } = await requestJson('POST', `${baseUrl}/v1/project/patch`, {
        body: { id: String(args.id || ''), patches: Array.isArray(args.patches) ? args.patches : [] },
        timeoutMs: 60000,
      });
      if (!data || !data.ok) return failure(data, 'patch', status);
      return {
        ok: true,
        touched: data.touched || [],
        scenes: Number(data.scenes) || 0,
        willRebuild: data.willRebuild || [],
        willReuse: data.willReuse || [],
      };
    },
  });

  ctx.tools.register({
    name: 'project_render',
    description:
      'Render a project to mp4. scope:"auto" (default) re-renders only scenes whose visuals changed and reuses the rest — use after editing. scope:"audio" re-does ONLY the narration and audio mix, reusing every cached clip (a few seconds instead of tens); use this when the human only wants different wording/voice. scope:"all" forces a full re-render (slow). Returns {ok, jobId, seconds, bytes, reused, rendered, ms}.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Project id' },
        scope: {
          type: 'string',
          enum: ['auto', 'audio', 'all'],
          description: 'auto = only changed scenes; audio = narration only; all = everything',
        },
        voice: { type: 'string', description: 'Override TTS voice for this render' },
        bgm: { type: 'string', description: 'Override background music' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textBlock(describeRender(v, videoUrl)) },
    async execute(args) {
      const { status, data } = await requestJson('POST', `${baseUrl}/v1/project/render`, {
        body: {
          id: String(args.id || ''),
          scope: args.scope || 'auto',
          voice: args.voice,
          bgm: args.bgm,
        },
        timeoutMs: 1200000,
      });
      if (!data || !data.ok) return failure(data, 'render', status);
      return {
        ok: true,
        jobId: String(data.renderId || data.jobId || ''),
        seconds: Number(data.seconds) || 0,
        bytes: Number(data.bytes) || 0,
        reused: Number(data.reused) || 0,
        rendered: Number(data.rendered) || 0,
        ms: Number(data.ms) || 0,
      };
    },
  });
}

/** project_create 的人话小结 */
function describeProject(value) {
  if (!value || value.ok === false) {
    return `没有建成项目：${(value && value.error) || '未知原因'}。\n${JSON.stringify(value)}`;
  }
  const p = value.project || {};
  return `项目已建立：《${p.title}》，id=${p.id}，${(p.scenes || []).length} 场。`
    + '接下来用 project_patch 改、project_render 出片。\n' + JSON.stringify(value);
}

/** project_patch 的人话小结：重点说清"会不会重画" */
function describePatch(value) {
  if (!value || value.ok === false) {
    return `没有改成：${(value && value.error) || '未知原因'}。\n${JSON.stringify(value)}`;
  }
  const rebuild = (value.willRebuild || []).length;
  const reuse = (value.willReuse || []).length;
  const head = rebuild
    ? `已改 ${(value.touched || []).length} 处，下次渲染需重画 ${rebuild} 场、复用 ${reuse} 场。`
    : `已改 ${(value.touched || []).length} 处，画面不需要重画（下次可以直接 scope:"audio" 只重做声音）。`;
  return `${head}\n${JSON.stringify(value)}`;
}

/** project_render 的人话小结 */
function describeRender(value, videoUrl) {
  if (!value || value.ok === false) {
    return `渲染失败：${(value && value.error) || '未知原因'}。\n${JSON.stringify(value)}`;
  }
  const kb = Math.round((Number(value.bytes) || 0) / 1024);
  const lines = [
    `成片已生成：${value.seconds} 秒，${kb} KB；本次重画 ${value.rendered} 场、复用 ${value.reused} 场，耗时 ${(value.ms / 1000).toFixed(1)} 秒。`,
  ];
  if (videoUrl && value.jobId) lines.push(`可用 ${videoUrl}/v1/video?id=${encodeURIComponent(value.jobId)} 取回。`);
  lines.push(JSON.stringify(value));
  return lines.join('\n');
}

/**
 * make_video 的人话小结。
 * 第一句就是"成片已生成 + 怎么取回"，后面才是结构化 JSON —— 模型先读结论，
 * 需要 jobId 或某场台词时再读 JSON，不用自己从大对象里翻。
 */
function describeVideo(value, videoUrl) {
  if (!value || value.ok === false) {
    return `没有生成成片：${(value && value.error) || '未知原因'}。没有渲染成功就不会留下半成品文件。\n`
      + JSON.stringify(value);
  }
  const kb = Math.round((Number(value.bytes) || 0) / 1024);
  const head = `成片已生成：《${value.title || '未命名'}》${value.seconds} 秒，${(value.scenes || []).length} 场，约 ${kb} KB。`;
  const lines = [head];
  if (videoUrl && value.jobId) {
    lines.push(`可用 ${videoUrl}/v1/video?id=${encodeURIComponent(value.jobId)} 取回。`);
  }
  lines.push(JSON.stringify(value));
  return lines.join('\n');
}

/** make_plan 的人话小结：强调"只写了分镜，还没渲染"，避免模型把 plan 当成成片。 */
function describePlan(value) {
  if (!value || value.ok === false) {
    return `没有写出分镜：${(value && value.error) || '未知原因'}。\n` + JSON.stringify(value);
  }
  const head = `分镜已写好：《${value.title || '未命名'}》${value.seconds} 秒，${(value.scenes || []).length} 场。`
    + '这只是分镜，还没有渲染；确认后调用 make_video 才出片。';
  return `${head}\n${JSON.stringify(value)}`;
}
