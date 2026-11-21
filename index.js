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
async function requestJson(method, url, { body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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
