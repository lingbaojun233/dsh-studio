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

  // 1) 一步到底 / 只写分镜：plan_only 决定打哪个接口 ----------------------
  ctx.tools.register({
    name: 'make_video',
    description:
      'Render a short video from a prompt: DSH writes the storyboard, ffmpeg renders the mp4 (no AI imagery). Takes 15–40 s, timeout 1200 s. plan_only:true writes only the storyboard.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        seconds: {
          type: 'integer',
          minimum: 8,
          maximum: 30,
          description: 'Default 12; clamped to 8-30.',
        },
        plan_only: { type: 'boolean', description: 'true = storyboard only, nothing rendered.' },
        voice: { type: 'string', description: 'TTS voice name for narration.' },
        bgm: { type: 'string', description: 'BGM filename in the studio bgm dir.' },
      },
    },
    output: {
      schema: { type: 'object' },
      // 两种模式返回形状不同：plan 只有 title/seconds/scenes，video 还带 jobId/bytes。
      render: (args, value) => {
        const planOnly =
          (args && args.plan_only === true) || (value && value.ok !== false && !('jobId' in value));
        return textBlock(planOnly ? describePlan(value) : describeVideo(value, videoUrl));
      },
    },
    async execute(args) {
      const a = args || {};
      const planOnly = a.plan_only === true;
      const prompt = String(a.prompt || '').trim();
      if (!prompt) return { ok: false, stage: planOnly ? 'plan' : 'create', error: 'PROMPT_REQUIRED' };

      const payload = { prompt, seconds: clampSeconds(a.seconds) };

      if (planOnly) {
        // 只写分镜：和原来的 make_plan 一样，body 只有 prompt/seconds
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
      }

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

  // 2) 项目模式：长片的分段增量编辑 --------------------------------
  // 为什么要有它：make_video 每次都整片重渲。改一句台词也要重渲几十秒的画面，
  // 既慢又浪费。项目模式把每个场景渲成独立片段并缓存，改哪场只重渲哪场。
  ctx.tools.register({
    name: 'project_create',
    description:
      'Create an editable video project: each scene stays a cached clip, so later edits re-render only what changed. Use project_apply to edit or render it.',
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        scenes: {
          type: 'array',
          description: 'Initial storyboard; each item is one scene.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'On-screen text; keep it short.' },
              narration: { type: 'string', description: 'Spoken line for this scene.' },
              seconds: { type: 'number', description: 'Planned seconds (2-12).' },
              bg: { type: 'object', description: 'Gradient {c0,c1} as #rrggbb.' },
              image: { type: 'string', description: 'Image filename or absolute path.' },
              motion: { type: 'string', description: 'zoom-in | zoom-out | pan-left | pan-right.' },
            },
          },
        },
        voice: { type: 'string', description: 'TTS voice for every narration line.' },
        bgm: { type: 'string', description: 'BGM filename.' },
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

  // 3) 编辑 + 渲染：有 patches 先打补丁，有 scope 再渲染，都没有就只查状态 -------
  ctx.tools.register({
    name: 'project_apply',
    description:
      'Edit and/or render an existing project. patches = minimal per-scene edits; scope renders afterwards (auto|audio|all). Omit both to just read project status.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Project id from project_create.' },
        patches: {
          type: 'array',
          description: "{op:'patch'|'insert'|'delete', index, patch|scene}.",
          items: { type: 'object' },
        },
        scope: {
          type: 'string',
          enum: ['auto', 'audio', 'all'],
          description: 'auto = changed scenes; audio = narration only; all = full.',
        },
        voice: { type: 'string', description: 'Override TTS voice for this render.' },
        bgm: { type: 'string', description: 'Override BGM for this render.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textBlock(describeApply(v, videoUrl)) },
    async execute(args) {
      const a = args || {};
      const id = String(a.id || '').trim();
      // patches 只要是个数组就算"要打补丁"（空数组是合法的 no-op）；
      // scope 只有显式给了才算"要渲染"，否则会被当成"顺便渲一下"。
      const hasPatches = Array.isArray(a.patches);
      const hasScope = a.scope !== undefined && a.scope !== null && String(a.scope).trim() !== '';

      // 第一步：打补丁。只发改动，不发整份分镜。
      let patched = null;
      if (hasPatches) {
        const { status, data } = await requestJson('POST', `${baseUrl}/v1/project/patch`, {
          body: { id, patches: a.patches },
          timeoutMs: 60000,
        });
        if (!data || !data.ok) return failure(data, 'patch', status);
        patched = {
          touched: data.touched || [],
          scenes: Number(data.scenes) || 0,
          willRebuild: data.willRebuild || [],
          willReuse: data.willReuse || [],
        };
      }

      // 第二步：没给 scope。打过补丁就只汇报补丁结果，否则只查项目状态。
      if (!hasScope) {
        if (patched) return { ok: true, ...patched };

        const { status, data } = await requestJson(
          'GET',
          `${baseUrl}/v1/project?id=${encodeURIComponent(id)}`,
        );
        if (!data || !data.ok) return failure(data, 'status', status);
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
      }

      // 第三步：渲染。auto 只重画改过的场次，audio 只重做声音。
      const { status, data } = await requestJson('POST', `${baseUrl}/v1/project/render`, {
        body: { id, scope: String(a.scope), voice: a.voice, bgm: a.bgm },
        timeoutMs: 1200000,
      });
      if (!data || !data.ok) return failure(data, 'render', status);
      const rendered = {
        jobId: String(data.renderId || data.jobId || ''),
        seconds: Number(data.seconds) || 0,
        bytes: Number(data.bytes) || 0,
        reused: Number(data.reused) || 0,
        rendered: Number(data.rendered) || 0,
        ms: Number(data.ms) || 0,
      };
      // 打过补丁就把补丁结果一起带上，模型才能解释"这次重画了几场"。
      return patched ? { ok: true, ...patched, ...rendered } : { ok: true, ...rendered };
    },
  });
}

