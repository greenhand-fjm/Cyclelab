(function() {
  var questions, index=0, score=0, snapshot=null, frame=null;
  var el={};
  function setControls(disabled) {
    document.querySelectorAll('#tabs button, #params input, #pvReset, #tsReset').forEach(function(e){e.disabled=disabled;});
  }
  function syncParams() {
    PARAM_DEFS[currentCycle].forEach(function(d,i) {
      document.querySelectorAll('#params .param-group')[i].querySelectorAll('input').forEach(function(input){input.value=currentParams[d.key];});
    });
  }
  function apply(cycle,params) {
    switchCycle(cycle);
    currentParams=Object.assign({},params);
    syncParams();
    refresh();
    setControls(true);
  }
  function restore() {
    cancelAnimationFrame(frame);
    frame=null;
    if(!snapshot) return;
    apply(snapshot.cycle,snapshot.params);
    pvLocked=snapshot.pvLocked; tsLocked=snapshot.tsLocked;
    pvRefTh=snapshot.pvRefTh; tsRefNorm=snapshot.tsRefNorm;
    showPvRef=snapshot.showPvRef; showTsRef=snapshot.showTsRef;
    showPvArea=snapshot.showPvArea; showTsArea=snapshot.showTsArea;
    [['pvRefToggle',showPvRef],['tsRefToggle',showTsRef],['pvAreaToggle',showPvArea],['tsAreaToggle',showTsArea]].forEach(function(pair){document.getElementById(pair[0]).checked=pair[1];});
    refresh();
    setControls(false);
    snapshot=null;
    resumeComparison();
  }
  function renderQuestion() {
    var q=questions[index];
    apply(q.beforeCycle,q.beforeParams);
    el.quizProgress.textContent='预测 · '+(index+1)+' / '+questions.length+' · 已答对 '+score+' 题';
    el.quizQuestion.textContent=q.prompt;
    el.quizChoices.replaceChildren();
    q.choices.forEach(function(choice) {
      var button=document.createElement('button'); button.type='button'; button.textContent=choice;
      button.addEventListener('click',function(){answer(choice,button);});
      el.quizChoices.appendChild(button);
    });
    el.quizStatus.textContent='先选一个答案，再看变化。';
    el.quizExplanation.hidden=true;
    el.quizExplanation.replaceChildren();
    el.quizNext.hidden=true;
    el.quizQuestion.focus({preventScroll:true});
  }
  function explain(q,choice) {
    frame=null;
    apply(q.afterCycle,q.afterParams);
    el.quizProgress.textContent='解释 · '+(index+1)+' / '+questions.length+' · 已答对 '+score+' 题';
    el.quizStatus.textContent=(choice===q.answer?'预测正确。':'再想一想。')+' 标准答案：'+q.answer+'。';
    var reason=document.createElement('p'); reason.textContent=q.reason;
    el.quizExplanation.appendChild(reason);
    var values=document.createElement('div'); values.className='quiz-values';
    q.values.forEach(function(item,i) {
      var p=document.createElement('p');
      p.appendChild(document.createTextNode(item.label+'：'));
      var number=document.createElement('strong'); number.dataset.valueIndex=i;
      number.textContent=item.value.toFixed(2);
      p.appendChild(number); p.appendChild(document.createTextNode(item.unit)); values.appendChild(p);
    });
    el.quizExplanation.appendChild(values);
    el.quizExplanation.hidden=false;
    el.quizNext.textContent=index===questions.length-1?'完成并恢复工况':'下一题';
    el.quizNext.hidden=false;
    el.quizNext.focus({preventScroll:true});
  }
  function answer(choice,button) {
    var q=questions[index];
    el.quizChoices.querySelectorAll('button').forEach(function(b){b.disabled=true;b.setAttribute('aria-pressed',String(b===button));});
    if(choice===q.answer) score++;
    el.quizStatus.textContent='观察：图像正在从变化前过渡到变化后。';
    el.quizProgress.textContent='观察 · '+(index+1)+' / '+questions.length;
    var start;
    var duration=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:600;
    function animate(time) {
      if(start===undefined) start=time;
      var t=duration?Math.min((time-start)/duration,1):1;
      var th={processCurves:q.after.processCurves,states:q.before.states.map(function(state,i){
        var next={}; Object.keys(state).forEach(function(key){next[key]=state[key]+(q.after.states[i][key]-state[key])*t;}); return next;
      })};
      ['eta','etaC','qIn','qOut','wNet'].forEach(function(key){th[key]=q.before[key]+(q.after[key]-q.before[key])*t;});
      drawPvDiagram(th); drawTsDiagram(th);
      if(t<1) frame=requestAnimationFrame(animate); else explain(q,choice);
    }
    frame=requestAnimationFrame(animate);
  }
  function start() {
    suspendComparison();
    snapshot=structuredClone({cycle:currentCycle,params:currentParams,pvLocked:pvLocked,tsLocked:tsLocked,pvRefTh:pvRefTh,tsRefNorm:tsRefNorm,showPvRef:showPvRef,showTsRef:showTsRef,showPvArea:showPvArea,showTsArea:showTsArea});
    questions=getPredictionQuestions(); index=0; score=0;
    el.quizStart.hidden=true; el.quizIntro.hidden=true; el.quizBody.hidden=false;
    renderQuestion();
  }
  document.addEventListener('DOMContentLoaded',function() {
    ['quizStart','quizIntro','quizBody','quizProgress','quizQuestion','quizChoices','quizStatus','quizExplanation','quizNext','quizExit'].forEach(function(id){el[id]=document.getElementById(id);});
    el.quizStart.addEventListener('click',start);
    el.quizNext.addEventListener('click',function() {
      if(index<questions.length-1) {index++;renderQuestion();return;}
      restore();
      el.quizBody.hidden=true; el.quizIntro.hidden=false; el.quizStart.hidden=false;
      el.quizIntro.textContent='练习完成：答对 '+score+' / '+questions.length+' 题。'+(compareMode.enabled?'已恢复对比模式。':'已恢复进入练习前的工况。');
      el.quizStart.textContent='重新开始'; el.quizStart.focus({preventScroll:true});
    });
    el.quizExit.addEventListener('click',function() {
      restore(); el.quizBody.hidden=true; el.quizIntro.hidden=false; el.quizStart.hidden=false;
      el.quizIntro.textContent='已退出并恢复进入练习前的工况。';
      el.quizStart.textContent='重新开始'; el.quizStart.focus({preventScroll:true});
    });
  });
})();
