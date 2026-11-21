/**
 * dsh-studio —— 把 studio 模块（视频创作，默认 8772 端口）注册成 DSH 原生工具。
 *
 * 为什么要这一层：studio 的接口只是普通 HTTP。模型看到"8772 上有个服务"时
 * 不会主动去 curl，而是继续用 ls/find 翻文件；注册成工具后，它和 bash/fs 一样
 * 出现在工具表里，才会真的被调用。
 *
 * 一个入口三种输入（make_video）：
 *   topic      → 全自动：给主题，它自己写分镜并渲染
 *   script     → 写稿：一段稿子拆成 4~10 场，旁白尽量用原话
 *   storyboard → 分镜：用户填的每一场，"画什么"由 DSH 翻译成 manim 代码
 * plan_only:true 时三种都只出分镜，不渲染。
 *
 * 这个仓库刻意完全独立：只 import Node 内置模块，用全局 fetch，不 import 主项目任何文件，
 * 所以任何 DSH profile 都能单独 clone + 安装。
 */

import http from 'node:http';
import https from 'node:https';

export const name = 'dsh-studio';
export const inject = ['tools'];

const DEFAULT_BASE_URL = 'http://127.0.0.1:8772';
const DEFAULT_VIDEO_URL = 'http://127.0.0.1:8766';

// 各阶段预算。写稿拆场和逐场写 manim 代码都是一次模型调用，渲染是 ffmpeg。
// 宁可等，也不要让模型看到"超时"后重试 —— 一次重试就是重渲一遍。
const PLAN_TIMEOUT_MS = 300 * 1000;
const SCRIPT_TIMEOUT_MS = 300 * 1000;
const FILL_TIMEOUT_MS = 900 * 1000;
const RENDER_TIMEOUT_MS = 1200 * 1000;
// 单条 AI 视频（wan3.0-video）实测约 100 秒；任务书要求给 480 秒总预算，
// 覆盖"排队 + 生成 + 下载 + 校验"，超时就让模型看到明确的超时而不是无限占着工具。
const GEN_VIDEO_TIMEOUT_MS = 480 * 1000;
// 单次工具调用的总预算：topic 只渲染；script 要拆场 + 补代码 + 渲染。
const TOPIC_TIMEOUT_MS = RENDER_TIMEOUT_MS + 60000;
const SCRIPT_RENDER_TIMEOUT_MS = SCRIPT_TIMEOUT_MS + FILL_TIMEOUT_MS + RENDER_TIMEOUT_MS + 60000;

/** 去掉结尾斜杠：否则 baseUrl 以 / 结尾时会拼出 //v1/create。 */
function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

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

/**
 * 所有 HTTP 一律走这里，返回 { status, data }，永不抛异常。
 *
 * 为什么不用 fetch：Node 的 undici 有一条 **300 秒的 headersTimeout**，和
 * AbortSignal 给的超时无关。渲染一集长片（8 场 manim ≈ 3 分钟，加上写代码）
 * 很容易超过 5 分钟，fetch 会在第 300 秒直接抛 TypeError: fetch failed ——
 * 服务端还在正常出片，模型却看到"失败"，然后重试一遍。
 * node:http 的 timeout 由我们自己控制，没有这条隐藏上限。
 */
