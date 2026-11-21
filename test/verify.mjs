// verify.mjs -- dsh-studio 自检：不依赖网络、不依赖真实 ffmpeg。
// 覆盖：导出形状、工具清单、参数 schema、make_video 三种输入的路径分配，
// 以及 project_create / project_apply 的老路径没被改坏。
import assert from 'node:assert/strict';
import http from 'node:http';

const seen = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const plan = { title: 't', totalSeconds: 8, scenes: [{ text: 'a', seconds: 8, narration: 'n', kind: 'manim', manim: { code: 'x = 1' } }] };
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/v1/plan')) return send({ ok: true, plan });
    if (req.url.startsWith('/v1/create')) return send({ ok: true, jobId: 'j1', seconds: 8, bytes: 100, plan });
    if (req.url.startsWith('/v1/storyboard/from-script')) {
      return send({
        ok: true,
        title: 't',
        project: { id: 'p1' },
        scenes: [{ index: 0, text: 'a', narration: 'n', seconds: 8, visual_hint: '画一条曲线', tool: 'manim' }],
        warnings: [],
        estimate: { seconds: 8, credits: 1 },
      });
    }
    if (req.url.startsWith('/v1/storyboard/from-scenes')) {
      return send({
        ok: true,
        title: 't',
        project: { id: 'p9' },
        scenes: [{ index: 0, text: 'a', narration: 'n', seconds: 8, tool: 'manim', status: 'manim', kind: 'manim', manim: { code: 'x = 1', scene: 'S' } }],
        stats: { total: 1, manim: 1, text: 0, fallback: 0, manimRatio: 100 },
        warnings: [],
        estimate: { seconds: 8, credits: 1 },
      });
    }
    if (req.url.startsWith('/v1/project/patch')) return send({ ok: true, touched: [0], scenes: 1, willRebuild: [], willReuse: [0] });
    if (req.url.startsWith('/v1/project/render')) return send({ ok: true, renderId: 'r1', seconds: 8, bytes: 100, reused: 0, rendered: 1, ms: 5 });
    if (req.url.startsWith('/v1/project')) return send({ ok: true, project: { id: 'p1', title: 't', scenes: [], cache: {} } });
    return send({ ok: false, error: 'unexpected' });
  });
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;

function makeCtx() {
  const tools = new Map();
  return { ctx: { tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name); } } }, tools };
}

