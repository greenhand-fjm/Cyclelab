import json
import math
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*_): pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
live='--live' in sys.argv
url=sys.argv[sys.argv.index('--live')+1] if live else f'http://127.0.0.1:{server.server_port}'
checks=[]
def check(name,passed):
    assert passed,name
    checks.append(name)
    print('PASS '+name)
def close(a,b): return abs(a-b)<1e-10

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1200},reduced_motion='reduce',permissions=['clipboard-read','clipboard-write'])
    context.add_init_script("localStorage.setItem('cyclelab.tour.seen.v1','true')")
    page=context.new_page();errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(url+'?cycle=brayton&pi=4&T1=300&T3=1400&regen=1&epsilon=1')
    th=page.evaluate('currentThermo')
    expected=1-(300/1400)*4**((1.4-1)/1.4)
    check('epsilon 1 efficiency equals independent spec formula',close(th['eta'],expected))
    check('spec example displays 68.16 percent',f'{expected*100:.2f}'=='68.16' and '有回热 68.16%' in page.locator('#results').inner_text())
    check('efficiency card also displays unregenerated baseline', '无回热 32.70%' in page.locator('#results').inner_text())
    check('shared toggle and epsilon restore in actual UI',page.locator('#regenToggle').is_checked() and page.locator('#params input[type=number]').last.input_value()=='1')
    check('derivation gives spec formula and actual heat balance', 'η = 1 − (T₁/T₃)·πp^((κ−1)/κ) = 68.16%' in page.locator('#derivationContent').inner_text() and '外部 q_in' in page.locator('#derivationContent').inner_text())
    check('state table includes regenerator outlet points',page.locator('#stateTable tbody tr').count()==6)
    check('T-s legend identifies both internal heat transfers', '2→5 与 4→6 内部回热' in page.locator('#tsLegend').inner_text())
    for pi,T1,T3 in [(4,300,1400),(10,300,1400),(25,350,1000),(12,310,1500)]:
        data=page.evaluate('p=>{const base=calcBrayton({...p,regen:0});return {base,zero:calcBrayton({...p,regen:1,epsilon:0}),partial:calcBrayton({...p,regen:1,epsilon:0.5}),full:calcBrayton({...p,regen:1,epsilon:1})};}',{'pi':pi,'T1':T1,'T3':T3,'p1':100})
        base=data['base']
        check(f'epsilon zero exactly preserves original Brayton metrics and states {pi}',all(data['zero'][k]==base[k] for k in base))
        a=pi**((1.4-1)/1.4);T2=T1*a;T4=T3/a
        for key,e in [('partial',0.5),('full',1)]:
            d=data[key];q=e*1.005*max(T4-T2,0)
            check(f'independent heat recovery and energy balance {pi} epsilon {e}',close(d['regeneration']['q'],q) and close(d['qIn'],base['qIn']-q) and close(d['qOut'],base['qOut']-q) and d['wNet']==base['wNet'] and close(d['wNet'],d['qIn']-d['qOut']))
            if T4>T2:
                check(f'efficiency improves with feasible recovery {pi} epsilon {e}',d['eta']>base['eta'] and close(d['eta'],base['wNet']/(base['qIn']-q)))
            else:
                check(f'infeasible recovery preserves baseline {pi} epsilon {e}',d['eta']==base['eta'] and d['regeneration']['q']==0)
    integral=page.evaluate("() => {const a=getCycleAreaData(currentThermo);return {qin:integrateCurve(a.externalTs[1],'s','T'),qout:-integrateCurve(a.externalTs[3],'s','T'),work:a.pv.reduce((s,c)=>s+integrateCurve(c,'v','p'),0),tswork:a.ts.reduce((s,c)=>s+integrateCurve(c,'s','T'),0)};}")
    check('external T-s and full cycle p-v integrals match regenerated heat/work within 0.5 percent', all(abs(integral[key]-th[metric])/abs(th[metric])<0.005 for key,metric in [('qin','qIn'),('qout','qOut'),('work','wNet'),('tswork','wNet')]))
    page.locator('#tsAreaToggle').check()
    check('area explanation distinguishes internal from external heat','仅表示外部吸热与放热' in page.locator('#areaExplanation').inner_text())
    check('efficiency curve follows regenerated calculation',page.evaluate('getEffCurveData(currentCycle,currentParams).every(d=>Math.abs(d.y-calcBrayton({...currentParams,pi:d.x}).eta)<1e-12)'))
    check('AI context explicitly identifies active regeneration and real efficiency',page.evaluate("getCycleContext().includes('回热：开启；回热度 ε=1；回热可行：是')&&getCycleContext().includes('热效率 η=68.16%')"))
    page.locator('#params input[type=range]').last.fill('0.5')
    check('epsilon slider updates URL and efficiency immediately',page.evaluate("currentParams.epsilon===0.5&&new URLSearchParams(location.search).get('epsilon')==='0.5'&&currentThermo.eta>currentThermo.regeneration.etaWithout"))
    page.locator('#copyLink').click()
    check('copy button shares regenerator setting',page.evaluate('navigator.clipboard.readText()')==page.url and 'regen=1' in page.url and 'epsilon=0.5' in page.url)
    before=page.evaluate('JSON.stringify(sharedCondition())')
    page.reload()
    check('regenerator sharing survives reload exactly',page.evaluate('JSON.stringify(sharedCondition())')==before and page.locator('#regenToggle').is_checked())
    page.locator('#quizStart').click();page.locator('#quizExit').click()
    check('prediction exit restores regenerative condition',page.evaluate('JSON.stringify(sharedCondition())')==before and page.locator('#regenToggle').is_checked())
    page.locator('#regenToggle').uncheck()
    check('toggle off restores original efficiency and hides regeneration markings',page.evaluate('!currentThermo.regeneration&&currentParams.regen===0') and '内部回热' not in page.locator('#tsLegend').inner_text())
    page.goto(url+'?cycle=brayton&pi=25&T1=350&T3=1000&regen=1&epsilon=1')
    check('T4 below T2 displays infeasibility warning','此工况下回热不可行' in page.locator('#regenerationNote').inner_text() and page.evaluate('currentThermo.regeneration.q===0'))
    boundary=page.evaluate("() => {const a=Math.pow(10,(1.4-1)/1.4),t=300*a;const th=calcBrayton({pi:10,T1:300,T3:t*a,p1:100,regen:1,epsilon:1});return {delta:th.states[3].T-th.states[1].T,regen:th.regeneration};}")
    check('T4 equal T2 produces no recovery',abs(boundary['delta'])<1e-10 and abs(boundary['regen']['q'])<1e-10)
    page.goto(url+'?cycle=brayton&regen=0.5&epsilon=999')
    check('invalid regeneration URL values use safe defaults',page.evaluate('currentParams.regen===0&&currentParams.epsilon===0.8&&!currentThermo.regeneration'))
    page.locator('#compareToggle').check();page.locator('#compareCycle1').select_option('brayton')
    for key,value in [('pi','4'),('T1','300'),('T3','1400'),('epsilon','1')]:
        field=page.locator('#compareParam1-'+key);field.fill(value);field.press('Tab')
    page.locator('#compareParam1-regen').check()
    check('comparison uses independent regenerated formula','68.16'==page.locator('#compareTable [data-cycle-index="1"][data-metric="eta"]').inner_text())
    comparison=page.evaluate('JSON.stringify(sharedCondition())')
    page.reload()
    check('comparison regenerator settings survive share reload',page.evaluate('JSON.stringify(sharedCondition())')==comparison and page.locator('#compareParam1-regen').is_checked())
    comparison_data=page.evaluate('getComparisonData()')
    standalone=context.new_page();same=True
    for d in comparison_data:
        standalone.goto(url+'?'+urlencode({'cycle':d['cycle'],**d['params']}))
        same=same and standalone.evaluate('currentThermo')==d['th']
        for metric,factor in [('eta',100),('qIn',1),('qOut',1),('wNet',1)]:
            value=f"{d['th'][metric]*factor:.2f}"
            same=same and value in standalone.locator('#results').inner_text()
    standalone.close()
    check('comparison matches separately opened standalone page metrics',same)
    page.locator('#quizStart').click();page.locator('#quizExit').click()
    check('practice restores regenerative comparison',page.evaluate('JSON.stringify(sharedCondition())')==comparison and page.locator('#compareParam1-regen').is_checked())
    for key,value in [('pi','25'),('T1','350'),('T3','1000')]:
        field=page.locator('#compareParam1-'+key);field.fill(value);field.press('Tab')
    check('comparison shows infeasible regeneration warning','此工况下回热不可行' in page.locator('#compareRegenNote1').inner_text())
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        check(f'{width}px comparison controls and table fit',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.goto(url+'?cycle=brayton&pi=4&T1=300&T3=1400&regen=1&epsilon=1')
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        check(f'{width}px dual efficiency card and slider fit',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.set_viewport_size({'width':1440,'height':1200})
    page.screenshot(path=str(ROOT/'reports'/('regen-live-desktop.png' if live else 'regen-desktop.png')),full_page=True)
    check('original calculator formula tests pass',page.evaluate('runTests()')=={'pass':18,'fail':0})
    check('no uncaught browser exceptions',not errors)
    browser.close()
server.shutdown()
result={'pass':len(checks),'fail':0,'checks':checks,'specEfficiency':expected,'integrals':integral,'boundary':boundary,'url':url if live else 'local test server'}
(ROOT/'reports'/('regen-live-results.json' if live else 'regen-test-results.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(f'{len(checks)} passed, 0 failed')
