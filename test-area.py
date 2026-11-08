import hashlib
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
url = sys.argv[sys.argv.index('--live') + 1] if '--live' in sys.argv else f'http://127.0.0.1:{server.server_port}'
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width':1440,'height':1000})
    page.add_init_script("localStorage.setItem('cyclelab.tour.seen.v1','true')")
    page.goto(url)
    snapshots = page.evaluate("""() => {
      const results=[];
      for(const cycle of ['otto','diesel','brayton']){
        switchCycle(cycle);
        const capture=stage=>results.push({cycle,stage,pv:document.getElementById('pvCanvas').toDataURL(),ts:document.getElementById('tsCanvas').toDataURL(),bounds:JSON.stringify({pvLocked,tsLocked}),refs:JSON.stringify({pvRefTh,tsRefNorm})});
        capture('default');
        const slider=document.querySelector('#params input[type=range]');slider.value=Number(slider.value)+Number(slider.step);slider.dispatchEvent(new Event('input'));capture('changed');
        document.getElementById('pvRefToggle').click();document.getElementById('tsRefToggle').click();capture('refs-off');
        document.getElementById('pvReset').click();document.getElementById('tsReset').click();capture('reset');
        document.getElementById('pvRefToggle').click();document.getElementById('tsRefToggle').click();
      }
      return results;
    }""")
    for item in snapshots:
        for key in ['pv','ts','refs']:
            item[key]=hashlib.sha256(item[key].encode()).hexdigest()
    baseline=ROOT/'reports'/'area-off-baseline.json'
    if '--baseline' in sys.argv:
        baseline.write_text(json.dumps(snapshots,indent=2),encoding='utf8')
        print('Saved 12 pre-change canvas and axis/reference snapshots')
    else:
        assert snapshots==json.loads(baseline.read_text(encoding='utf8')), 'Area-off canvas/axes/reference behavior changed'
        print('PASS 12 pre-change pixel/axis/reference comparisons')
    if '--baseline' not in sys.argv:
        result = page.evaluate("""() => {
          const checks=[], rows=[];
          const check=(name,pass)=>{if(!pass)throw Error(name);checks.push(name);};
          const toggle=(id)=>document.getElementById(id).click();
          const canvas=()=>JSON.stringify(['pvCanvas','tsCanvas'].map(id=>document.getElementById(id).toDataURL()));
          const bounds=()=>JSON.stringify({pvLocked,tsLocked,pvRefTh,tsRefNorm});
          for(const cycle of ['otto','diesel','brayton']){
            switchCycle(cycle);
            const th=currentThermo, data=getCycleAreaData(th);
            const values={qIn:integrateCurve(data.ts[1],'s','T'),qOut:-integrateCurve(data.ts[3],'s','T'),tsNet:data.ts.reduce((sum,c)=>sum+integrateCurve(c,'s','T'),0),pvNet:data.pv.reduce((sum,c)=>sum+integrateCurve(c,'v','p'),0)};
            const expected={qIn:th.qIn,qOut:th.qOut,tsNet:th.wNet,pvNet:th.wNet};
            for(const metric of Object.keys(values)){
              const error=Math.abs(values[metric]-expected[metric])/Math.abs(expected[metric])*100;
              check(cycle+' '+metric+' integral error <0.5%',error<0.5);
              rows.push({cycle,metric,integral:values[metric],formula:expected[metric],errorPercent:error});
            }
            for(const stage of ['default','changed','refs-off','reset']){
              if(stage==='changed'){const slider=document.querySelector('#params input[type=range]');slider.value=Number(slider.value)+Number(slider.step);slider.dispatchEvent(new Event('input'));}
              if(stage==='refs-off'){toggle('pvRefToggle');toggle('tsRefToggle');}
              if(stage==='reset'){toggle('pvReset');toggle('tsReset');}
              const before=canvas(), locked=bounds();
              toggle('pvAreaToggle');toggle('tsAreaToggle');
              check(cycle+' '+stage+' no locked/reference mutation',bounds()===locked);
              check(cycle+' '+stage+' values visible',!document.getElementById('tsAreaValues').hidden&&!document.getElementById('pvAreaValues').hidden);
              check(cycle+' '+stage+' live formula labels',document.getElementById('tsAreaValues').textContent.includes(currentThermo.qIn.toFixed(2))&&document.getElementById('pvAreaValues').textContent.includes(currentThermo.wNet.toFixed(2)));
              toggle('pvAreaToggle');toggle('tsAreaToggle');
              check(cycle+' '+stage+' exact pixel round trip',canvas()===before&&bounds()===locked);
            }
            toggle('pvRefToggle');toggle('tsRefToggle');
            const original=makeMapFromBounds, observed=[];
            makeMapFromBounds=function(b,w,h){observed.push({...b});return original(b,w,h);};
            tsLocked.yMin=-100;
            toggle('tsAreaToggle');
            check(cycle+' T axis starts at zero even with negative locked bound',observed.at(-1).yMin===0&&tsLocked.yMin===-100);
            toggle('tsReset');
            check(cycle+' reset keeps zero T baseline in area mode',observed.at(-1).yMin===0);
            toggle('tsAreaToggle');makeMapFromBounds=original;
          }
          switchCycle('otto');toggle('pvAreaToggle');toggle('tsAreaToggle');
          check('existing tests pass',runTests().fail===0);
          return {checks,rows,pass:checks.length,fail:0};
        }""")
        for name in result['checks']: print('PASS '+name)
        live = '--live' in sys.argv
        page.locator('.diagrams').scroll_into_view_if_needed()
        page.screenshot(path=str(ROOT/'reports'/('area-live-desktop.png' if live else 'area-desktop.png')))
        for width in [390,320]:
            page.set_viewport_size({'width':width,'height':844})
            page.wait_for_function('()=>document.getElementById("pvCanvas").width>0')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Mobile overflow'
        result['mobileWidths']=[390,320]
        (ROOT/'reports'/('area-live-results.json' if live else 'area-test-results.json')).write_text(json.dumps(result,indent=2),encoding='utf8')
        print(json.dumps({'pass':result['pass'],'fail':0,'integrals':result['rows']},indent=2))
    browser.close()
server.shutdown()
