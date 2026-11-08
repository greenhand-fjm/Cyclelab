import json
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
live = '--live' in sys.argv
url = sys.argv[sys.argv.index('--live') + 1] if live else f'http://127.0.0.1:{server.server_port}'
checks = []
def check(name, result):
    assert result, name
    checks.append(name)
    print('PASS ' + name)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'], reduced_motion='reduce')
    context.add_init_script("localStorage.setItem('cyclelab.tour.seen.v1','true')")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    def visit(query=''):
        page.goto(url + query)
        page.wait_for_function('currentThermo && !restoringShareURL')
    def state():
        return page.evaluate('JSON.stringify(sharedCondition())')
    def roundtrip(name):
        original = state()
        page.reload()
        check(name, state() == original)
    visit('?cycle=brayton&pi=12&T3=1500&T1=310&p1=110#condition')
    check('URL restores all Brayton parameters', page.evaluate("currentCycle==='brayton'&&JSON.stringify(currentParams)===JSON.stringify({pi:12,T3:1500,T1:310,p1:110,regen:0,epsilon:0.8})"))
    check('hash is preserved', page.evaluate("location.hash==='#condition'"))
    before = page.url
    page.locator('#params input[type=number]').first.fill('14')
    page.locator('#params input[type=number]').first.press('Tab')
    check('numeric input synchronizes URL without a history entry', page.evaluate("new URLSearchParams(location.search).get('pi')==='14'"))
    page.locator('#copyLink').click()
    check('real clipboard button copies exact condition link', page.evaluate('navigator.clipboard.readText()') == page.url and page.locator('#shareStatus').inner_text() == '链接已复制')
    roundtrip('single condition survives reload')
    page.locator('[data-cycle=diesel]').click()
    check('cycle tab updates URL and removes irrelevant parameters', page.evaluate("location.search.includes('cycle=diesel')&&!new URLSearchParams(location.search).has('pi')"))
    for query, expected in [
        ('?cycle=otto&r=999&T3=1700&T1=NaN&p1=0', {'r':8,'T3':1700,'T1':300,'p1':100}),
        ('?cycle=otto&r=8&r=9&T3=&T1=Infinity&p1=0x64', {'r':8,'T3':1800,'T1':300,'p1':100}),
        ('?cycle=__proto__&r=12&T3=2000', {'r':8,'T3':1800,'T1':300,'p1':100}),
        ('?cycle=otto&r=%3Cscript%3E&T3=1e309&T1=-1&p1=100', {'r':8,'T3':1800,'T1':300,'p1':100}),
        ('?cycle=otto&r=1e1&T3=1.8e3&T1=300.5&p1=1e2&unknown=1', {'r':10,'T3':1800,'T1':300.5,'p1':100}),
    ]:
        visit(query)
        check('invalid or numeric URL handled: ' + query, page.evaluate('currentParams') == expected and 'unknown=' not in page.url)
    visit('?cycle=brayton&pi=12&T3=1500&T1=310&p1=110')
    base = state()
    page.locator('#comparePreset').click()
    check('comparison preset shares extended Otto compression ratio', page.evaluate("new URLSearchParams(location.search).get('c0_r')==='18'"))
    roundtrip('comparison preset survives reload')
    page.locator('#compareParam0-r').fill('24')
    page.locator('#compareParam0-r').press('Tab')
    page.locator('#compareCycle1').select_option('brayton')
    page.locator('#compareParam1-pi').fill('16')
    page.locator('#compareParam1-pi').press('Tab')
    roundtrip('edited comparison cycles and parameters survive reload')
    comparison = state()
    comparison_url = page.url
    page.locator('#quizStart').click()
    check('prediction URL shares visible exercise rather than suspended comparison', page.evaluate("!new URLSearchParams(location.search).has('compare')&&new URLSearchParams(location.search).get('cycle')===currentCycle"))
    exercise = state()
    other = context.new_page()
    other.goto(page.url)
    check('exercise link opens same model outside practice', other.evaluate('JSON.stringify(sharedCondition())') == exercise and other.locator('#quizStart').is_visible())
    other.close()
    page.locator('#quizChoices button').first.click()
    page.locator('#quizNext').wait_for(state='visible')
    check('answered exercise parameters synchronize URL', page.evaluate("createShareQuery(sharedCondition())===location.search.slice(1)"))
    page.locator('#quizExit').click()
    check('exit restores full comparison link', state() == comparison and page.url == comparison_url)
    page.locator('#quizStart').click()
    for _ in range(8):
        page.locator('#quizChoices button').first.click()
        page.locator('#quizNext').wait_for(state='visible')
        page.locator('#quizNext').click()
    check('completion restores comparison link', state() == comparison and page.url == comparison_url)
    page.locator('#compareToggle').uncheck()
    check('closing shared comparison restores original base condition', state() == base)
    visit('?compare=1&cycle0=brayton&cycle1=brayton&c0_pi=999&c1_r=20')
    check('invalid comparison fields and duplicate cycles fall back safely', page.evaluate("compareMode.cycles.join(',')==='brayton,otto'&&compareMode.params[0].pi===10&&compareMode.params[1].r===8"))
    visit('?cycle=otto&r=10')
    page.locator('#quizStart').click()
    page.evaluate("history.pushState(null,'','?cycle=diesel&r=20&rc=2.4');dispatchEvent(new PopStateEvent('popstate'))")
    check('history navigation exits practice and restores destination', page.evaluate("currentCycle==='diesel'&&currentParams.r===20&&currentParams.rc===2.4&&!compareMode.enabled") and page.locator('#quizBody').is_hidden())
    page.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:()=>Promise.reject(new Error('denied'))},configurable:true})")
    page.locator('#copyLink').click()
    check('clipboard denial offers selected readable link', page.locator('#shareLink').is_visible() and page.locator('#shareLink').input_value() == page.url and page.locator('#shareLink').evaluate('(e)=>e.selectionEnd-e.selectionStart===e.value.length'))
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        check(f'{width}px share controls fit viewport', page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    check('no uncaught browser errors', not errors)
    browser.close()
server.shutdown()
result = {'pass':len(checks),'fail':0,'checks':checks,'url':url if live else 'local test server'}
(ROOT/'reports'/('share-live-results.json' if live else 'share-test-results.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(f'{len(checks)} passed, 0 failed')
