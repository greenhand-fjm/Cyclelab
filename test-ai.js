const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');
const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, 'functions/index.ts'), 'utf8'));
let passed = 0;
let failed = 0;
function providerReply(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function close(actual, expected) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10,
    `expected ${expected}, received ${actual}`);
}
function serverCall(name, ...args) {
  const runtime = createRuntime();
  assert.equal(typeof runtime.context[name], 'function', name + ' must be implemented');
  return plain(runtime.context[name](...args));
}
function createFrontend() {
  const elements = new Map();
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', textContent: '', className: '', disabled: false });
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector(selector) {
      assert.equal(selector, '.derivation');
      return document.getElementById('derivation');
    },
  };
  const context = vm.createContext({ document, window: {}, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'thermo.js'), 'utf8'), context);
  return { context, document };
}
function createRuntime(fetchImpl, key = 'test-placeholder', env = {}) {
  let handler;
  const context = vm.createContext({
    Deno: { env: { get: name => name === 'DASHSCOPE_API_KEY' ? key : env[name] }, serve: fn => { handler = fn; } },
    Request, Response, URL, AbortController, Map, Date, setTimeout, clearTimeout,
    console: { error() {} }, fetch: fetchImpl,
  });
  vm.runInContext(source, context);
  return { context, request: (path, data) => handler(new Request('https://test.invalid/ai/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })) };
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (error) {
    failed++;
    console.error('FAIL ' + name + '\n' + error.stack);
  }
}
(async () => {
  for (const [status, providerCode, expected] of [
    [401, '', 'upstream_auth_failed'], [403, '', 'upstream_access_denied'],
    [429, 'Arrearage', 'upstream_quota_exhausted'],
    [429, 'Throttling.RateQuota', 'upstream_rate_limited'],
    [429, 'unrecognized', 'upstream_quota_or_rate_limit'],
    [404, '', 'upstream_model_unavailable'], [502, '', 'upstream_unavailable'],
  ]) {
    await test('safe upstream classification ' + status + ' ' + providerCode, async () => {
      const runtime = createRuntime(async () => new Response(JSON.stringify({ error: { code: providerCode, message: 'private-provider-detail' } }), { status }));
      const response = await runtime.request('ask', { question: '定容吸热是什么？' });
      const body = await response.json();
      assert.equal(body.code, expected);
      assert.equal(response.status, 503);
      assert.ok(!JSON.stringify(body).includes('private-provider-detail'));
      assert.ok(!JSON.stringify(body).includes('test-placeholder'));
    });
  }
  await test('missing secret handled safely', async () => {
    const runtime = createRuntime(() => { throw Error('must not fetch'); }, undefined);
    runtime.context.Deno.env.get = () => undefined;
    assert.equal((await (await runtime.request('ask', { question: '测试' })).json()).code, 'service_not_configured');
  });
  await test('default upstream is Qianwen platform chat completions with qwen-flash', async () => {
    let captured;
    const runtime = createRuntime(async (url, options) => {
      captured = { url, body: JSON.parse(options.body), authorization: options.headers.Authorization };
      return new Response(JSON.stringify({ choices: [{ message: { content: '回答' } }] }));
    });
    assert.equal((await runtime.request('ask', { question: '测试' })).status, 200);
    assert.equal(captured.url, 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions');
    assert.equal(captured.body.model, 'qwen-flash');
    assert.equal(captured.body.max_tokens, 300);
    assert.equal(captured.authorization, 'Bearer test-placeholder');
  });
  await test('AI_BASE_URL override is honored and trailing slash removed', async () => {
    let capturedUrl;
    const runtime = createRuntime(async url => {
      capturedUrl = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: '回答' } }] }));
    }, 'test-placeholder', { AI_BASE_URL: 'https://example.invalid/openai/v1/' });
    assert.equal((await runtime.request('ask', { question: '测试' })).status, 200);
    assert.equal(capturedUrl, 'https://example.invalid/openai/v1/chat/completions');
  });
  await test('output token default and global cap are 300', async () => {
    let sent;
    const runtime = createRuntime(async (url, options) => {
      sent = JSON.parse(options.body).max_tokens;
      return providerReply('回答');
    });
    await runtime.request('ask', { question: '测试' });
    assert.equal(sent, 300);
    await vm.runInContext('callDashScope([])', runtime.context);
    assert.equal(sent, 300);
    await vm.runInContext('callDashScope([], 5000)', runtime.context);
    assert.equal(sent, 300);
    await vm.runInContext('callDashScope([], 80)', runtime.context);
    assert.equal(sent, 80);
  });
  await test('upstream failure exposes sanitized status/code but not provider message', async () => {
    const runtime = createRuntime(async () => new Response(JSON.stringify({ error: { code: 'InvalidApiKey', message: 'private-provider-detail' } }), { status: 401 }));
    const response = await runtime.request('ask', { question: '测试' });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 'upstream_auth_failed');
    assert.equal(body.upstream_status, 401);
    assert.equal(body.upstream_code, 'InvalidApiKey');
    assert.ok(!JSON.stringify(body).includes('private-provider-detail'));
    assert.ok(!JSON.stringify(body).includes('test-placeholder'));
  });
  for (const [path, length] of [['parse-question', 1001], ['ask', 201]]) {
    await test(path + ' input length rejected before provider call', async () => {
      const runtime = createRuntime(() => { throw Error('must not fetch'); });
      assert.equal((await runtime.request(path, { question: '字'.repeat(length) })).status, 400);
    });
  }
  await test('real handler per-IP minute limit', async () => {
    const runtime = createRuntime(async () => new Response(JSON.stringify({ choices: [{ message: { content: '解释' } }] })));
    for (let i = 0; i < 5; i++) assert.equal((await runtime.request('ask', { question: '测试' })).status, 200);
    assert.equal((await runtime.request('ask', { question: '测试' })).status, 429);
  });
  await test('real handler per-IP daily limit', () => {
    const runtime = createRuntime();
    vm.runInContext('rateLimits.set("test", {minute:[],day:Array(50).fill(Date.now()-120000)})', runtime.context);
    assert.equal(vm.runInContext('checkRateLimit("test").allowed', runtime.context), false);
  });
  await test('real handler global daily limit', () => {
    const runtime = createRuntime();
    vm.runInContext('globalDailyCount=199', runtime.context);
    assert.equal(vm.runInContext('checkRateLimit("a").allowed', runtime.context), true);
    assert.equal(vm.runInContext('checkRateLimit("b").allowed', runtime.context), false);
  });
  await test('provider timeout mapped safely', async () => {
    const runtime = createRuntime(async () => { const error = new Error('private'); error.name = 'AbortError'; throw error; });
    assert.equal((await runtime.request('ask', { question: '测试' })).status, 504);
  });
  await test('explicit 290 K overrides a wrong model T1', () => {
    const result = serverCall('correctQuestionParams', '奥托循环初始温度为290K，求热效率。',
      { cycle: 'otto', params: { r: 9, T1: 300, T3: null, p1: null }, assumed: [], question: '求热效率' });
    assert.equal(result.params.T1, 290);
    assert.deepEqual(result.corrected, ['T1']);
    assert.equal(result.params.r, 9);
    assert.equal(result.question, '求热效率');
  });
  await test('explicit negative Celsius and MPa are converted', () => {
    const result = serverCall('extractExplicitParams', '初始温度为-10°C，初始压力为0.095MPa。');
    close(result.T1, 263.15);
    close(result.p1, 95);
  });
  for (const [question, T1, T3] of [
    ['初始温度290K，最高温度1800K。', 290, 1800],
    ['最高温度1800K，初始温度290K。', 290, 1800],
    ['涡轮进口温度为1400K，初始温度为290K。', 290, 1400],
    ['初始温度为290K，涡轮进口温度为1400K。', 290, 1400],
  ]) {
    await test('temperature roles: ' + question, () => {
      const result = serverCall('extractExplicitParams', question);
      assert.equal(result.T1, T1);
      assert.equal(result.T3, T3);
    });
  }
  for (const [question, expected] of [
    ['压缩比为9，截止比为2.2。', { r: 9, rc: 2.2 }],
    ['增压比为12。', { pi_p: 12 }],
    ['求奥托循环的热效率。', {}],
  ]) {
    await test('explicit ratios and absent fields: ' + question, () => {
      const result = serverCall('extractExplicitParams', question);
      for (const key of ['r', 'rc', 'pi_p', 'T1', 'T3', 'p1']) {
        if (key in expected) assert.equal(result[key], expected[key]);
        else assert.ok(result[key] == null, key + ' must not acquire a default');
      }
      assert.ok(Object.keys(result).every(key => ['r', 'rc', 'pi_p', 'T1', 'T3', 'p1'].includes(key)));
    });
  }
  await test('already correct model values are not marked corrected', () => {
    const params = { r: 9, rc: 2.2, pi_p: 12, T1: 290, T3: 1400, p1: 95 };
    const result = serverCall('correctQuestionParams',
      '压缩比9，截止比2.2，增压比12，初始温度290K，涡轮进口温度1400K，初始压力0.095MPa。',
      { cycle: 'brayton', params, assumed: [] });
    assert.deepEqual(result.params, params);
    assert.deepEqual(result.corrected, []);
  });
  await test('correction records exactly conflicting fields without inventing missing values', () => {
    const result = serverCall('correctQuestionParams', '初始温度-10°C，初始压力0.095MPa。',
      { cycle: 'otto', params: { r: null, rc: null, pi_p: null, T1: 300, T3: null, p1: 100 } });
    close(result.params.T1, 263.15);
    close(result.params.p1, 95);
    assert.deepEqual([...result.corrected].sort(), ['T1', 'p1'].sort());
    for (const key of ['r', 'rc', 'pi_p', 'T3']) assert.equal(result.params[key], null);
  });
  await test('parse route returns corrected params and correction field list', async () => {
    const runtime = createRuntime(async () => providerReply(JSON.stringify({
      cycle: 'otto', params: { r: 9, T1: 300, T3: 1800, p1: 100 }, assumed: [], question: '求热效率',
    })));
    const response = await runtime.request('parse-question', { question: '奥托循环压缩比9，初始温度290K，最高温度1800K，初始压力100kPa。' });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.params.T1, 290);
    assert.equal(result.params.T3, 1800);
    assert.deepEqual(result.corrected, ['T1']);
  });
  await test('parse provider request uses 300 tokens and preserves original numbers in prompt', async () => {
    let captured;
    const runtime = createRuntime(async (url, options) => {
      captured = JSON.parse(options.body);
      return providerReply(JSON.stringify({ cycle: 'otto', params: { T1: 290 }, assumed: [] }));
    });
    const question = '奥托循环初始温度290K。';
    assert.equal((await runtime.request('parse-question', { question })).status, 200);
    assert.equal(captured.max_tokens, 300);
    assert.ok(captured.messages.find(message => message.role === 'system').content.includes('题目给出的数值必须原样使用，不得替换成默认值'));
    assert.equal(captured.messages.find(message => message.role === 'user').content, question);
  });
  await test('frontend mapping explicitly renames pi_p and preserves all other parameters', () => {
    const { context } = createFrontend();
    assert.equal(typeof context.mapAIParams, 'function', 'mapAIParams must be implemented');
    const input = { r: 18, rc: 2.2, pi_p: 12, T1: 290, T3: 1500, p1: 95, extra: 999 };
    const before = { ...input };
    assert.deepEqual(plain(context.mapAIParams(input)), { r: 18, rc: 2.2, pi: 12, T1: 290, T3: 1500, p1: 95 });
    assert.deepEqual(input, before);
  });
  await test('frontend mapping preserves null fields without injecting defaults', () => {
    const { context } = createFrontend();
    assert.equal(typeof context.mapAIParams, 'function');
    assert.deepEqual(plain(context.mapAIParams({ r: null, rc: null, pi_p: null, T1: null, T3: null, p1: null })),
      { r: null, rc: null, pi: null, T1: null, T3: null, p1: null });
  });
  for (const cycle of ['otto', 'diesel', 'brayton']) {
    await test('mapped ' + cycle + ' parameters produce independent cycle efficiency', () => {
      const { context } = createFrontend();
      assert.equal(typeof context.mapAIParams, 'function');
      const params = context.mapAIParams({ r: 18, rc: 2.2, pi_p: 12, T1: 290, T3: 1500, p1: 95 });
      const th = context.calculate(cycle, params);
      const k = 1.4;
      const expected = cycle === 'otto' ? 1 - 18 ** (1 - k)
        : cycle === 'diesel' ? 1 - (2.2 ** k - 1) / (k * 1.2 * 18 ** (k - 1))
        : 1 - 12 ** (-(k - 1) / k);
      close(th.eta, expected);
      close(th.states[0].T, 290);
      close(th.states[0].p, 95);
      if (cycle !== 'diesel') close(th.states[2].T, 1500);
      if (cycle === 'diesel') close(th.states[2].v / th.states[1].v, 2.2);
      if (cycle === 'brayton') close(th.states[1].p / th.states[0].p, 12);
    });
  }
  for (const corrected of [[], ['T1']]) {
    await test('handleAIParse applies mapped pi and correction notice: ' + JSON.stringify(corrected), async () => {
      const { context, document } = createFrontend();
      document.getElementById('aiQuestionInput').value = '布雷顿循环增压比12，初始温度290K。';
      context.callAIFunction = async () => ({ result: {
        cycle: 'brayton', params: { pi_p: 12, T1: 290, T3: 1500, p1: 95 }, corrected,
      } });
      context.switchCycle = cycle => {
        context.selectedCycle = cycle;
        vm.runInContext('currentCycle = selectedCycle; currentParams = getDefaultParams(currentCycle);', context);
      };
      context.refresh = () => {};
      let mappingCalls = 0;
      const original = context.mapAIParams;
      if (typeof original === 'function') context.mapAIParams = params => { mappingCalls++; return original(params); };
      await context.handleAIParse();
      assert.deepEqual(plain(vm.runInContext('currentParams', context)), {
        ...plain(context.getDefaultParams('brayton')), pi: 12, T1: 290, T3: 1500, p1: 95,
      });
      assert.ok(mappingCalls > 0, 'handleAIParse must use mapAIParams');
      assert.equal(document.getElementById('aiParseResult').textContent.includes('已按题目原文校正'), corrected.length > 0);
      assert.equal(document.getElementById('aiParseBtn').disabled, false);
    });
  }
  await test('actual tutor request captures 300 tokens, 180-character answer rule and context-only numbers', async () => {
    let captured;
    const runtime = createRuntime(async (url, options) => {
      captured = JSON.parse(options.body);
      return providerReply('增压比为12。');
    });
    const context = '布雷顿循环，增压比12，初始温度290K，热效率50.84%。';
    const question = '为什么效率提高？';
    assert.equal((await runtime.request('ask', { question, context })).status, 200);
    assert.equal(captured.max_tokens, 300);
    const system = captured.messages.find(message => message.role === 'system').content;
    assert.ok(system.includes(context), 'actual context must reach provider');
    assert.match(system, /(?:180\s*字|180\s*字符)/);
    assert.match(system, /(?:仅|只)[^。\n]*(?:上下文|页面)[^。\n]*(?:数值|数字)|(?:数值|数字)[^。\n]*(?:仅|只)[^。\n]*(?:上下文|页面)/);
    assert.match(system, /(?:不得|不能|不要|禁止|不)[^。\n]*卡诺循环/);
    assert.equal(captured.messages.find(message => message.role === 'user').content, question);
  });
  const limitCases = [
    ['short response unchanged', '温度290K。效率50.84%。', '温度290K。效率50.84%。'],
    ['exactly 200 unchanged even with an earlier full stop', '甲。' + '乙'.repeat(198), '甲。' + '乙'.repeat(198)],
    ['last Chinese full stop within first 200', '甲。' + '乙'.repeat(120) + '。' + '丙'.repeat(100), '甲。' + '乙'.repeat(120) + '。'],
    ['English sentence ending', 'First sentence. ' + 'x'.repeat(110) + '. ' + 'y'.repeat(100), 'First sentence. ' + 'x'.repeat(110) + '.'],
    ['no full stop hard limit', '甲'.repeat(201), '甲'.repeat(200)],
    ['full stop at character 200 is retained', '甲'.repeat(199) + '。尾', '甲'.repeat(199) + '。'],
    ['full stop after character 200 is ignored', '甲'.repeat(200) + '。', '甲'.repeat(200)],
    ['decimal points are not sentence endings', '效率50.84，温度290.15K，' + '甲'.repeat(220), ('效率50.84，温度290.15K，' + '甲'.repeat(220)).slice(0, 200)],
    ['decimal does not displace an earlier sentence ending', '第一句。效率50.84，' + '甲'.repeat(220), '第一句。'],
    ['decimal split at 200 does not count as a sentence', '甲'.repeat(198) + '3.14' + '乙'.repeat(20), '甲'.repeat(198) + '3.'],
    ['decimal split at 200 retains the preceding complete sentence', '完整句。' + '甲'.repeat(194) + '3.14' + '乙'.repeat(20), '完整句。'],
  ];
  for (const [name, input, expected] of limitCases) {
    await test('limitTutorAnswer: ' + name, () => {
      assert.equal(serverCall('limitTutorAnswer', input), expected);
    });
  }
  await test('ask route applies sentence truncation to actual provider response', async () => {
    const runtime = createRuntime(async () => providerReply('保留这一句。' + '后续'.repeat(110)));
    const response = await runtime.request('ask', { question: '解释循环' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answer, '保留这一句。');
  });
  await test('tutor prompt states cold-air conclusions and forbids contradictions', async () => {
    let captured;
    const runtime = createRuntime(async (url, options) => {
      captured = JSON.parse(options.body);
      return providerReply('效率不变。');
    });
    await runtime.request('ask', { question: '提高最高温度的影响？', context: '奥托循环 | 热效率 η=56.47%' });
    const system = captured.messages.find(message => message.role === 'system').content;
    assert.match(system, /冷空气标准模型/);
    assert.match(system, /奥托循环热效率只取决于压缩比 r/);
    assert.match(system, /狄塞尔循环热效率只取决于压缩比 r 和截止比 rc/);
    assert.match(system, /布雷顿循环热效率只取决于增压比 πp/);
    assert.match(system, /提高 T3[^\n]*效率不变[^\n]*净功增大/);
    assert.match(system, /初温 T1[^\n]*效率不变/);
    assert.match(system, /不得与之矛盾/);
  });
  const fallbackCases = [
    ['Brayton turbine inlet temperature', '布雷顿循环提高涡轮进口温度对效率有什么影响？',
      '布雷顿循环 | 参数: 增压比 πp: 12, 涡轮进口温度 T₃ (K): 1473.15, 初始温度 T₁ (K): 293.15, 初始压力 p₁ (kPa): 100 | 热效率 η=50.83%',
      ['效率不变', '布雷顿循环热效率只取决于增压比 πp', '涡轮进口温度', '50.83%', '净功增大']],
    ['Otto maximum temperature', '提高奥托最高温度对效率的影响',
      '布雷顿循环 | 参数: 增压比 πp: 12, 涡轮进口温度 T₃ (K): 1473.15, 初始温度 T₁ (K): 293.15, 初始压力 p₁ (kPa): 100 | 热效率 η=50.83%',
      ['当前页面是布雷顿循环；切换到奥托循环可看到具体数值', '效率不变', '奥托循环热效率只取决于压缩比 r', '最高温度', '净功增大']],
    ['initial temperature', '初温对效率的影响',
      '奥托循环 | 参数: 压缩比 r: 8, 最高温度 T₃ (K): 1800, 初始温度 T₁ (K): 300 | 热效率 η=56.47%',
      ['效率不变', '初温 T₁', '只取决于压缩比 r', '56.47%']],
  ];
  for (const [name, question, context, expected] of fallbackCases) {
    await test('temperature efficiency fallback replaces contradiction: ' + name, async () => {
      const runtime = createRuntime(async () => providerReply('提高该温度会提升热效率，净功也会增大。'));
      const response = await runtime.request('ask', { question, context });
      assert.equal(response.status, 200);
      const answer = (await response.json()).answer;
      for (const part of expected) assert.ok(answer.includes(part), 'answer must include ' + part + ': ' + answer);
      assert.ok(!answer.includes('提升热效率'));
      assert.ok(Array.from(answer).length <= 200);
      assert.ok(!/卡诺/.test(answer));
      const numbers = answer.replace(/ε>0/g, '').match(/\d+(?:\.\d+)?/g) || [];
      const contextNumbers = context.match(/\d+(?:\.\d+)?/g) || [];
      assert.ok(numbers.every(number => contextNumbers.includes(number)), 'all numbers must come from context');
    });
  }
  await test('correct temperature answer containing 效率不变 is preserved', async () => {
    const correct = '按页面计算，奥托循环热效率为56.47%。提高最高温度 T₃ 时效率不变，但净功增大。';
    const runtime = createRuntime(async () => providerReply(correct));
    const answer = (await (await runtime.request('ask', { question: '提高奥托最高温度对效率的影响', context: '奥托循环 | 热效率 η=56.47%' })).json()).answer;
    assert.equal(answer, correct);
  });
  await test('compression-ratio question is not replaced by temperature fallback', async () => {
    const text = '压缩比越高，效率越高。';
    const runtime = createRuntime(async () => providerReply(text));
    const answer = (await (await runtime.request('ask', { question: '为什么压缩比越高，效率越高？', context: '奥托循环 | 热效率 η=56.47%' })).json()).answer;
    assert.ok(answer.includes('提高压缩比时效率提高'));
    assert.ok(!answer.includes('效率不变'));
  });
  await test('temperature fallback uses context efficiency without inventing numbers', () => {
    const answer = serverCall('temperatureEfficiencyTemplate', '提高涡轮进口温度对效率有什么影响？',
      '布雷顿循环 | 参数: 增压比 πp: 15, 涡轮进口温度 T₃ (K): 1600 | 热效率 η=54.12%');
    assert.ok(answer.startsWith('按页面计算，布雷顿循环热效率为54.12%。'));
    assert.ok(answer.includes('效率不变'));
    assert.ok(answer.includes('净功增大'));
    assert.ok(!answer.includes('15') && !answer.includes('1600'));
  });
  for (const [name, question, context, current, target, dependency] of [
    ['Otto page Brayton T3', '布雷顿循环提高涡轮进口温度对效率有什么影响？',
      '奥托循环 | 热效率 η=56.47%', '奥托', '布雷顿', '增压比 πp'],
    ['reverse cross cycle', '提高奥托最高温度对效率的影响？',
      '布雷顿循环 | 热效率 η=50.83%', '布雷顿', '奥托', '压缩比 r'],
    ['cross cycle without efficiency', '布雷顿循环提高T3对效率有什么影响？',
      '奥托循环 | 参数: 压缩比 r: 8', '奥托', '布雷顿', '增压比 πp'],
    ['Diesel target', '狄塞尔循环提高最高温度对效率有什么影响？',
      '奥托循环 | 热效率 η=56.47%', '奥托', '狄塞尔', '压缩比 r 和截止比 rc'],
  ]) {
    await test('cross-cycle temperature regression: ' + name, async () => {
      for (const reply of [' \n布雷顿循环热效率为未提供。效率不变。\n ', '温度提高会提升热效率。']) {
        const runtime = createRuntime(async () => providerReply(reply));
        const response = await runtime.request('ask', { question, context });
        assert.equal(response.status, 200);
        const { answer } = await response.json();
        assert.ok(answer.startsWith(`当前页面是${current}循环；切换到${target}循环可看到具体数值。`));
        assert.ok(answer.includes(`${target}循环热效率只取决于${dependency}`));
        assert.ok(answer.includes('效率不变') && answer.includes('净功增大'));
        assert.ok(!/未提供|56\.47|50\.83|%/.test(answer));
        assert.equal(answer, answer.trim());
        assert.ok(Array.from(answer).length <= 200);
      }
    });
  }
  await test('same-cycle fallback quotes dynamic efficiency', async () => {
    for (const eta of ['51.23', '63.79']) {
      const runtime = createRuntime(async () => providerReply('提高温度会提高效率。'));
      const { answer } = await (await runtime.request('ask', {
        question: '布雷顿循环提高T3对效率有什么影响？', context: `布雷顿循环 | 热效率 η=${eta}%`,
      })).json();
      assert.ok(answer.startsWith(`按页面计算，布雷顿循环热效率为${eta}%。`));
      assert.ok(answer.includes('效率不变'));
    }
  });
  for (const question of ['狄塞尔循环与奥托循环效率有什么不同？', '狄塞尔和奥托提高最高温度对效率有什么影响？']) {
    await test('multiple named cycles preserve comparison: ' + question, async () => {
      const comparison = '按页面计算，奥托循环热效率为56.47%。狄塞尔效率取决于压缩比和截止比，奥托效率只取决于压缩比。';
      const runtime = createRuntime(async () => providerReply(comparison));
      const { answer } = await (await runtime.request('ask', { question, context: '奥托循环 | 热效率 η=56.47%' })).json();
      assert.equal(answer, comparison);
      assert.ok(!answer.includes('切换到'));
    });
  }
  await test('general cross-cycle answer discards numerical claims', async () => {
    const runtime = createRuntime(async () => providerReply('按页面计算，布雷顿循环热效率为56.47%。增压比提高时效率提高。'));
    const { answer } = await (await runtime.request('ask', {
      question: '布雷顿循环增压比提高对效率有什么影响？', context: '奥托循环 | 热效率 η=56.47%',
    })).json();
    assert.equal(answer, '当前页面是奥托循环；切换到布雷顿循环可看到具体数值。增压比提高时效率提高。');
  });
  for (const reply of [' \n\t效率说明。\n ', ' \n' + '甲'.repeat(210) + '\n ', ' \n当前热效率未提供。\n ']) {
    await test('final answer trims whitespace and avoids missing-value wording: ' + reply.length, async () => {
      const runtime = createRuntime(async () => providerReply(reply));
      const { answer } = await (await runtime.request('ask', { question: '解释热效率' })).json();
      assert.equal(answer, answer.trim());
      assert.ok(!answer.includes('未提供'));
      assert.ok(Array.from(answer).length <= 200);
    });
  }
  await test('prompt explains cross-cycle and missing-efficiency rules', async () => {
    let system;
    const runtime = createRuntime(async (url, options) => {
      system = JSON.parse(options.body).messages[0].content;
      return providerReply('定性回答。');
    });
    await runtime.request('ask', { question: '解释热效率' });
    assert.match(system, /跨循环不得猜数值/);
    assert.match(system, /不得把当前循环数值当成目标循环数值/);
    assert.match(system, /多个循环/);
    assert.match(system, /所有回答不得出现“未提供”/);
    assert.match(system, /当前页面暂无热效率数值/);
    assert.ok(!system.includes('当前循环上下文：\n未提供'));
  });
  await test('explicit parameter removes matching missing-value assumption', () => {
    const parsed = { cycle: 'brayton', params: { r: null, rc: null, pi_p: 12, T1: 293.15, T3: 1473.15, p1: 100 },
      assumed: ['未给出初始压力，使用默认值 100 kPa', '未给出初始温度，使用默认值 300 K', '未给出最高温度，使用默认值 1400 K', '假设空气为理想气体'] };
    const result = serverCall('correctQuestionParams',
      '燃气轮机装置按理想布雷顿循环工作，压气机进口空气 100 kPa、20 °C，增压比 12，涡轮进口温度 1200 °C，求热效率。', parsed);
    assert.deepEqual(result.assumed, ['假设空气为理想气体']);
  });
  for (const [question, entry] of [
    ['奥托循环压缩比为9，初始温度290K，最高温度1800K。', '未给出压缩比，使用默认值 8'],
    ['狄塞尔循环截止比为2.2，初始温度290K。', '未给出截止比，使用默认值 2'],
    ['布雷顿循环增压比为12，初始温度290K。', '未给出增压比，使用默认值 10'],
    ['压缩比为9，初始温度290K。', '未给出初始温度，使用默认值 300 K'],
    ['压缩比为9，最高温度1800K。', '未给出最高温度，使用默认值 1800 K'],
    ['压缩比为9，初始压力为100kPa。', '未给出初始压力，使用默认值 100 kPa'],
  ]) {
    await test('explicit parameter prunes assumption: ' + entry, () => {
      const parsed = { cycle: 'otto', params: {}, assumed: [entry, '假设工质为空气'] };
      const result = serverCall('correctQuestionParams', question, parsed);
      assert.deepEqual(result.assumed, ['假设工质为空气']);
    });
  }
  await test('assumption not related to explicit parameter is retained', () => {
    const parsed = { cycle: 'brayton', params: {}, assumed: ['未给出初始压力，使用默认值 100 kPa'] };
    const result = serverCall('correctQuestionParams', '布雷顿循环增压比为12。', parsed);
    assert.deepEqual(result.assumed, ['未给出初始压力，使用默认值 100 kPa']);
  });
  await test('missing or non-array assumed is tolerated', () => {
    const without = serverCall('correctQuestionParams', '压缩比为9。', { cycle: 'otto', params: {} });
    assert.equal(without.assumed, undefined);
    const nonArray = serverCall('correctQuestionParams', '压缩比为9。', { cycle: 'otto', params: {}, assumed: '未给出压缩比' });
    assert.equal(nonArray.assumed, '未给出压缩比');
  });
  await test('Otto compression-ratio explanation cannot claim unchanged rejection temperature', async () => {
    const runtime = createRuntime(async () => providerReply('按页面计算，奥托循环热效率为56.47%。压缩比越高，放热平均温度不变，因此效率提高。'));
    const answer = (await (await runtime.request('ask', { question: '为什么压缩比越高，效率越高？', context: '奥托循环 | 热效率 η=56.47%' })).json()).answer;
    assert.ok(answer.includes('56.47%'));
    assert.ok(answer.includes('热效率只取决于压缩比 r'));
    assert.ok(answer.includes('压缩终温提高'));
    assert.ok(!/放热[^。]*不变/.test(answer));
    assert.ok(Array.from(answer).length <= 200);
  });
  const regenerativeContext = '布雷顿循环 | 热效率 η=64.28% | 回热：开启；回热度 ε=1；回热可行：是；无回热效率=32.70%；回热量=245.67 kJ/kg';
  const regenerationCases = [
    ['active T3', '提高T3对效率有什么影响？', regenerativeContext, ['效率提高', '净功增大', 'T₁/T₃'], ['效率不变']],
    ['explicit regenerative T3', '有回热布雷顿提高最高温度对效率有什么影响？', regenerativeContext, ['效率提高', '净功增大'], ['效率不变']],
    ['active T1', '提高T1对效率有什么影响？', regenerativeContext, ['效率降低', 'ε'], ['效率不变']],
    ['active initial temperature', '提高初始温度对效率有什么影响？', regenerativeContext, ['效率降低'], ['效率不变']],
    ['disabled T3', '布雷顿提高T3对效率有什么影响？', regenerativeContext.replace('回热：开启', '回热：关闭'), ['效率不变', '净功增大', '无回热'], []],
    ['infeasible T3', '提高T3对效率有什么影响？', regenerativeContext.replace('回热可行：是', '回热可行：否'), ['当前回热不可行', '效率不变'], []],
    ['infeasible T1', '提高T1对效率有什么影响？', regenerativeContext.replace('回热可行：是', '回热可行：否'), ['当前回热不可行', '效率不变'], ['效率降低']],
    ['zero effectiveness', '提高T3对效率有什么影响？', regenerativeContext.replace('ε=1', 'ε=0'), ['无回热', '效率不变'], []],
    ['unknown feasibility', '提高T3对效率有什么影响？', regenerativeContext.replace('回热可行：是；', ''), ['效率不变'], ['效率提高']],
    ['explicit regeneration efficiency', '回热为什么能提高效率？', regenerativeContext, ['回热可以提高布雷顿效率', 'T₄>T₂', 'ε>0', 'T₄≤T₂', '净功不变', '外部吸热和放热减少', 'T₁/T₃'], []],
    ['effectiveness efficiency', 'ε对热效率有什么影响？', regenerativeContext, ['回热可以提高布雷顿效率', '还依赖 ε'], []],
    ['disabled regeneration efficiency', '回热可以提高效率吗？', regenerativeContext.replace('回热：开启', '回热：关闭'), ['回热可以提高布雷顿效率', 'T₄>T₂'], []],
    ['infeasible regeneration efficiency', '回热是否提高效率？', regenerativeContext.replace('回热可行：是', '回热可行：否'), ['当前回热不可行', 'T₄≤T₂'], []],
    ['cross cycle temperature with misleading state', '布雷顿提高T3对效率有什么影响？', regenerativeContext.replace('布雷顿循环', '奥托循环'), ['当前页面是奥托循环；切换到布雷顿循环', '无回热', '效率不变', '回热可以提高布雷顿效率'], ['64.28%', '32.70%']],
    ['cross cycle regeneration', '布雷顿回热能提高效率吗？', '奥托循环 | 热效率 η=56.47%', ['当前页面是奥托循环；切换到布雷顿循环', '回热可以提高布雷顿效率', '净功不变'], ['56.47%']],
    ['multiple cycle regeneration comparison', '布雷顿回热与奥托效率有什么区别？', regenerativeContext, ['回热可以提高布雷顿效率', '奥托效率只取决于压缩比 r'], ['切换到']],
    ['multiple cycle temperature comparison', '布雷顿和奥托提高T3对效率有什么影响？', regenerativeContext, ['无回热布雷顿', '提高 T₃ 效率提高、净功增大', '提高 T₁ 效率降低'], ['切换到']],
    ['three cycle regeneration comparison', '布雷顿回热与奥托、狄塞尔效率有什么区别？', '奥托循环 | 热效率 η=56.47%', ['回热可以提高布雷顿效率', '奥托效率只取决于压缩比 r', '狄塞尔效率取决于压缩比 r 和截止比 rc'], ['切换到']],
  ];
  for (const [name, question, context, expected, excluded] of regenerationCases) {
    await test('regeneration guard: ' + name, async () => {
      for (const reply of ['效率不变，回热不能提高效率。', '效率提高到99.99%，净功减少。']) {
        const runtime = createRuntime(async () => providerReply(reply));
        const response = await runtime.request('ask', { question, context });
        assert.equal(response.status, 200);
        const { answer } = await response.json();
        for (const part of expected) assert.ok(answer.includes(part), `missing ${part}: ${answer}`);
        for (const part of excluded) assert.ok(!answer.includes(part), `unexpected ${part}: ${answer}`);
        assert.ok(!answer.includes('99.99') && !answer.includes('32.70'));
        if (!answer.includes('切换到')) {
          const eta = context.match(/热效率 η=([\d.]+)%/)[1];
          assert.ok(answer.startsWith(`按页面计算，${context.split('循环')[0]}循环热效率为${eta}%。`));
        }
        assert.ok(Array.from(answer).length <= 200);
        assert.equal(answer, answer.trim());
        const numbers = answer.replace(/ε>0/g, '').match(/\d+(?:\.\d+)?/g) || [];
        assert.ok(numbers.every(number => (context.match(/\d+(?:\.\d+)?/g) || []).includes(number)));
      }
    });
  }
  for (const cycle of ['奥托', '狄塞尔']) {
    await test('regeneration flags do not classify ' + cycle + ' as Brayton', async () => {
      const context = regenerativeContext.replace('布雷顿循环', cycle + '循环');
      const runtime = createRuntime(async () => providerReply('需要解释。'));
      const { answer } = await (await runtime.request('ask', { question: '提高T3对效率有什么影响？', context })).json();
      assert.ok(answer.includes('效率不变'));
      assert.ok(!answer.includes('有回热布雷顿'));
      assert.deepEqual(serverCall('braytonRegeneration', context), { enabled: false, feasible: false, active: false });
    });
    await test('explicit ' + cycle + ' regeneration question does not use Brayton template', async () => {
      const text = '该循环应根据相应模型讨论。';
      const runtime = createRuntime(async () => providerReply(text));
      const { answer } = await (await runtime.request('ask', {
        question: cycle + '回热对效率有什么影响？', context: regenerativeContext.replace('布雷顿循环', cycle + '循环'),
      })).json();
      assert.equal(answer, text);
    });
  }
  await test('regenerative template quotes dynamic actual efficiency rather than baseline', async () => {
    for (const eta of ['61.82', '72.35']) {
      const runtime = createRuntime(async () => providerReply('效率不变。'));
      const { answer } = await (await runtime.request('ask', {
        question: '提高T3对效率有什么影响？', context: regenerativeContext.replace('64.28', eta),
      })).json();
      assert.ok(answer.startsWith(`按页面计算，布雷顿循环热效率为${eta}%。`));
      assert.ok(answer.includes('效率提高') && !answer.includes('32.70'));
    }
  });
  await test('prompt limits invariant efficiency to non-regenerative Brayton', async () => {
    let system;
    const runtime = createRuntime(async (url, options) => {
      system = JSON.parse(options.body).messages[0].content;
      return providerReply('回答。');
    });
    await runtime.request('ask', { question: '解释效率', context: regenerativeContext });
    assert.match(system, /无回热布雷顿循环热效率只取决于增压比/);
    assert.match(system, /回热可以提高布雷顿效率[^\n]*T4>T2[^\n]*ε>0[^\n]*T4≤T2/);
    assert.match(system, /有回热布雷顿效率还依赖 ε、T1\/T3/);
    assert.match(system, /提高 T3 效率提高、净功增大，提高 T1 效率降低/);
    assert.match(system, /其他循环不能判为布雷顿回热/);
  });
  console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