/** project_create / 查状态的人话小结 */
function describeProject(value) {
  if (!value || value.ok === false) {
    return `没有建成项目：${(value && value.error) || '未知原因'}。\n${JSON.stringify(value)}`;
  }
  const p = value.project || {};
  return `项目已建立：《${p.title}》，id=${p.id}，${(p.scenes || []).length} 场。`
    + '接下来用 project_apply 改、出片。\n' + JSON.stringify(value);
}

/**
 * project_apply 的人话小结。
 * 三种结果：查状态（project）/ 只打补丁（touched）/ 渲染（jobId）；
 * 打了补丁又渲染时两段都输出，模型才能解释"这次重画了几场"。
 */
function describeApply(value, videoUrl) {
  if (!value || value.ok === false) {
    const head = value && value.stage === 'render'
      ? '渲染失败'
      : value && value.stage === 'patch'
        ? '没有改成'
        : value && value.stage === 'status'
          ? '查不到这个项目'
          : '项目操作失败';
    return `${head}：${(value && value.error) || '未知原因'}。\n${JSON.stringify(value)}`;
  }
  if (value.project) {
    const p = value.project;
    const head = `项目状态：《${p.title || '未命名'}》，id=${p.id}，${(p.scenes || []).length} 场，已缓存 ${p.cache || 0} 段。`;
    return `${head}\n${JSON.stringify(value)}`;
  }
  const lines = [];
  if (Array.isArray(value.touched)) lines.push(patchHead(value));
  if ('jobId' in value) lines.push(...renderHead(value, videoUrl));
  lines.push(JSON.stringify(value));
  return lines.join('\n');
}

/** 补丁小结：重点说清"会不会重画" */
function patchHead(value) {
  const rebuild = (value.willRebuild || []).length;
  const reuse = (value.willReuse || []).length;
  return rebuild
    ? `已改 ${(value.touched || []).length} 处，下次渲染需重画 ${rebuild} 场、复用 ${reuse} 场。`
    : `已改 ${(value.touched || []).length} 处，画面不需要重画（下次可以直接 scope:"audio" 只重做声音）。`;
}

/** 渲染小结：成片大小 + 重画/复用场次 + 取片地址 */
function renderHead(value, videoUrl) {
  const kb = Math.round((Number(value.bytes) || 0) / 1024);
  const lines = [
    `成片已生成：${value.seconds} 秒，${kb} KB；本次重画 ${value.rendered} 场、复用 ${value.reused} 场，耗时 ${(value.ms / 1000).toFixed(1)} 秒。`,
  ];
  if (videoUrl && value.jobId) lines.push(`可用 ${videoUrl}/v1/video?id=${encodeURIComponent(value.jobId)} 取回。`);
  return lines;
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
