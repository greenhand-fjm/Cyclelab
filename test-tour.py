import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
KEY = 'cyclelab.tour.seen.v1'

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}'
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS ' + name)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 900})
    page = context.new_page()
    errors, ai_requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: ai_requests.append(request.url) if '/functions/' in request.url else None)
    page.goto(url)
    page.locator('#tourBubble').wait_for(state='visible')
    original = page.evaluate('runTests()')
    check('original calculator and cache tests 18/18', original == {'pass': 18, 'fail': 0})
    check('first visit opens step 1', page.locator('#tourProgress').inner_text().endswith('1 / 4'))
    check('positioning text', page.locator('.positioning').inner_text() == '适用于《工程热力学》气体动力循环章节的复习与课堂演示')
    expected = [('#tabs', '选一个循环'), ('#params input[type="range"]', '拖动压缩比，看循环怎么变'), ('#tsCanvas', '灰色虚线是默认工况，用来对比'), ('.derivation summary', '展开推导，看每一步怎么算')]
    for index, (selector, text) in enumerate(expected):
        check(f'step {index+1} text and target', page.locator('#tourText').inner_text() == text and 'tour-target' in page.locator(selector).first.get_attribute('class'))
        check(f'step {index+1} skip available', page.locator('#tourSkip').is_visible())
        page.locator('#tourNext').click()
    check('completion closes and remembers tour', page.locator('#tourBubble').is_hidden() and page.evaluate(f'localStorage.getItem({json.dumps(KEY)})') == 'true')
    page.reload()
    check('returning visit does not auto-open', page.locator('#tourBubble').is_hidden())
    for step in range(4):
        page.locator('#tourHelp').click()
        for _ in range(step):
            page.locator('#tourNext').click()
        page.locator('#tourSkip').click()
        check(f'skip works at step {step+1}', page.locator('#tourBubble').is_hidden() and page.locator('.tour-target').count() == 0)
    page.locator('#tourHelp').click()
    page.keyboard.press('Escape')
    check('Escape closes and restores focus', page.locator('#tourBubble').is_hidden() and page.locator('#tourHelp').evaluate('(e)=>e===document.activeElement'))
    page.locator('#tourHelp').click()
    page.locator('[data-cycle="diesel"]').click()
    page.locator('#tourNext').click()
    slider = page.locator('#params input[type="range"]').first
    slider.focus()
    before = page.evaluate('currentThermo.eta')
    page.keyboard.press('ArrowRight')
    check('cycle and slider remain usable during tour', page.evaluate('currentCycle') == 'diesel' and page.evaluate('currentThermo.eta') != before)
    page.locator('#tourSkip').click()
    page.locator('[data-cycle="brayton"]').click()
    page.locator('#tourHelp').click()
    page.locator('#tourNext').click()
    check('Brayton replay points to pressure ratio', page.locator('#tourText').inner_text() == '拖动增压比，看循环怎么变')
    page.locator('#tourSkip').click()
    page.locator('[data-cycle="otto"]').click()
    page.locator('#tourHelp').click()
    for cycle in ['otto', 'diesel', 'brayton', 'otto']:
        page.locator(f'[data-cycle="{cycle}"]').click()
        colors = page.evaluate("""() => Array.from(document.querySelectorAll('.tab')).map(e => ({active:e.classList.contains('active'),cycle:e.dataset.cycle,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,transition:getComputedStyle(e).transitionDuration}))""")
        selected = next(item for item in colors if item['active'])
        check('tour selected tab style ' + cycle, selected['cycle'] == cycle and selected['bg'] == 'rgb(37, 99, 235)' and selected['color'] == 'rgb(255, 255, 255)' and selected['transition'] == '0s' and all(item['bg'] != 'rgb(37, 99, 235)' for item in colors if not item['active']))
    page.screenshot(path=str(ROOT / 'reports' / 'tour-desktop.png'))
    page.locator('#tourSkip').click()
    for width, height in [(390, 844), (320, 568)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.locator('#tourHelp').click()
        for index in range(4):
            page.wait_for_function("() => {const r=document.getElementById('tourBubble').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}")
            check(f'{width}px step {index+1} bubble fits viewport', page.locator('#tourBubble').is_visible())
            check(f'{width}px step {index+1} target visible', page.locator('.tour-target').evaluate('(e)=>{const r=e.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight;}'))
            if width == 390 and index == 2:
                page.screenshot(path=str(ROOT / 'reports' / 'tour-mobile.png'))
            page.locator('#tourNext').click()
        check(f'{width}px no horizontal overflow', page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    check('AI visibility matches configuration with zero automatic requests', not ai_requests and page.evaluate("[...document.querySelectorAll('[data-ai]')].every(e=>e.hidden===!isAIEnabled())"))
    check('no uncaught browser exceptions', errors == [])
    for operation in ['getItem', 'setItem']:
        failing_context = browser.new_context()
        failing_context.add_init_script(f"Storage.prototype.{operation}=function(){{throw new DOMException('blocked','SecurityError')}};")
        failing_page = failing_context.new_page()
        failure_errors = []
        failing_page.on('pageerror', lambda error: failure_errors.append(str(error)))
        failing_page.goto(url)
        failing_page.locator('#tourBubble').wait_for(state='visible')
        failing_page.locator('#tourSkip').click()
        failing_page.reload()
        failing_page.locator('#tourBubble').wait_for(state='visible')
        check(operation + ' failure shows tour next visit without exception', failure_errors == [])
        check(operation + ' failure preserves calculator', failing_page.evaluate('runTests().fail') == 0)
        failing_context.close()
    context.close()
    browser.close()
server.shutdown()
result = {'pass': len(checks), 'fail': 0, 'original': original, 'checks': checks}
(ROOT / 'reports' / 'tour-test-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'{len(checks)} passed, 0 failed')
