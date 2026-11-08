import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
records = json.loads((ROOT / 'reports/ai-physics-live-results.json').read_text(encoding='utf-8'))['requests'][:3]
checks = []

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass

def check(name, value):
    assert value, name
    checks.append(name)
    print('PASS ' + name)

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        page = browser.new_page(viewport={'width':1280, 'height':800})
        page.add_init_script("localStorage.setItem('cyclelab.tour.seen.v1','true')")
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        calls = []
        reply = {}
        def respond(route):
            calls.append({'url':route.request.url, 'body':route.request.post_data_json})
            route.fulfill(status=200, content_type='application/json', body=json.dumps(reply))
        page.route('**/functions/v1/app/**', respond)
        base = f'http://127.0.0.1:{server.server_port}'
        for record, enabled in [(records[0],0),(records[1],0),(records[2],0),(records[2],1)]:
            cycle = record['body']['result']['cycle']
            name = f'{cycle} initial regen={enabled}'
            page.goto(base + f'?cycle={cycle}&regen={enabled}&epsilon=1')
            page.wait_for_function('currentThermo')
            if cycle == 'brayton':
                check(name + ' initial checkbox', page.locator('#regenToggle').is_checked() == bool(enabled))
            calls.clear()
            reply = record['body']
            page.locator('#aiQuestionInput').fill(record['request']['question'])
            page.locator('#aiParseBtn').click()
            page.wait_for_function("!document.getElementById('aiParseBtn').disabled")
            check(name + ' replay request', len(calls) == 1 and calls[0]['url'].endswith('/ai/parse-question'))
            check(name + ' success panel', '已按题目设置参数' in page.locator('#aiParseResult').inner_text() and 'error' not in page.locator('#aiParseResult').get_attribute('class'))
            expected = {('pi' if k == 'pi_p' else k):v for k,v in reply['result']['params'].items() if v is not None}
            state = page.evaluate('({cycle:currentCycle,params:currentParams,eta:currentThermo.eta})')
            check(name + ' actual AI params', state['cycle'] == cycle and all(state['params'][key] == value for key,value in expected.items()))
            check(name + ' control values', page.evaluate("""() => Array.from(document.querySelectorAll('#params .param-group')).every((group,i) => {
                const def=PARAM_DEFS[currentCycle][i], val=currentParams[def.key];
                return def.checkbox ? group.querySelector('input[type=checkbox]').checked === (val===1) :
                    Number(group.querySelector('input[type=number]').value)===val &&
                    Math.abs(Number(group.querySelector('input[type=range]').value)-val)<=def.step/2+1e-9;
            })"""))
            check(name + ' formula refreshed', page.evaluate('Math.abs(currentThermo.eta-calculate(currentCycle,currentParams).eta)<1e-12'))
            check(name + ' derivation opened', page.locator('.derivation').get_attribute('open') is not None)
            if cycle == 'brayton':
                check(name + ' unspecified regeneration off', state['params']['regen'] == 0 and not page.locator('#regenToggle').is_checked())
        page.goto(base)
        page.wait_for_function('currentThermo')
        calls.clear()
        for button in page.locator('.btn-example').all():
            question = button.get_attribute('data-q')
            button.click()
            check('cached example zero requests: ' + question, len(calls) == 0)
            check('cached example answer: ' + question, page.locator('#aiAskResult').inner_text() == page.evaluate('(q)=>getExampleAnswer(q)', question))
        check('cached runtime Otto values', page.evaluate("getExampleAnswer(document.querySelector('.btn-example').dataset.q).includes((etaOtto(8)*100).toFixed(2))&&getExampleAnswer(document.querySelector('.btn-example').dataset.q).includes((etaOtto(10)*100).toFixed(2))"))
        check('cached runtime Diesel values', page.evaluate("getExampleAnswer(document.querySelectorAll('.btn-example')[1].dataset.q).includes((etaDiesel(18,2)*100).toFixed(2))"))
        reply = {'answer':'自由提问测试响应'}
        page.locator('#aiAskInput').fill('解释定容吸热过程')
        page.locator('#aiAskBtn').click()
        page.wait_for_function("!document.getElementById('aiAskBtn').disabled")
        check('free question still requests AI', len(calls) == 1 and calls[0]['url'].endswith('/ai/ask') and calls[0]['body']['question'] == '解释定容吸热过程')
        check('free question displays response', page.locator('#aiAskResult').inner_text() == reply['answer'])
        check('no page errors', not errors)
        baseline = page.evaluate('runTests()')
        check('original calculations pass', baseline['fail'] == 0 and baseline['pass'] == 18)
        browser.close()
    (ROOT / 'reports/ai-ui-regression-results.json').write_text(json.dumps({'passed':len(checks),'failed':0,'checks':checks,'baseline':baseline,'fixtureSource':'reports/ai-physics-live-results.json requests[0:3]','realAIRequests':0}, ensure_ascii=False, indent=2),encoding='utf-8')
    print(f'{len(checks)} passed, 0 failed')
finally:
    server.shutdown()
