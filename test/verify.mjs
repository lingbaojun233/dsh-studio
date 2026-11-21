/**
 * dsh-studio 的本地验收脚本（零依赖，只用 Node 内置）。
 *
 * 它做三件事：
 *  1. 起一个本地桩服务，模拟 studio 的 /v1/plan、/v1/create，并记录收到的 body；
 *  2. 直接 import 插件的 index.js，注入假的 ctx.tools.register（不需要装 DSH）；
 *  3. 逐个调用工具，断言"参数透传"和"返回值摘要"都对。
 *
 * 为什么要留在仓库里：改完插件跑 `node test/verify.mjs` 就能知道有没有把
 * prompt/seconds/voice/bgm 传歪，不用真起 ffmpeg 渲一遍（渲染一次 15~40 秒）。
 *
 * 跑法：node test/verify.mjs
 */

import http from 'node:http';
import assert from 'node:assert/strict';

// 先清掉可能从宿主继承来的变量，保证测试可重复
delete process.env.DSH_STUDIO_URL;
delete process.env.DSH_STUDIO_VIDEO_URL;

const requests = [];   // { method, path, query, body }
let mode = 'ok';       // 'ok' | 'fail-plan'

// 桩返回的分镜：带 bg / actualSeconds 这些内部字段，验证插件确实"摘要"而不是原样透传。
const PLAN = {
  title: '验收样片',
  totalSeconds: 11.6,
  scenes: [
    { text: '第一场', narration: '旁白一', seconds: 3, bg: { c0: '#0b1a3a', c1: '#ff7a3d' }, actualSeconds: 3.2, narrationMs: 1200 },
    { text: '第二场', narration: '旁白二', seconds: 4, bg: { c0: '#101a33', c1: '#3a2a5a' }, actualSeconds: 4, narrationMs: 0 },
    { text: '第三场', narration: '', seconds: 5, bg: { c0: '#000000', c1: '#ffffff' }, actualSeconds: 5, narrationMs: 0 },
  ],
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body = null;
  if (req.method === 'POST') {
    const raw = await readBody(req);
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = { raw };
    }
  }
  requests.push({ method: req.method, path: url.pathname, query: url.search, body });

  if (req.method === 'POST' && url.pathname === '/v1/plan') {
    if (mode === 'fail-plan') {
      return json(res, 200, { ok: false, step: 'plan', error: 'PLAN_NOT_JSON', raw: '模型没按 JSON 回' });
    }
    return json(res, 200, { ok: true, plan: PLAN });
  }

  if (req.method === 'POST' && url.pathname === '/v1/create') {
    if (mode === 'fail-plan') {
      return json(res, 200, { ok: false, step: 'plan', error: 'PLAN_NOT_JSON', raw: '模型没按 JSON 回' });
    }
    return json(res, 200, {
      ok: true,
      file: 'C:\\tmp\\studio\\job-abc-123.mp4',   // 绝对路径：插件不该把它透给模型
      jobId: 'job-abc-123',
      bytes: 987654,
      seconds: 12.4,
      plan: PLAN,
      narrationCount: 2,
      overBudget: false,
      bgm: null,
      ms: 22345,
    });
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** 假 ctx：只实现插件真正用到的 ctx.tools.register。 */
function makeCtx() {
  const tools = new Map();
  const ctx = { tools: { register(def) { tools.set(def.name, def); } } };
  return { ctx, tools };
}

function renderText(tool, args, value) {
  const blocks = tool.output.render(args, value);
  assert.ok(Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text', 'render 应返回一个 text block');
  return blocks[0].text;
}

async function main() {
  const port = await listen(server);
  const stub = `http://127.0.0.1:${port}`;

  const mod = await import(new URL('../index.js', import.meta.url));
  assert.equal(mod.name, 'dsh-studio', 'export const name 应为 dsh-studio');
  assert.deepEqual(mod.inject, ['tools'], 'inject 应为 tools');

  // ---- 1. 注册 + 工具表 -------------------------------------------------
  const { ctx, tools } = makeCtx();
  // videoUrl 也指到桩上：取片地址只是拼字符串，不会真的去请求
  mod.apply(ctx, { baseUrl: stub, videoUrl: stub });
  assert.deepEqual([...tools.keys()], ['make_video', 'make_plan'], '应只注册两个工具');
  console.log('PASS  注册工具：make_video / make_plan');

  const makePlan = tools.get('make_plan');
  const makeVideo = tools.get('make_video');

  // 描述里必须保留的关键事实（换模型/换宿主时这些约束就是"别乱调"的唯一依据）
  for (const [tool, facts] of [
    [makeVideo, [/really renders/, /1200/, /15–40/, /make_plan/, /storyboard/]],
    [makePlan, [/without rendering/, /scenes/, /make_video/]],
  ]) {
    for (const re of facts) assert.match(tool.description, re, `${tool.name} 的 description 少了 ${re}`);
  }
  console.log('PASS  工具描述保留关键约束（真渲染 / 1200s / 15–40s / 先 plan 后 render）');

  // ---- 2. make_plan：参数透传 + 返回摘要 ---------------------------------
  requests.length = 0;
  const planArgs = { prompt: '海边日落', seconds: 10 };
  const planValue = await makePlan.execute(planArgs);
  assert.equal(requests.length, 1, 'make_plan 应只发一次请求');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/v1/plan', 'make_plan 应 POST /v1/plan');
  assert.deepEqual(requests[0].body, { prompt: '海边日落', seconds: 10 }, 'make_plan body 应只含 prompt/seconds');
  assert.deepEqual(Object.keys(planValue).sort(), ['ok', 'scenes', 'seconds', 'title'], 'make_plan 返回字段');
  assert.equal(planValue.ok, true);
  assert.equal(planValue.title, '验收样片');
  assert.equal(planValue.seconds, 11.6, 'seconds 取 plan.totalSeconds');
  assert.equal(planValue.scenes.length, 3);
  assert.deepEqual(planValue.scenes[0], { text: '第一场', seconds: 3, narration: '旁白一' },
    '每场只留 text/seconds/narration（bg/actualSeconds 属于内部结构）');
  const planText = renderText(makePlan, planArgs, planValue);
  assert.match(planText, /分镜已写好/);
  assert.match(planText, /还没有渲染/);
  console.log('PASS  make_plan：body={prompt,seconds}，返回 3 场摘要 + "还没渲染"提示');
  console.log('      桩收到:', 'POST /v1/plan', JSON.stringify(requests[0].body));

  // ---- 3. make_video：全参数透传 + 摘要 --------------------------------
  requests.length = 0;
  const createArgs = { prompt: '海边日落', seconds: 20, voice: 'zh-female', bgm: 'sunset.mp3' };
  const videoValue = await makeVideo.execute(createArgs);
  assert.equal(requests.length, 1, 'make_video 应只发一次请求');
  assert.equal(requests[0].path, '/v1/create', 'make_video 应 POST /v1/create');
  assert.deepEqual(requests[0].body, createArgs, 'voice/bgm 必须原样透传');
  assert.deepEqual(Object.keys(videoValue).sort(),
    ['bytes', 'jobId', 'ms', 'ok', 'scenes', 'seconds', 'title'], 'make_video 返回字段');
  assert.equal(videoValue.jobId, 'job-abc-123');
  assert.equal(videoValue.bytes, 987654);
  assert.equal(videoValue.ms, 22345);
  assert.equal(videoValue.seconds, 12.4, 'seconds 取服务端重算后的总时长');
  assert.equal(videoValue.plan, undefined, '不能把整个 plan 塞进返回值');
  assert.equal(videoValue.file, undefined, '不能把服务器本地文件路径透给模型');
  assert.deepEqual(videoValue.scenes[0], { text: '第一场', seconds: 3, narration: '旁白一' },
    'scene 摘要只保留三个字段');
  assert.doesNotMatch(JSON.stringify(videoValue), /#0b1a3a/, 'bg 颜色不该出现在返回值里');

  const videoText = renderText(makeVideo, createArgs, videoValue);
  assert.match(videoText, /成片已生成/);
  assert.ok(videoText.includes(`${stub}/v1/video?id=job-abc-123`), '配置了 videoUrl 时文本要给取回地址');
  assert.ok(videoText.length < 2000, '取回文本不能太长');
  console.log('PASS  make_video：body 全字段透传，返回 3 场摘要（无 plan / 无本地路径）+ 取片地址');
  console.log('      桩收到:', 'POST /v1/create', JSON.stringify(requests[0].body));
  console.log('      返回:', JSON.stringify(videoValue));

  // ---- 4. seconds 收敛到 8~30 ------------------------------------------
  requests.length = 0;
  await makeVideo.execute({ prompt: '太短', seconds: 1 });
  assert.equal(requests[0].body.seconds, 8, 'seconds<8 应收敛到 8');
  await makePlan.execute({ prompt: '太长', seconds: 999 });
  assert.equal(requests[1].body.seconds, 30, 'seconds>30 应收敛到 30');
  console.log('PASS  seconds 边界：1→8，999→30');

  // ---- 5. 环境变量兜底 + 默认 12 秒 ------------------------------------
  process.env.DSH_STUDIO_URL = stub;
  const envCtx = makeCtx();
  mod.apply(envCtx.ctx, {});
  requests.length = 0;
  await envCtx.tools.get('make_plan').execute({ prompt: '环境变量兜底' });
  assert.equal(requests.length, 1, 'DSH_STUDIO_URL 兜底时也应打到桩服务');
  assert.equal(requests[0].body.seconds, 12, '没传 seconds 时默认 12');
  console.log('PASS  DSH_STUDIO_URL 兜底生效，seconds 默认 12');

  // ---- 6. videoUrl 可配置、可显式关闭 ----------------------------------
  // 先确认"没配 videoUrl"时的默认值 8766（只是拼字符串，不会真的去请求）
  const defaultVideoCtx = makeCtx();
  mod.apply(defaultVideoCtx.ctx, { baseUrl: stub });
  const defaultValue = await defaultVideoCtx.tools.get('make_video').execute({ prompt: '默认取片地址' });
  assert.match(renderText(defaultVideoCtx.tools.get('make_video'), {}, defaultValue),
    /http:\/\/127\.0\.0\.1:8766\/v1\/video\?id=job-abc-123/, '默认 videoUrl 应为 8766');

  const customCtx = makeCtx();
  mod.apply(customCtx.ctx, { baseUrl: stub, videoUrl: 'http://127.0.0.1:9999/' });
  const customValue = await customCtx.tools.get('make_video').execute({ prompt: '自定义取片' });
  const customText = renderText(customCtx.tools.get('make_video'), {}, customValue);
  assert.match(customText, /http:\/\/127\.0\.0\.1:9999\/v1\/video\?id=job-abc-123/, '自定义 videoUrl 应生效且去掉尾部斜杠');

  const offCtx = makeCtx();
  mod.apply(offCtx.ctx, { baseUrl: stub, videoUrl: '' });
  const offValue = await offCtx.tools.get('make_video').execute({ prompt: '不要取片地址' });
  const offText = renderText(offCtx.tools.get('make_video'), {}, offValue);
  assert.doesNotMatch(offText, /\/v1\/video\?id=/, 'videoUrl 为空串时应关掉取回提示');
  console.log('PASS  videoUrl：可自定义（去尾斜杠），空串时关闭取回提示');

  // ---- 7. 失败路径：结构化而不是抛异常 ---------------------------------
  mode = 'fail-plan';
  requests.length = 0;
  const failed = await makeVideo.execute({ prompt: '会失败' });
  assert.deepEqual(Object.keys(failed).sort(), ['error', 'ok', 'raw', 'stage'], '失败结果字段');
  assert.equal(failed.ok, false);
  assert.equal(failed.stage, 'plan', '失败步骤应取服务端的 step');
  assert.equal(failed.error, 'PLAN_NOT_JSON');
  const failedText = renderText(makeVideo, {}, failed);
  assert.match(failedText, /没有生成成片/);
  mode = 'ok';
  console.log('PASS  失败路径：ok:false + stage:plan + error:PLAN_NOT_JSON，不抛异常');

  console.log('\n全部通过：dsh-studio');
}

main()
  .then(() => new Promise((resolve) => server.close(resolve)))
  .catch((err) => {
    console.error('\nFAIL', err && err.stack || err);
    server.close(() => process.exit(1));
  });
