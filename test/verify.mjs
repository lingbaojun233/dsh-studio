// verify.mjs -- dsh-studio 自检：不依赖网络、不依赖真实 ffmpeg。
// 覆盖：导出形状、工具清单、参数 schema、以及三个工具打到桩服务上的路径是否正确。
import assert from 'node:assert/strict';
import http from 'node:http';

const seen = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const plan = { title: 't', scenes: [{ text: 'a', seconds: 3, narration: 'n' }] };
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/v1/plan')) return send({ ok: true, plan });
    if (req.url.startsWith('/v1/create')) return send({ ok: true, jobId: 'j1', seconds: 3, bytes: 100, plan });
    if (req.url.startsWith('/v1/project/patch')) return send({ ok: true, touched: [0], scenes: 1, willRebuild: [], willReuse: [0] });
    if (req.url.startsWith('/v1/project/render')) return send({ ok: true, renderId: 'r1', seconds: 3, bytes: 100, reused: 1, rendered: 0, ms: 5 });
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
    assert.ok(def.description && def.description.length <= 200, `${name} 描述应短于 200 字符`);
    assert.equal(def.parameters.type, 'object', `${name} 参数应为 object`);
    assert.ok(Array.isArray(def.parameters.required), `${name} 应有 required`);
  }

  // make_video plan_only → 只打 /v1/plan
  seen.length = 0;
  await tools.get('make_video').execute({ prompt: 'x', plan_only: true });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/plan']);

  // make_video → 打 /v1/create
  seen.length = 0;
  await tools.get('make_video').execute({ prompt: 'x', seconds: 10 });
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['/v1/create']);

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

  console.log('PASS  dsh-studio 自检通过（3 个工具，路径分配正确）');
} finally {
  stub.close();
}