try {
  const mod = await import(new URL('../index.js', import.meta.url));
  assert.equal(mod.name, 'dsh-studio');
  assert.deepEqual(mod.inject, ['tools'], 'inject 应为 tools');

  const { ctx, tools } = makeCtx();
  mod.apply(ctx, { baseUrl: base, videoUrl: base });
  assert.deepEqual([...tools.keys()].sort(), ['make_video', 'project_apply', 'project_create']);

  for (const [name, def] of tools) {
    assert.ok(def.description && def.description.length <= 2200, `${name} 描述过长`);
    assert.equal(def.parameters.type, 'object', `${name} 参数应为 object`);
    if (name === 'make_video') {
      // 三种输入三选一，没有必填项；但三个字段必须在 schema 里
      for (const key of ['topic', 'script', 'storyboard']) {
        assert.ok(def.parameters.properties[key], `make_video 缺 ${key} 参数`);
      }
    } else {
      assert.ok(Array.isArray(def.parameters.required), `${name} 应有 required`);
    }
  }

  // make_video 描述里三种用法都要有例子（模型靠它决定怎么填参数）
  const desc = tools.get('make_video').description;
  for (const word of ['topic', 'script', 'storyboard', 'plan_only', 'visual_hint']) {
    assert.ok(desc.includes(word), `make_video 描述缺少 ${word}`);
  }

  // topic + plan_only → 只打 /v1/plan
  seen.length = 0;
  const topicPlan = await tools.get('make_video').execute({ topic: 'x', plan_only: true });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/plan']);
  assert.equal(topicPlan.ok, true);

  // topic → /v1/create
  seen.length = 0;
  const topicVideo = await tools.get('make_video').execute({ topic: 'x', seconds: 20 });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/create']);
  assert.equal(topicVideo.ok, true);
  assert.equal(topicVideo.jobId, 'j1');

  // script + plan_only → 只拆场，不补代码、不渲染
  seen.length = 0;
  const scriptPlan = await tools.get('make_video').execute({ script: '导数是变化率。', seconds: 60, plan_only: true });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/storyboard/from-script']);
  assert.equal(scriptPlan.ok, true);
  assert.equal(scriptPlan.projectId, 'p1');
  assert.equal(scriptPlan.scenes[0].visual_hint, '画一条曲线');

  // script 渲染 → 拆场 + 补代码 + 渲染项目
  seen.length = 0;
  const scriptVideo = await tools.get('make_video').execute({ script: '导数是变化率。', seconds: 60 });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]),
    ['/v1/storyboard/from-script', '/v1/storyboard/from-scenes', '/v1/project/render']);
  assert.equal(scriptVideo.ok, true);
  assert.equal(scriptVideo.jobId, 'r1');
  assert.equal(seen[1].body.projectId, 'p1', '补代码要用拆场返回的项目 id');
  assert.equal(seen[2].body.id, 'p9', '渲染要用补代码返回的项目 id');

  // storyboard + plan_only → 只补代码，不渲染；返回里要能看出生成成功
  seen.length = 0;
  const sbPlan = await tools.get('make_video').execute({
    storyboard: [{ text: '割线变切线', narration: '让两点越来越近', seconds: 10, visual_hint: '画坐标轴和切线', tool: 'manim' }],
    plan_only: true,
  });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/storyboard/from-scenes']);
  assert.equal(sbPlan.ok, true);
  assert.equal(sbPlan.scenes[0].manim, true);
  assert.equal(sbPlan.stats.manim, 1);
  assert.equal(seen[0].body.scenes[0].text, '割线变切线');
  assert.equal(seen[0].body.scenes[0].visual_hint, '画坐标轴和切线');

  // storyboard 渲染 → 补代码 + 渲染项目
  seen.length = 0;
  const sbVideo = await tools.get('make_video').execute({
    storyboard: [{ text: '小结', narration: '导数就是变化率', seconds: 5, tool: 'text' }],
  });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/storyboard/from-scenes', '/v1/project/render']);
  assert.equal(sbVideo.ok, true);

  // 三个输入都空 / 给了两个 → 直接报错，不发请求
  seen.length = 0;
  const none = await tools.get('make_video').execute({});
  assert.equal(none.ok, false);
  assert.equal(none.error, 'CHOOSE_ONE_MODE');
  const two = await tools.get('make_video').execute({ topic: 'x', script: 'y' });
  assert.equal(two.ok, false);
  assert.equal(seen.length, 0, '参数错了不该发请求');

  // project_apply：只 patches
  seen.length = 0;
  await tools.get('project_apply').execute({ id: 'p1', patches: [{ op: 'patch', index: 0, patch: { text: 'b' } }] });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/project/patch']);

  // project_apply：patch + render
  seen.length = 0;
  await tools.get('project_apply').execute({ id: 'p1', patches: [{ op: 'patch', index: 0, patch: { text: 'b' } }], scope: 'audio' });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/project/patch', '/v1/project/render']);

  // project_apply：只 scope
  seen.length = 0;
  await tools.get('project_apply').execute({ id: 'p1', scope: 'auto' });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/project/render']);

  // project_create
  seen.length = 0;
  const created = await tools.get('project_create').execute({ title: 't' });
  assert.equal(created.ok, true);
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/project']);

  // 失败结果要保留配音错误码与重试次数（模型才能解释"为什么没成"）
  const failDesc = mod.__describeVideoForTest
    ? mod.__describeVideoForTest({ ok: false, stage: 'render', error: 'VOICE_UNAVAILABLE', speakError: 'BREEZEBLUE_UNAVAILABLE', attempts: 4 })
    : '';
  if (failDesc) assert.ok(failDesc.includes('重试 4 次'), '失败文案应带重试次数');

  console.log('PASS  dsh-studio 自检通过（make_video 三种输入 + 项目工具路径分配正确）');
} finally {
  stub.close();
}
