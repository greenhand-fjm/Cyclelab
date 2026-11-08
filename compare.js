var compareMode={enabled:false,suspended:false,cycles:['otto','diesel'],params:[null,null],pvBounds:null,tsBounds:null,savedToggles:null};
var comparisonNames={otto:'奥托循环',diesel:'狄塞尔循环',brayton:'布雷顿循环'};
var comparisonColors=['#2563eb','#ea580c'];

function getComparisonData() {
  return compareMode.cycles.map(function(cycle,i) {
    return {cycle:cycle,params:compareMode.params[i],th:calculate(cycle,compareMode.params[i]),reference:calculate(cycle,getDefaultParams(cycle))};
  });
}
function comparisonVisibility() {
  var active=isComparisonActive();
  document.getElementById('compareBody').hidden=!active;
  document.getElementById('compareResults').hidden=!active;
  document.getElementById('results').hidden=active;
  ['stateTableSection','derivationSection','effCurveSection'].forEach(function(id){document.getElementById(id).hidden=active;});
  document.getElementById('quizTitle').textContent=active?'先猜后看 · 预测练习（对比期间暂停）':'先猜后看 · 预测练习';
  document.getElementById('quizIntro').textContent=active&&!compareMode.suspended?'对比模式开启中。开始练习会暂停对比并独立计算，完成或退出后恢复对比。':'先预测，再观察图像与计算结果。完成或退出后恢复你原来的工况。';
  document.querySelectorAll('#tabs button, #params input').forEach(function(e){e.disabled=active;});
}
function setComparison(enabled) {
  if(enabled===compareMode.enabled) return;
  if(enabled) {
    compareMode.savedToggles={showPvRef:showPvRef,showTsRef:showTsRef,showPvArea:showPvArea,showTsArea:showTsArea};
    compareMode.params=compareMode.cycles.map(function(cycle,i){return compareMode.params[i]||getDefaultParams(cycle);});
    compareMode.pvBounds=null; compareMode.tsBounds=null;
  } else {
    var flags=compareMode.savedToggles;
    showPvRef=flags.showPvRef;showTsRef=flags.showTsRef;showPvArea=flags.showPvArea;showTsArea=flags.showTsArea;
    [['pvRefToggle',showPvRef],['tsRefToggle',showTsRef],['pvAreaToggle',showPvArea],['tsAreaToggle',showTsArea]].forEach(function(pair){document.getElementById(pair[0]).checked=pair[1];});
  }
  compareMode.enabled=enabled;
  document.getElementById('compareToggle').checked=enabled;
  comparisonVisibility();
  if(enabled) buildComparisonEditors();
  refresh();
  if(enabled) updateComparisonTable();
}
function suspendComparison() {
  compareMode.suspended=true;
  comparisonVisibility();
  document.getElementById('compareToggle').disabled=true;
  document.getElementById('comparePreset').disabled=true;
  refresh();
}
function resumeComparison() {
  compareMode.suspended=false;
  document.getElementById('compareToggle').disabled=false;
  document.getElementById('comparePreset').disabled=false;
  comparisonVisibility();
  refresh();
  if(compareMode.enabled) updateComparisonTable();
}
function buildComparisonEditors() {
  var root=document.getElementById('compareEditors'); root.replaceChildren();
  compareMode.cycles.forEach(function(cycle,i) {
    var fieldset=document.createElement('fieldset');
    var legend=document.createElement('legend'); legend.textContent=i===0?'蓝色实线':'橙色虚线';fieldset.appendChild(legend);
    var label=document.createElement('label');label.textContent='循环';
    var select=document.createElement('select');select.id='compareCycle'+i;
    Object.keys(comparisonNames).forEach(function(key){var option=document.createElement('option');option.value=key;option.textContent=comparisonNames[key];option.selected=key===cycle;select.appendChild(option);});
    select.addEventListener('change',function() {
      var other=1-i;
      if(select.value===compareMode.cycles[other]) {
        compareMode.cycles[other]=cycle;compareMode.params[other]=getDefaultParams(cycle);
      }
      compareMode.cycles[i]=select.value;compareMode.params[i]=getDefaultParams(select.value);
      compareMode.pvBounds=null;compareMode.tsBounds=null;
      buildComparisonEditors();refresh();updateComparisonTable();
    });
    label.appendChild(select);fieldset.appendChild(label);
    PARAM_DEFS[cycle].forEach(function(def) {
      var label=document.createElement('label');label.textContent=def.label;
      var input=document.createElement('input');input.type=def.checkbox?'checkbox':'number';input.id='compareParam'+i+'-'+def.key;
      input.min=def.min;input.max=cycle==='otto'&&def.key==='r'?24:def.max;input.step=def.step;input.value=compareMode.params[i][def.key];
      if(def.checkbox)input.checked=compareMode.params[i][def.key]===1;
      input.addEventListener('change',function() {
        var value=def.checkbox?(input.checked?1:0):Number(input.value);
        if(input.value===''||!Number.isFinite(value)||value<Number(input.min)||value>Number(input.max)) {input.value=compareMode.params[i][def.key];return;}
        compareMode.params[i][def.key]=value;refresh();updateComparisonTable();
      });
      label.appendChild(input);fieldset.appendChild(label);
    });
    if(cycle==='brayton') {var note=document.createElement('p');note.id='compareRegenNote'+i;note.className='compare-note';note.setAttribute('role','status');fieldset.appendChild(note);}
    root.appendChild(fieldset);
  });
}
function applyComparisonPreset() {
  if(!compareMode.enabled) setComparison(true);
  compareMode.cycles=['otto','diesel'];
  compareMode.params=[Object.assign(getDefaultParams('otto'),{r:18}),Object.assign(getDefaultParams('diesel'),{r:18,rc:2})];
  compareMode.pvBounds=null;compareMode.tsBounds=null;
  buildComparisonEditors();refresh();updateComparisonTable();
}
function updateComparisonTable() {
  var data=getComparisonData(), table=document.getElementById('compareTable');table.replaceChildren();
  data.forEach(function(d,i){var note=document.getElementById('compareRegenNote'+i);if(note){var regen=d.th.regeneration;note.textContent=regen?(regen.feasible?'回热 ε='+regen.epsilon+'；无回热效率 '+(regen.etaWithout*100).toFixed(2)+'%；回热量 '+regen.q.toFixed(2)+' kJ/kg':'此工况下回热不可行（T₄ ≤ T₂），按无回热计算。'):'理想回热关闭';}});
  var head=table.createTHead().insertRow();
  ['指标'].concat(data.map(function(d){return comparisonNames[d.cycle];})).forEach(function(text,i){var th=document.createElement('th');th.scope='col';th.textContent=text;if(i)th.style.color=comparisonColors[i-1];head.appendChild(th);});
  var body=table.createTBody();
  [{key:'eta',label:'热效率 η (%)',factor:100},{key:'qIn',label:'q_in (kJ/kg)',factor:1},{key:'qOut',label:'q_out (kJ/kg)',factor:1},{key:'wNet',label:'w_net (kJ/kg)',factor:1}].forEach(function(metric) {
    var row=body.insertRow();var heading=document.createElement('th');heading.scope='row';heading.textContent=metric.label;row.appendChild(heading);
    data.forEach(function(d,i){var cell=row.insertCell();cell.dataset.cycleIndex=i;cell.dataset.metric=metric.key;cell.textContent=(d.th[metric.key]*metric.factor).toFixed(2);});
  });
}
function buildComparisonLegend() {
  var html=compareMode.cycles.map(function(cycle,i){return '<div class="legend-item"><span class="compare-line compare-line-'+i+'"></span>'+comparisonNames[cycle]+(compareMode.params[i].regen===1?'（回热 ε='+smartFmt(compareMode.params[i].epsilon)+'；短虚线为内部回热）':'')+'</div>';}).join('');
  document.getElementById('pvLegend').innerHTML=html;document.getElementById('tsLegend').innerHTML=html;
}
function updateComparisonAreaLabels() {
  var data=getComparisonData();
  updateAreaExplanation(data.some(function(d){return d.th.regeneration&&d.th.regeneration.q>0;}));
  ['pv','ts'].forEach(function(kind) {
    var el=document.getElementById(kind+'AreaValues');el.hidden=kind==='pv'?!showPvArea:!showTsArea;
    el.textContent=data.map(function(d){return comparisonNames[d.cycle]+'：'+(kind==='ts'?'q_in = '+d.th.qIn.toFixed(2)+'，q_out = '+d.th.qOut.toFixed(2)+'，':'')+'w_net = '+d.th.wNet.toFixed(2)+' kJ/kg';}).join('；');
  });
  document.getElementById('areaExplanation').hidden=!showPvArea&&!showTsArea;
}
function drawComparisonDiagram(kind) {
  var isPv=kind==='pv', data=getComparisonData(), key=isPv?'pvBounds':'tsBounds';
  var xKey=isPv?'v':'s',yKey=isPv?'p':'T';
  var showReference=isPv?showPvRef:showTsRef,showArea=isPv?showPvArea:showTsArea;
  var plots=data.map(function(d){return isPv?d.th:normalizeForTs(d.th);});
  var references=data.map(function(d){return isPv?d.reference:normalizeForTs(d.reference);});
  var all=plots.flatMap(function(plot){return plot.states;});
  if(showReference) all=all.concat(references.flatMap(function(plot){return plot.states;}));
  if(!compareMode[key]) compareMode[key]=computeAxisBounds(all,xKey,yKey,0.2);
  expandBounds(compareMode[key],all,xKey,yKey,0.15);
  var bounds=Object.assign({},compareMode[key]);if(!isPv&&showArea)bounds.yMin=0;
  var canvas=document.getElementById(kind+'Canvas'),setup=setupCanvas(canvas),ctx=setup.ctx;
  ctx.clearRect(0,0,setup.w,setup.h);
  var map=makeMapFromBounds(bounds,setup.w,setup.h);
  if(showArea) data.forEach(function(d){var area=getCycleAreaData(d.th);ctx.save();ctx.globalAlpha=0.45;drawAreaFill(ctx,map,area[kind],xKey,yKey,!isPv,area.externalTs);ctx.restore();});
  drawAxes(ctx,setup.w,setup.h,map,isPv?'v (m³/kg)':'s (kJ/(kg·K))',isPv?'p (kPa)':'T (K)',computeNiceTicks(bounds.xMin,bounds.xMax,6),computeNiceTicks(bounds.yMin,bounds.yMax,6));
  var draw=isPv?drawCycleOnPv:drawCycleOnTs;
  if(showReference) references.forEach(function(ref,i){draw(ctx,map,ref,'#94a3b8',1.5,i?[2,5]:[6,4]);});
  plots.forEach(function(plot,i){draw(ctx,map,plot,comparisonColors[i],2.5,i?[8,3]:[]);});
}
document.addEventListener('DOMContentLoaded',function() {
  document.getElementById('compareToggle').addEventListener('change',function(){setComparison(this.checked);});
  document.getElementById('comparePreset').addEventListener('click',applyComparisonPreset);
});