function requestJson(method, url, { body, timeoutMs = 30000, outerSignal } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const headers = headersFor(body);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) headers['content-length'] = String(payload.length);

    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return finish({ status: 0, data: { ok: false, error: 'BAD_URL', message: String(err && err.message || err) } });
    }
    const lib = target.protocol === 'https:' ? https : http;

    const req = lib.request(target, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          finish({ status: res.statusCode || 0, data: JSON.parse(text) });
        } catch {
          finish({ status: res.statusCode || 0, data: { ok: false, error: text.slice(0, 800) } });
        }
      });
    });

    if (outerSignal) {
      if (outerSignal.aborted) {
        return finish({ status: 0, data: { ok: false, error: 'ABORTED', message: 'the caller cancelled this tool call' } });
      }
      outerSignal.addEventListener('abort', () => {
        req.destroy(new Error('ABORTED'));
      }, { once: true });
    }

    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (err) => {
      const msg = String((err && err.message) || err);
      if (msg === 'ABORTED') {
        finish({ status: 0, data: { ok: false, error: 'ABORTED', message: 'the caller cancelled this tool call' } });
        return;
      }
      if (msg === 'TIMEOUT') {
        finish({
          status: 0,
          data: { ok: false, error: 'TIMEOUT', message: `请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回` },
        });
        return;
      }
      finish({ status: 0, data: { ok: false, error: 'UNREACHABLE', message: msg } });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function textBlock(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

/** 秒数收敛到 8~900。schema 已经限制了范围，但模型可能绕过 schema，服务端也另有上下限。 */
function clampSeconds(value, fallback = 60) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(900, Math.max(8, Math.round(n)));
}

/**
 * 失败结果统一带上"失败在哪一步"，否则模型分不清是写分镜失败还是渲染失败。
 * VOICE_UNAVAILABLE / QUEUE_TIMEOUT 这两个码必须原样带出去：
 * 一个是"TTS 没给音频"，一个是"排队超时"，处理方式完全不同。
 */
function failure(data, fallbackStage, status) {
  const error = (data && (data.error || data.code)) || `HTTP ${status || 0}`;
  const stage = String((data && data.step) || fallbackStage);
  const out = { ok: false, stage, error: String(error) };
  if (data && data.message) out.message = String(data.message);
  if (data && data.hint) out.hint = String(data.hint);
  if (data && data.detail) out.detail = String(data.detail).slice(0, 400);
  if (data && data.raw) out.raw = String(data.raw).slice(0, 400);
  // 配音失败：把 speak 的原因和重试次数带出来，模型才能解释"为什么没成"
  if (data && data.speakError) out.speakError = String(data.speakError);
  if (data && Number(data.attempts)) out.attempts = Number(data.attempts);
  if (data && Array.isArray(data.scenes) && data.scenes.length) {
    out.missingNarration = data.scenes.map((s) => ({ index: Number(s.index) || 0, text: String(s.text || '') }));
  }
  return out;
}

/**
 * 分镜摘要：模型真正需要的是"每场说什么、多长、有没有画"。
 * manim 代码原样塞回去会占掉大量 token，只给长度和头一行，够它判断"有没有生成"。
 */
function summarizeScenes(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  return list.map((s, i) => {
    const code = s && s.manim && typeof s.manim.code === 'string' ? s.manim.code : '';
    const out = {
      index: i,
      text: String((s && s.text) || ''),
      narration: String((s && s.narration) || ''),
      seconds: Number((s && s.seconds) || 0),
      tool: String((s && s.tool) || ''),
      manim: Boolean(code),
    };
    if (code) {
      out.manim_chars = code.length;
      out.manim_head = code.split('\n').slice(0, 2).join(' / ').slice(0, 120);
    }
    if (s && s.visual_hint) out.visual_hint = String(s.visual_hint);
    if (s && s.status) out.status = String(s.status);
    // AI 画面场：只报"有没有"，prompt 原文回给模型也没用（它自己写的）
    if (s && s.video && typeof s.video.prompt === 'string' && s.video.prompt.trim()) out.video = true;
    if (s && s.note) out.note = String(s.note);
    return out;
  });
}

/** 顶层总时长：服务端会先按旁白重算（data.seconds 就是重算后的 totalSeconds）。 */
function totalSeconds(data, plan) {
  const fromData = Number(data && data.seconds);
  if (Number.isFinite(fromData) && fromData > 0) return fromData;
  const fromPlan = Number(plan && plan.totalSeconds);
  return Number.isFinite(fromPlan) ? fromPlan : 0;
}

/** 分镜输入只留合法字段；storyboard 的用户字段一个都不许改写。 */
function normalizeStoryboard(list) {
  return (Array.isArray(list) ? list : []).slice(0, 80).map((s) => {
    const out = {
      text: String((s && s.text) || ''),
      narration: String((s && s.narration) || ''),
      seconds: Number(s && s.seconds) || 6,
      visual_hint: String((s && s.visual_hint) || ''),
    };
    const tool = String((s && s.tool) || '').trim().toLowerCase();
    if (tool === 'manim' || tool === 'text' || tool === 'aivideo') out.tool = tool;
    // aivideo 场：prompt 已写好就原样带过去（studio 会直接拿去生成，不再让模型翻一遍）
    const video = s && s.video && typeof s.video === 'object' ? s.video : null;
    const prompt = video && typeof video.prompt === 'string' ? video.prompt.trim() : '';
    if (prompt) {
      out.video = { prompt: prompt.slice(0, 240), size: String(video.size || '1280*720') };
    }
    return out;
  }).filter((s) => s.text || s.narration || s.visual_hint || (s.video && s.video.prompt));
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

  ctx.tools.register({
    name: 'make_video',
    description:
      'Create a video and render it to mp4 with DSH-written storyboard + manim (no AI imagery). '
      + 'One entry, three inputs (choose exactly one): '
      + 'topic = fully automatic, e.g. make_video({topic:"导数是什么", seconds:60}); '
      + 'script = split a pasted script into 4-10 scenes (narration keeps the original words), e.g. '
      + 'make_video({script:"导数是变化率。先看一条曲线……", seconds:60, plan_only:true}); '
      + 'storyboard = user-supplied scenes, where visual_hint is translated into manim code, e.g. '
      + 'make_video({storyboard:[{text:"割线变切线", narration:"让两点越来越近", seconds:10, '
      + 'visual_hint:"画坐标轴、曲线上两个点，连线，然后让点靠近变成切线", tool:"manim"}]}). '
      + 'For shots with people/scenes/action set tool:"aivideo" plus video:{prompt:"<English, <=120 chars>"} '
      + '(AI generated, ~100 s each, max 4 per video) — formulas/charts stay manim; '
      + 'for a single standalone AI clip use gen_video instead. '
      + 'plan_only:true returns the storyboard and renders nothing (storyboard mode also generates the manim '
      + 'code; script mode only splits scenes). '
      + 'style/voice default to the persona binding; empty string means "follow the persona". '
      + 'A 5-scene render takes 1-3 minutes; timeout 2400 s.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '主题/一句话想法。全自动模式，和 script、storyboard 三选一。' },
        script: { type: 'string', description: '用户写的稿子。写稿模式：拆成 4~10 场，旁白尽量用原话。' },
        storyboard: {
          type: 'array',
          description: '分镜模式：每项一场。text/narration 是用户原话不要改写；visual_hint 会被翻译成 manim 代码；tool 可留空（自动判断）。',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '这一场的标题（画面上的字）。' },
              narration: { type: 'string', description: '这一场念的旁白；留空则这一场不出声。' },
              seconds: { type: 'number', description: '这一场多少秒（3~10）。' },
              visual_hint: { type: 'string', description: '自然语言描述画什么，例如"画坐标轴、曲线上两个点，连线，然后让点靠近变成切线"。' },
              tool: { type: 'string', enum: ['manim', 'text', 'aivideo', ''], description: 'manim / text / aivideo / 留空自动。' },
              video: {
                type: 'object',
                description: 'aivideo 场用：{prompt, size}。prompt 必须英文，≤120 字符。',
                properties: {
                  prompt: { type: 'string', description: 'English prompt: subject + action + style + shot.' },
                  size: { type: 'string', description: 'Resolution, default 1280*720.' },
                },
              },
            },
          },
        },
        seconds: { type: 'integer', minimum: 8, maximum: 900, description: '总时长（topic/script 用），默认 60。' },
        style: { type: 'string', description: '风格 id（whiteboard / blueprint / oscilloscope-math）；空 = 跟人设。' },
        voice: { type: 'string', description: '音色（如 voc_xxx / yaoyao）；空 = 跟人设。' },
        plan_only: { type: 'boolean', description: 'true = 只出分镜，不渲染。' },
      },
    },
    output: {
      schema: { type: 'object' },
      // 两种结果形状不同：plan 只有 scenes，video 还带 jobId/bytes。
      render: (args, value) => {
        const planOnly = Boolean(args && args.plan_only === true);
        return textBlock(planOnly ? describePlan(value) : describeVideo(value, videoUrl));
      },
    },
    timeoutMs: SCRIPT_RENDER_TIMEOUT_MS,
    async execute(args, exec) {
      const a = args || {};
      const topic = String(a.topic || '').trim();
      const script = String(a.script || '').trim();
      const storyboard = Array.isArray(a.storyboard) ? normalizeStoryboard(a.storyboard) : null;
      const planOnly = a.plan_only === true;
      const style = a.style == null ? '' : String(a.style);
      const voice = a.voice == null ? '' : String(a.voice);
      const seconds = clampSeconds(a.seconds, 60);

      const modes = [];
      if (topic) modes.push('topic');
      if (script) modes.push('script');
      if (storyboard && storyboard.length) modes.push('storyboard');
      if (modes.length !== 1) {
        return {
          ok: false,
          stage: 'input',
          error: 'CHOOSE_ONE_MODE',
          message: 'topic / script / storyboard 三选一：topic 全自动，script 写稿拆场，storyboard 自己填每场。',
        };
      }
      const mode = modes[0];

      // ---------------------------------------------------------- 全自动 --
      if (mode === 'topic') {
        if (planOnly) {
          const { status, data } = await requestJson('POST', `${baseUrl}/v1/plan`, {
            body: { prompt: topic, seconds, style, voice },
            timeoutMs: PLAN_TIMEOUT_MS,
            outerSignal: exec && exec.signal,
          });
          if (!data || !data.ok) return failure(data, 'plan', status);
          const plan = data.plan || {};
          return {
            ok: true,
            mode,
            planOnly: true,
            title: String(plan.title || ''),
            seconds: totalSeconds(data, plan),
            scenes: summarizeScenes(plan.scenes),
            estimate: data.estimate || null,
          };
        }
        const { status, data } = await requestJson('POST', `${baseUrl}/v1/create`, {
          body: { prompt: topic, seconds, style, voice },
          timeoutMs: TOPIC_TIMEOUT_MS,
          outerSignal: exec && exec.signal,
        });
        if (!data || !data.ok) return failure(data, 'create', status);
        const plan = data.plan || {};
        return {
          ok: true,
          mode,
          jobId: String(data.jobId || ''),
          title: String(plan.title || ''),
          seconds: totalSeconds(data, plan),
          scenes: summarizeScenes(plan.scenes),
          bytes: Number(data.bytes) || 0,
          ms: Number(data.ms) || 0,
          estimate: data.estimate || null,
        };
      }

      // ------------------------------------------------------------ 写稿 --
      if (mode === 'script') {
        const split = await requestJson('POST', `${baseUrl}/v1/storyboard/from-script`, {
          body: { script, seconds, style, voice },
          timeoutMs: SCRIPT_TIMEOUT_MS,
          outerSignal: exec && exec.signal,
        });
        if (!split.data || !split.data.ok) return failure(split.data, 'storyboard', split.status);
        const splitData = split.data;
        if (planOnly) {
          return {
            ok: true,
            mode,
            planOnly: true,
            projectId: String((splitData.project && splitData.project.id) || ''),
            title: String(splitData.title || ''),
            seconds: totalSeconds(splitData, null),
            scenes: summarizeScenes(splitData.scenes),
            warnings: splitData.warnings || [],
            estimate: splitData.estimate || null,
            binding: splitData.bindingSummary || '',
          };
        }
        // 渲染前先补每场的 manim 代码（分镜模式的同一套逻辑）
        return await fillAndRender({
          mode, baseUrl, title: String(splitData.title || ''), projectId: String((splitData.project && splitData.project.id) || ''),
          scenes: splitData.scenes, style, voice, exec, planOnly: false,
        });
      }

      // ------------------------------------------------------------ 分镜 --
      return await fillAndRender({
        mode, baseUrl, title: '', projectId: '', scenes: storyboard, style, voice, exec, planOnly,
      });
    },
  });

  // ---------------------------------------------------------------------
  // 项目模式：长片的分段增量编辑 --------------------------------
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
              manim: {
                type: 'object',
                description: 'Generated manim script {scene,code}. Usually produced by make_video.',
              },
              video: {
                type: 'object',
                description: 'aivideo scene: {prompt,size}. English prompt <=120 chars; generated by wan3.0-video (slow, max 4 per video).',
                properties: {
                  prompt: { type: 'string', description: 'English prompt: subject + action + style + shot.' },
                  size: { type: 'string', description: 'Resolution, default 1280*720.' },
                },
              },
            },
          },
        },
        style: { type: 'string', description: 'Style preset id; empty = follow the persona.' },
        voice: { type: 'string', description: 'TTS voice for every narration line; empty = follow the persona.' },
        bgm: { type: 'string', description: 'BGM filename.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textBlock(describeProject(v)) },
    // 建项目只是写配置，60s 请求预算 + 5s 余量。
    timeoutMs: 65000,
    async execute(args, exec) {
      const { status, data } = await requestJson('POST', `${baseUrl}/v1/project`, {
        body: {
          title: String(args.title || ''),
          scenes: Array.isArray(args.scenes) ? args.scenes : [],
          style: args.style == null ? '' : String(args.style),
          voice: args.voice == null ? '' : String(args.voice),
          bgm: args.bgm,
        },
        timeoutMs: 60000,
        outerSignal: exec && exec.signal,
      });
      if (!data || !data.ok) return failure(data, 'project', status);
      const p = data.project || {};
      return {
        ok: true,
        project: {
          id: String(p.id || ''),
          title: String(p.title || ''),
          scenes: summarizeScenes(p.scenes),
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
        style: { type: 'string', description: 'Override style for this render; empty = keep the project setting.' },
        voice: { type: 'string', description: 'Override TTS voice for this render.' },
        bgm: { type: 'string', description: 'Override BGM for this render.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textBlock(describeApply(v, videoUrl)) },
    // 和渲染请求的 20 分钟预算对齐；补丁/查状态远小于它。
    timeoutMs: 1205000,
    async execute(args, exec) {
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
          outerSignal: exec && exec.signal,
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
          { outerSignal: exec && exec.signal },
        );
        if (!data || !data.ok) return failure(data, 'status', status);
        const p = data.project || {};
        return {
          ok: true,
          project: {
            id: String(p.id || ''),
            title: String(p.title || ''),
            scenes: summarizeScenes(p.scenes),
            cache: Object.keys(p.cache || {}).length,
          },
        };
      }

      // 第三步：渲染。auto 只重画改过的场次，audio 只重做声音。
      const { status, data } = await requestJson('POST', `${baseUrl}/v1/project/render`, {
        body: { id, scope: String(a.scope), style: a.style == null ? '' : String(a.style), voice: a.voice, bgm: a.bgm },
        timeoutMs: RENDER_TIMEOUT_MS,
        outerSignal: exec && exec.signal,
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

  // ---------------------------------------------------------------------
  // 独立生成一段 AI 视频：不走分镜、不建项目，就是"给我一段画面" -----
  // 和 make_video 的分工：人物/场景/动作/氛围 → gen_video（AI 生成，慢、占额度）；
  // 公式/坐标/曲线/推导 → make_video（manim，精确、可复现）。
  ctx.tools.register({
    name: 'gen_video',
    description:
      'Generate ONE short AI-generated video clip from an English prompt (wan3.0-video). '
      + 'This is real AI imagery: good for people, places, action, atmosphere. '
      + 'It is SLOW (~100 s per clip), consumes quota, and cannot draw accurate formulas or charts — '
      + 'for math/formula/coordinate animation use make_video (manim) instead. '
      + 'e.g. gen_video({prompt:"anime style, cel shading, wide shot, a girl flying over a snowy plain", seconds:5}). '
      + 'Prompt must be English, subject + action + style + camera, <=120 chars. '
      + 'Returns {ok, path, ms, taskId}; the clip is 5 or 10 s at 1280*720. Timeout 480 s.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: '英文画面描述：主体 + 动作 + 风格 + 镜头，≤120 字符；不要写公式、坐标轴、标题文字。',
        },
        seconds: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: '期望时长；模型只出 5 秒或 10 秒，默认 5（>5 就生成 10 秒）。',
        },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textBlock(describeGenVideo(v)) },
    // 生成一条实测 ~100 秒；给 480 秒总预算（任务书要求），超时明确报 TIMEOUT 而不是挂着
    timeoutMs: GEN_VIDEO_TIMEOUT_MS,
    async execute(args, exec) {
      const a = args || {};
      const prompt = String(a.prompt || '').trim();
      if (!prompt) {
        return {
          ok: false,
          stage: 'input',
          error: 'PROMPT_REQUIRED',
          message: 'prompt 不能为空：给一句英文画面描述（主体 + 动作 + 风格 + 镜头）。',
        };
      }
      const seconds = a.seconds == null
        ? 5
        : Math.min(10, Math.max(1, Math.round(Number(a.seconds) || 5)));

      const { status, data } = await requestJson('POST', `${baseUrl}/v1/aivideo`, {
        body: { prompt, seconds },
        timeoutMs: GEN_VIDEO_TIMEOUT_MS,
        outerSignal: exec && exec.signal,
      });
      if (!data || !data.ok) return failure(data, 'gen_video', status);
      return {
        ok: true,
        path: String(data.path || data.file || ''),
        ms: Number(data.ms) || 0,
        taskId: String(data.taskId || ''),
        bytes: Number(data.bytes) || 0,
        seconds: Number(data.seconds) || 0,
        width: Number(data.width) || 0,
        height: Number(data.height) || 0,
        prompt: String(data.prompt || prompt),
      };
    },
  });
}

/**
 * 分镜 → 补 manim 代码 → 渲染。
 * 写稿模式和分镜模式共用：两边的差别只是"场景从哪来"。
 * from-scenes 会把项目一起建/更新好，所以这里直接用返回的 project.id 渲染，
 * 不再重复建项目（重复建会让项目列表充满半成品）。
 */
async function fillAndRender(input) {
  const { mode, baseUrl, title, projectId, scenes, style, voice, exec } = input;
  const filled = await requestJson('POST', `${baseUrl}/v1/storyboard/from-scenes`, {
    body: { title, projectId, scenes, style, voice },
    timeoutMs: FILL_TIMEOUT_MS,
    outerSignal: exec && exec.signal,
  });
  if (!filled.data || !filled.data.ok) return failure(filled.data, 'storyboard', filled.status);
  const data = filled.data;
  const stats = data.stats || {};
  const summary = {
    ok: true,
    mode,
    planOnly: true,
    projectId: String((data.project && data.project.id) || ''),
    title: String(data.title || ''),
    scenes: summarizeScenes(data.scenes),
    stats: {
      total: Number(stats.total) || 0,
      manim: Number(stats.manim) || 0,
      aivideo: Number(stats.aivideo) || 0,
      text: Number(stats.text) || 0,
      fallback: Number(stats.fallback) || 0,
      manimRatio: Number(stats.manimRatio) || 0,
    },
    warnings: data.warnings || [],
    estimate: data.estimate || null,
    binding: data.bindingSummary || '',
  };

  // 只有故事板：到此为止
  if (input.planOnly) return summary;

  if (!summary.projectId) {
    return { ok: false, stage: 'project', error: 'NO_PROJECT_ID', message: '分镜补全后没拿到项目 id，没法渲染。' };
  }

  const rendered = await requestJson('POST', `${baseUrl}/v1/project/render`, {
    body: { id: summary.projectId, scope: 'auto', style, voice },
    timeoutMs: RENDER_TIMEOUT_MS,
    outerSignal: exec && exec.signal,
  });
  if (!rendered.data || !rendered.data.ok) {
    const f = failure(rendered.data, 'render', rendered.status);
    // 渲染失败时把已经补好的分镜一起带回去：模型可以只重试渲染，不用重写代码。
    return Object.assign(f, {
      projectId: summary.projectId,
      stats: summary.stats,
      scenes: summary.scenes,
    });
  }
  const r = rendered.data;
  return {
    ok: true,
    mode,
    projectId: summary.projectId,
    jobId: String(r.renderId || r.jobId || ''),
    title: summary.title,
    seconds: Number(r.seconds) || 0,
    scenes: summary.scenes,
    stats: summary.stats,
    bytes: Number(r.bytes) || 0,
    ms: Number(r.ms) || 0,
    reused: Number(r.reused) || 0,
    rendered: Number(r.rendered) || 0,
    estimate: summary.estimate,
    binding: summary.binding,
  };
}

/**
 * gen_video 的人话小结。
 * 第一句就说清"生成了什么、多大、花了多久"，路径原样给出 ——
 * 模型下一步可能要用这个文件（塞进项目/交给用户），路径就是它的句柄。
 */
function describeGenVideo(value) {
  if (!value || value.ok === false) {
    const lines = [`没有生成 AI 片段：${(value && value.error) || '未知原因'}。`];
    if (value && value.hint) lines.push(String(value.hint));
    lines.push(JSON.stringify(value));
    return lines.join('\n');
  }
  const kb = Math.round((Number(value.bytes) || 0) / 1024);
  const size = value.width && value.height ? `，${value.width}x${value.height}` : '';
  const head = `AI 片段已生成：${value.seconds || 0} 秒${size}，约 ${kb} KB，耗时 ${((Number(value.ms) || 0) / 1000).toFixed(1)} 秒。`;
  return [
    head,
    `文件：${value.path}`,
    `taskId：${value.taskId || '(无)'}`,
    JSON.stringify(value),
  ].join('\n');
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
  if (videoUrl && value.jobId) lines.push(`可用 ${videoUrl}/api/studio/video?id=${encodeURIComponent(value.jobId)} 取回。`);
  return lines;
}

/**
 * make_video 的人话小结。
 * 第一句就是"成片已生成 + 怎么取回"，后面才是结构化 JSON —— 模型先读结论，
 * 需要 jobId 或某场台词时再读 JSON，不用自己从大对象里翻。
 */
function describeVideo(value, videoUrl) {
  if (!value || value.ok === false) {
    const stage = value && value.stage;
    const head = stage === 'render'
      ? '没有渲染成功'
      : stage === 'storyboard'
        ? '分镜没生成出来'
        : '没有生成成片';
    const lines = [`${head}：${(value && value.error) || '未知原因'}。`];
    if (value && value.speakError === 'BREEZEBLUE_UNAVAILABLE') {
      lines.push(`配音服务不可用（已重试 ${value.attempts || 0} 次），等一会儿再试。`);
    } else if (value && value.speakError === 'QUEUE_TIMEOUT') {
      lines.push('配音排队超时：另一个任务占着音色队列，等一会儿再试。');
    } else if (value && value.hint) {
      lines.push(String(value.hint));
    }
    lines.push(JSON.stringify(value));
    return lines.join('\n');
  }
  const kb = Math.round((Number(value.bytes) || 0) / 1024);
  const stats = value.stats || {};
  const manim = stats.manim != null ? `，manim ${stats.manim} 场` : '';
  const head = `成片已生成：《${value.title || '未命名'}》${value.seconds} 秒，${(value.scenes || []).length} 场${manim}，约 ${kb} KB。`;
  const lines = [head];
  if (videoUrl && value.jobId) {
    lines.push(`可用 ${videoUrl}/api/studio/video?id=${encodeURIComponent(value.jobId)} 取回。`);
  }
  lines.push(JSON.stringify(value));
  return lines.join('\n');
}

/**
 * 只出分镜时的人话小结：强调"只写了分镜，还没渲染"，
 * 并说清 manim 代码生成情况（哪几场没有画），避免模型把分镜当成成片。
 */
function describePlan(value) {
  if (!value || value.ok === false) {
    return `没有写出分镜：${(value && value.error) || '未知原因'}。\n` + JSON.stringify(value);
  }
  const scenes = value.scenes || [];
  const withCode = scenes.filter((s) => s && s.manim).length;
  const stats = value.stats;
  const ratio = stats ? `${stats.manim}/${stats.total} 场 manim` : `${withCode}/${scenes.length} 场有 manim 代码`;
  const head = `分镜已写好：《${value.title || '未命名'}》${scenes.length} 场，${ratio}。`
    + '这只是分镜（还没渲染）；确认后去掉 plan_only 再调用一次才出片。';
  const warn = Array.isArray(value.warnings) && value.warnings.length ? `\n注意：${value.warnings.join(' ')}` : '';
  return `${head}${warn}\n${JSON.stringify(value)}`;
}

// 测试用：失败文案里"已重试 N 次"这类句子只能靠单测保证，不能靠跑真服务。
export const __describeVideoForTest = describeVideo;
export const __describeGenVideoForTest = describeGenVideo;

