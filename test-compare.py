import json
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
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

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1500})
    context.add_init_script("localStorage.setItem('cyclelab.tour.seen.v1','true')")
    page=context.new_page();errors=[];requests=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda r: requests.append(r.url) if '/functions/' in r.url else None)
    page.goto(url)
    standalone=context.new_page();standalone.goto(url)
    page.evaluate("""() => {
      switchCycle('brayton');currentParams={pi:12,T3:1500,T1:310,p1:110};
      PARAM_DEFS.brayton.forEach((d,i)=>document.querySelectorAll('#params .param-group')[i].querySelectorAll('input').forEach(e=>e.value=currentParams[d.key]));refresh();
      document.getElementById('pvAreaToggle').click();document.getElementById('pvRefToggle').click();
      window.baseState=()=>JSON.stringify({currentCycle,currentParams,pvLocked,tsLocked,pvRefTh,tsRefNorm});
      window.canvasState=()=>JSON.stringify(['pvCanvas','tsCanvas'].map(id=>document.getElementById(id).toDataURL()));
      window.viewState=()=>JSON.stringify({base:baseState(),canvas:canvasState(),showPvRef,showTsRef,showPvArea,showTsArea,inputs:[...document.querySelectorAll('#params input')].map(e=>e.value)});
      window.beforeBase=baseState();window.beforeView=viewState();
      window.drawCalls=[];const pv=drawCycleOnPv,ts=drawCycleOnTs;
      drawCycleOnPv=function(ctx,map,th,color,width,dash){drawCalls.push({kind:'pv',color,dash});return pv(ctx,map,th,color,width,dash);};
      drawCycleOnTs=function(ctx,map,th,color,width,dash){drawCalls.push({kind:'ts',color,dash});return ts(ctx,map,th,color,width,dash);};
      window.mapCalls=[];const mapper=makeMapFromBounds;
      makeMapFromBounds=function(b,w,h){mapCalls.push({...b});return mapper(b,w,h);};
    }""")
    page.locator('#comparePreset').click()
    check('preset enables Otto r18 and Diesel r18 rc2',page.evaluate("compareMode.enabled&&compareMode.cycles.join(',')==='otto,diesel'&&compareMode.params[0].r===18&&compareMode.params[1].r===18&&compareMode.params[1].rc===2"))
    preset=page.evaluate('getComparisonData()')
    for i,d in enumerate(preset):
        single=standalone.evaluate("""d=>{switchCycle(d.cycle);currentParams=d.params;refresh();return {th:currentThermo,cards:document.getElementById('results').innerText};}""",d)
        check(f'preset cycle {i+1} raw results exactly equal standalone display computation',d['th']==single['th'])
        for metric,factor in [('eta',100),('qIn',1),('qOut',1),('wNet',1)]:
            shown=page.locator(f'#compareTable [data-cycle-index="{i}"][data-metric="{metric}"]').inner_text()
            expected=f"{single['th'][metric]*factor:.2f}"
            check(f'preset cycle {i+1} displayed {metric} equals standalone',shown==expected and expected in single['cards'])
    check('both colors and distinct line patterns drawn on both charts',page.evaluate("['pv','ts'].every(kind=>drawCalls.some(c=>c.kind===kind&&c.color==='#2563eb'&&c.dash.length===0)&&drawCalls.some(c=>c.kind===kind&&c.color==='#ea580c'&&c.dash.join(',')==='8,3'))"))
    check('preset does not mutate original model or locked bounds',page.evaluate('baseState()===beforeBase'))
    for a,b in [('otto','diesel'),('otto','brayton'),('diesel','brayton'),('diesel','otto'),('brayton','otto'),('brayton','diesel')]:
        page.locator('#compareCycle0').select_option(a)
        page.locator('#compareCycle1').select_option(b)
        data=page.evaluate('getComparisonData()')
        check(a+' '+b+' selects two distinct cycles',[d['cycle'] for d in data]==[a,b])
        for i,d in enumerate(data):
            single=standalone.evaluate('d=>{switchCycle(d.cycle);currentParams=d.params;refresh();return currentThermo;}',d)
            check(a+' '+b+f' cycle {i+1} exactly equals standalone',d['th']==single)
        for area in [False,True]:
            for ref in [False,True]:
                page.evaluate("""([area,ref])=>{
                  for(const id of ['pvAreaToggle','tsAreaToggle']){const e=document.getElementById(id);if(e.checked!==area)e.click();}
                  for(const id of ['pvRefToggle','tsRefToggle']){const e=document.getElementById(id);if(e.checked!==ref)e.click();}
                }""",[area,ref])
                check(f'{a} {b} area={area} refs={ref} curves and references fit shared bounds',page.evaluate("""() => {
                  const data=getComparisonData();
                  return ['pv','ts'].every(kind=>{
                    const bounds=compareMode[kind+'Bounds'],x=kind==='pv'?'v':'s',y=kind==='pv'?'p':'T';
                    return data.every(d=>[d.th,...(showPvRef?[d.reference]:[])].every(th=>getCycleAreaData(th)[kind].flat().every(pt=>pt[x]>=bounds.xMin-1e-9&&pt[x]<=bounds.xMax+1e-9&&pt[y]>=bounds.yMin-1e-9&&pt[y]<=bounds.yMax+1e-9)));
                  });
                }"""))
                check(f'{a} {b} area={area} refs={ref} base state unchanged',page.evaluate('baseState()===beforeBase'))
                check(f'{a} {b} reference checkbox controls reference drawing',page.evaluate("""ref=>{
                  drawCalls=[];drawPvDiagram(currentThermo);drawTsDiagram(currentThermo);
                  return drawCalls.filter(c=>c.color==='#94a3b8').length===(ref?4:0);
                }""",ref))
                if area:
                    check(a+' '+b+' area mode starts at zero K',page.evaluate("mapCalls.at(-1).yMin===0"))
    page.locator('#comparePreset').click()
    page.locator('#compareParam0-r').fill('24');page.locator('#compareParam0-r').press('Tab')
    expanded=page.evaluate('structuredClone(compareMode.pvBounds)')
    page.locator('#compareParam0-r').fill('18');page.locator('#compareParam0-r').press('Tab')
    check('comparison axes remain locked when parameters shrink',page.evaluate('(b)=>JSON.stringify(compareMode.pvBounds)===JSON.stringify(b)',expanded))
    page.locator('#pvReset').click()
    check('reset comparison view shrinks expanded axes without touching base',page.evaluate('(b)=>compareMode.pvBounds.yMax<b.yMax&&baseState()===beforeBase',expanded))
    old=page.locator('#compareParam0-r').input_value()
    page.locator('#compareParam0-r').fill('999');page.locator('#compareParam0-r').press('Tab')
    check('invalid comparison input restores previous valid value',page.locator('#compareParam0-r').input_value()==old)
    page.locator('#comparePreset').click()
    check('single-cycle panels hidden during comparison',page.locator('#stateTableSection').is_hidden() and page.locator('#derivationSection').is_hidden() and page.locator('#effCurveSection').is_hidden() and page.locator('#results').is_hidden())
    page.evaluate('window.beforeTour=JSON.stringify(compareMode);')
    page.locator('#tourHelp').click()
    for i in range(4):
        check(f'guide step {i+1} works in comparison',page.locator('#tourBubble').is_visible() and page.locator('.tour-target').is_visible())
        if i==3:
            check('guide last step points at comparison table',page.locator('#tourText').inner_text()=='并排比较两边的效率和热量' and page.locator('#compareResults').get_attribute('class') and 'tour-target' in page.locator('#compareResults').get_attribute('class'))
        page.locator('#tourNext').click()
    check('guide leaves comparison state unchanged',page.evaluate('JSON.stringify(compareMode)===beforeTour'))
    page.evaluate('window.beforeQuiz=JSON.stringify(compareMode);window.beforeCompareCanvas=canvasState();')
    page.locator('#quizStart').click()
    check('quiz suspends comparison and prevents editing comparison setup',page.evaluate('compareMode.enabled&&compareMode.suspended&&!isComparisonActive()') and page.locator('#compareToggle').is_disabled() and page.locator('#comparePreset').is_disabled())
    questions=page.evaluate('getPredictionQuestions()')
    for i,q in enumerate(questions):
        page.get_by_role('button',name=q['answer'],exact=True).click()
        page.locator('#quizNext').wait_for(state='visible')
        check(f'quiz question {i+1} unaffected by comparison','预测正确' in page.locator('#quizStatus').inner_text() and page.evaluate('(q)=>currentThermo.eta===q.after.eta',q))
        page.locator('#quizNext').click()
    check('quiz completion restores comparison data, locked axes and pixels',page.evaluate('JSON.stringify(compareMode)===beforeQuiz&&canvasState()===beforeCompareCanvas'))
    page.locator('#quizStart').click();page.locator('#quizChoices button').first.click();page.locator('#quizExit').click();page.wait_for_timeout(700)
    check('quiz early exit restores comparison without delayed redraw',page.evaluate('JSON.stringify(compareMode)===beforeQuiz&&canvasState()===beforeCompareCanvas'))
    page.locator('#compareToggle').uncheck()
    check('closing comparison restores exact original view and settings',page.evaluate('viewState()===beforeView'))
    check('closing comparison unlocks original parameter controls',page.locator('#tabs button:disabled, #params input:disabled').count()==0)
    check('closing comparison restores single-cycle panels',page.locator('#stateTableSection').is_visible() and page.locator('#derivationSection').is_visible() and page.locator('#effCurveSection').is_visible() and page.locator('#results').is_visible())
    page.locator('#compareToggle').check();page.locator('#compareToggle').uncheck()
    check('repeat toggle has no cumulative original view changes',page.evaluate('viewState()===beforeView'))
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        page.locator('#comparePreset').click()
        for pair in [('otto','diesel'),('otto','brayton'),('diesel','brayton')]:
            page.locator('#compareCycle0').select_option(pair[0]);page.locator('#compareCycle1').select_option(pair[1])
            page.locator('#compareTable').scroll_into_view_if_needed()
            check(f'{width}px pair {pair} table and page fit viewport',page.evaluate("document.documentElement.scrollWidth<=innerWidth&&document.getElementById('compareTable').getBoundingClientRect().right<=innerWidth"))
            page.locator('#tsAreaToggle').check();page.locator('#pvAreaToggle').check()
            check(f'{width}px pair {pair} areas remain usable',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        page.locator('#compareToggle').uncheck()
    page.set_viewport_size({'width':1440,'height':1500})
    page.locator('#comparePreset').click();page.locator('#pvAreaToggle').uncheck();page.locator('#tsAreaToggle').uncheck()
    page.locator('#pvRefToggle').check();page.locator('#tsRefToggle').check()
    page.locator('#compareTitle').scroll_into_view_if_needed()
    page.screenshot(path=str(ROOT/'reports'/('compare-live-desktop.png' if live else 'compare-desktop.png')),full_page=True)
    check('original calculator still passes',page.evaluate('runTests()')=={'pass':18,'fail':0})
    check('no browser errors',not errors)
    check('AI visibility matches configuration with no automatic calls',not requests and page.evaluate("[...document.querySelectorAll('[data-ai]')].every(e=>e.hidden===!isAIEnabled())"))
    browser.close()
server.shutdown()
result={'pass':len(checks),'fail':0,'checks':checks,'preset':preset,'mobileWidths':[390,320],'url':url if live else 'local test server'}
(ROOT/'reports'/('compare-live-results.json' if live else 'compare-test-results.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(f'{len(checks)} passed, 0 failed')
