import json
import math
import re
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
url = sys.argv[sys.argv.index('--live')+1] if live else f'http://127.0.0.1:{server.server_port}'
checks = []
def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS '+name)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width':1440,'height':1100})
    page.add_init_script("localStorage.setItem('cyclelab.tour.seen.v1','true')")
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: requests.append(r.url) if '/functions/' in r.url else None)
    page.goto(url)
    questions = page.evaluate('getPredictionQuestions()')
    expected = ['升高','升高','降低','升高','不变','降低','不变','效率不变、净功增大']
    check('exactly eight questions with required standard answers', len(questions)==8 and [q['answer'] for q in questions]==expected)
    rows=[]
    for i,q in enumerate(questions):
        fresh = page.evaluate('(q)=>({before:calculate(q.beforeCycle,q.beforeParams),after:calculate(q.afterCycle,q.afterParams)})',q)
        b,a=fresh['before'],fresh['after']
        delta=a['eta']-b['eta']
        direction='不变' if abs(delta)<1e-10 else '升高' if delta>0 else '降低'
        check(f'question {i+1} answer agrees with computed direction', direction==('不变' if i==7 else expected[i]) and (i!=7 or a['wNet']>b['wNet']))
        values=[b['eta']*100,a['eta']*100,b['wNet'],a['wNet']]
        check(f'question {i+1} all explanation values equal fresh thermo calculations',all(math.isclose(item['value'],v,rel_tol=1e-12,abs_tol=1e-10) for item,v in zip(q['values'],values)))
        if i==5:
            prompt_values=[b['states'][0]['v']/b['states'][1]['v'],a['states'][2]['v']/a['states'][1]['v']]
        else:
            key=['r','r','rc','pi','T1',None,'T3','T3'][i]
            def param(th):
                st=th['states']
                return st[0]['v']/st[1]['v'] if key=='r' else st[2]['v']/st[1]['v'] if key=='rc' else st[1]['p']/st[0]['p'] if key=='pi' else st[0 if key=='T1' else 2]['T']
            prompt_values=[param(b),param(a)]
        # T3/T1 labels use Chinese names, leaving only scenario values as numerals.
        numbers=[float(n) for n in re.findall(r'\d+(?:\.\d+)?',q['prompt'])]
        check(f'question {i+1} prompt numbers derive from calculated states',len(numbers)==len(prompt_values) and all(math.isclose(x,y,rel_tol=1e-5) for x,y in zip(numbers,prompt_values)))
        rows.append({'question':q['prompt'],'answer':q['answer'],'beforeCycle':q['beforeCycle'],'afterCycle':q['afterCycle'],'beforeParams':q['beforeParams'],'afterParams':q['afterParams'],'etaBeforePercent':b['eta']*100,'etaAfterPercent':a['eta']*100,'workBefore':b['wNet'],'workAfter':a['wNet']})
    check('question generation recalculates after runtime default change',page.evaluate("""() => {
      const d=PARAM_DEFS.otto.find(d=>d.key==='T1'), original=d.def;
      try {d.def=original+d.step;const q=getPredictionQuestions()[4];return q.before.states[0].T===d.def&&q.prompt.includes(String(d.def))&&q.values[2].value===calculate('otto',q.beforeParams).wNet;}
      finally {d.def=original;}
    }"""))
    page.evaluate("""() => {
      switchCycle('diesel');currentParams={r:19.5,rc:2.3,T1:315,p1:115};
      PARAM_DEFS.diesel.forEach((d,i)=>document.querySelectorAll('#params .param-group')[i].querySelectorAll('input').forEach(e=>e.value=currentParams[d.key]));
      document.getElementById('pvRefToggle').click();document.getElementById('tsAreaToggle').click();refresh();
      window.captureQuizState=()=>JSON.stringify({currentCycle,currentParams,pvLocked,tsLocked,pvRefTh,tsRefNorm,showPvRef,showTsRef,showPvArea,showTsArea,inputs:[...document.querySelectorAll('#params input')].map(e=>e.value),pv:document.getElementById('pvCanvas').toDataURL(),ts:document.getElementById('tsCanvas').toDataURL()});
      window.quizBefore=captureQuizState();
      window.quizFrames=[];const original=drawPvDiagram;
      drawPvDiagram=function(th){quizFrames.push(th.states[2].T+th.states[1].p);return original(th);};
    }""")
    page.locator('#quizStart').click()
    check('practice locks external parameter and cycle edits',page.locator('#params input:enabled, #tabs button:enabled, #pvReset:enabled, #tsReset:enabled').count()==0)
    for i,q in enumerate(questions):
        check(f'question {i+1} prediction hides explanation',page.locator('#quizQuestion').inner_text()==q['prompt'] and page.locator('#quizExplanation').is_hidden())
        button=page.locator('#quizChoices button').filter(has_text=re.compile('^'+re.escape(q['answer'])+'$'))
        if i==0:
            button.focus();page.keyboard.press('Enter')
        else: button.click()
        page.locator('#quizNext').wait_for(state='visible')
        check(f'question {i+1} observes calculated target and marks correct answer',page.evaluate('(q)=>currentCycle===q.afterCycle&&JSON.stringify(currentParams)===JSON.stringify(q.afterParams)&&Math.abs(currentThermo.eta-q.after.eta)<1e-12',q) and '预测正确' in page.locator('#quizStatus').inner_text())
        displayed=page.locator('#quizExplanation strong').all_text_contents()
        check(f'question {i+1} every rendered number matches calculation rounding',displayed==[f"{v['value']:.2f}" for v in q['values']] and re.findall(r'\d+(?:\.\d+)?',page.locator('#quizExplanation').inner_text())==displayed)
        check(f'question {i+1} cannot answer twice',page.locator('#quizChoices button:enabled').count()==0)
        if i==7:
            page.locator('#quizTitle').scroll_into_view_if_needed()
            page.screenshot(path=str(ROOT/'reports'/('quiz-live-desktop.png' if live else 'quiz-desktop.png')))
        page.locator('#quizNext').click()
    check('complete score and restart offered', '8 / 8' in page.locator('#quizIntro').inner_text() and page.locator('#quizStart').inner_text()=='重新开始')
    check('completion restores exact custom params, inputs, axes, references and canvas',page.evaluate('captureQuizState()===quizBefore'))
    check('animation draws multiple distinct intermediate states',page.evaluate('new Set(quizFrames).size>20'))
    check('completion unlocks calculator',page.locator('#params input:disabled, #tabs button:disabled').count()==0)
    page.locator('#quizStart').click()
    for q in questions:
        wrong=next(c for c in q['choices'] if c!=q['answer'])
        page.locator('#quizChoices button').filter(has_text=re.compile('^'+re.escape(wrong)+'$')).click()
        page.locator('#quizNext').wait_for(state='visible')
        check('incorrect answer shows standard answer '+q['answer'],'再想一想' in page.locator('#quizStatus').inner_text() and q['answer'] in page.locator('#quizStatus').inner_text())
        page.locator('#quizNext').click()
    check('restart resets score and wrong answers do not score','0 / 8' in page.locator('#quizIntro').inner_text())
    page.locator('#quizStart').click()
    page.locator('#quizChoices button').first.click()
    page.locator('#quizExit').click()
    page.wait_for_timeout(750)
    check('exit during animation cancels pending updates and restores exact state',page.evaluate('captureQuizState()===quizBefore') and page.locator('#quizStart').is_visible())
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        page.locator('#quizStart').click()
        for q in questions:
            check(f'{width}px question and choices fit viewport',page.evaluate("document.documentElement.scrollWidth<=innerWidth") and page.locator('#quizChoices button').count()==3)
            page.locator('#quizChoices button').filter(has_text=re.compile('^'+re.escape(q['answer'])+'$')).click()
            page.locator('#quizNext').wait_for(state='visible')
            check(f'{width}px explanation fits viewport',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
            page.locator('#quizNext').click()
        check(f'{width}px all eight questions usable','8 / 8' in page.locator('#quizIntro').inner_text())
    check('existing calculator tests pass',page.evaluate('runTests()')=={'pass':18,'fail':0})
    check('AI visibility matches configuration with zero automatic requests',not requests and page.evaluate("[...document.querySelectorAll('[data-ai]')].every(e=>e.hidden===!isAIEnabled())"))
    check('no uncaught browser exceptions',not errors)
    reduced=browser.new_context(reduced_motion='reduce')
    reduced.add_init_script("localStorage.setItem('cyclelab.tour.seen.v1','true')")
    rp=reduced.new_page();rp.goto(url);rp.locator('#quizStart').click();rp.locator('#quizChoices button').first.click();rp.locator('#quizNext').wait_for(state='visible')
    check('reduced motion still reveals correct result', '预测正确' in rp.locator('#quizStatus').inner_text())
    reduced.close();browser.close()
server.shutdown()
result={'pass':len(checks),'fail':0,'checks':checks,'rows':rows,'url':url if live else 'local test server','mobileWidths':[390,320]}
(ROOT/'reports'/('quiz-live-results.json' if live else 'quiz-test-results.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(f'{len(checks)} passed, 0 failed')
