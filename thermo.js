/* ============================================================
   CycleLab — thermo.js  (v2 — all fixes applied)
   ============================================================ */

// ── Constants (self-consistent: k = cp/cv, R = cp - cv) ──
const K = 1.4;
const CP = 1.005;
const CV = CP / K;          // 0.717857…
const R_GAS = CP - CV;      // 0.287143…

// ── Smart number formatter — kills floating-point noise ──
function smartFmt(v) {
  if (!isFinite(v)) return '0';
  if (v === 0) return '0';
  var r = parseFloat(v.toPrecision(6));
  return String(r);
}

// ── State ──
let currentCycle = 'otto';
let currentThermo = null;
let currentParams = {};

// ── Axis locking state ──
let pvLocked = null;   // {xMin, xMax, yMin, yMax}
let tsLocked = null;
let pvRefTh = null;    // reference thermo (default params)
let tsRefNorm = null;  // reference T-s normalized
let showPvRef = true;
let showTsRef = true;
let showPvArea = false;
let showTsArea = false;

// ── Parameter definitions ──
const PARAM_DEFS = {
  otto: [
    { key:'r',  label:'压缩比 r',         min:4,    max:14,   step:0.5, def:8    },
    { key:'T3', label:'最高温度 T\u2083 (K)', min:1200, max:2500, step:50,  def:1800 },
    { key:'T1', label:'初始温度 T\u2081 (K)', min:250,  max:350,  step:5,   def:300  },
    { key:'p1', label:'初始压力 p\u2081 (kPa)',min:50,   max:200,  step:5,   def:100  },
  ],
  diesel: [
    { key:'r',  label:'压缩比 r',         min:12,   max:24,   step:0.5, def:18   },
    { key:'rc', label:'截止比 rc',         min:1.2,  max:3.5,  step:0.1, def:2    },
    { key:'T1', label:'初始温度 T\u2081 (K)', min:250,  max:350,  step:5,   def:300  },
    { key:'p1', label:'初始压力 p\u2081 (kPa)',min:50,   max:200,  step:5,   def:100  },
  ],
  brayton: [
    { key:'pi', label:'增压比 \u03C0p',    min:4,    max:25,   step:0.5, def:10   },
    { key:'T3', label:'涡轮进口温度 T\u2083 (K)',min:1000,max:1800,step:50, def:1400 },
    { key:'T1', label:'初始温度 T\u2081 (K)',    min:250, max:350, step:5,  def:300  },
    { key:'p1', label:'初始压力 p\u2081 (kPa)',   min:50,  max:200, step:5,  def:100  },
    { key:'regen', label:'理想回热', min:0, max:1, step:1, def:0, checkbox:true },
    { key:'epsilon', label:'回热度 ε', min:0, max:1, step:0.05, def:0.8 },
  ],
};

// ── Helpers ──
function isentropicT(T1, ratio) { return T1 * Math.pow(ratio, K - 1); }
function isentropicP(p1, T1, T2) { return p1 * Math.pow(T2 / T1, K / (K - 1)); }

// ================================================================
//  CYCLE CALCULATIONS
// ================================================================
function calcOtto(p) {
  var r=p.r, T3=p.T3, T1=p.T1, p1=p.p1;
  var v1=R_GAS*T1/p1, T2=T1*Math.pow(r,K-1), p2=p1*Math.pow(r,K), v2=v1/r;
  var p3=p2*(T3/T2), v3=v2, T4=T3/Math.pow(r,K-1), p4=p3/Math.pow(r,K), v4=v1;
  var s1=0, s2=0, s3=CV*Math.log(T3/T2), s4=s3;
  var qIn=CV*(T3-T2), qOut=CV*(T4-T1), wNet=qIn-qOut, eta=wNet/qIn, etaC=1-T1/T3;
  return { states:[{p:p1,v:v1,T:T1,s:s1},{p:p2,v:v2,T:T2,s:s2},{p:p3,v:v3,T:T3,s:s3},{p:p4,v:v4,T:T4,s:s4}],
    qIn:qIn,qOut:qOut,wNet:wNet,eta:eta,etaC:etaC, processCurves:['isentropic','isochoric','isentropic','isochoric'] };
}
function calcDiesel(p) {
  var r=p.r, rc=p.rc, T1=p.T1, p1=p.p1;
  var v1=R_GAS*T1/p1, T2=T1*Math.pow(r,K-1), p2=p1*Math.pow(r,K), v2=v1/r;
  var T3=T2*rc, p3=p2, v3=v2*rc;
  var T4=T3*Math.pow(rc/r,K-1), v4=v1, p4=R_GAS*T4/v4;
  var s1=0, s2=0, s3=CP*Math.log(T3/T2), s4=s3;
  var qIn=CP*(T3-T2), qOut=CV*(T4-T1), wNet=qIn-qOut, eta=wNet/qIn, etaC=1-T1/T3;
  return { states:[{p:p1,v:v1,T:T1,s:s1},{p:p2,v:v2,T:T2,s:s2},{p:p3,v:v3,T:T3,s:s3},{p:p4,v:v4,T:T4,s:s4}],
    qIn:qIn,qOut:qOut,wNet:wNet,eta:eta,etaC:etaC, processCurves:['isentropic','isobaric','isentropic','isochoric'] };
}
function calcBrayton(p) {
  var pi=p.pi, T3=p.T3, T1=p.T1, p1=p.p1;
  var v1=R_GAS*T1/p1, T2=T1*Math.pow(pi,(K-1)/K), p2=p1*pi, v2=R_GAS*T2/p2;
  var p3=p2, v3=R_GAS*T3/p3, T4=T3/Math.pow(pi,(K-1)/K), p4=p1, v4=R_GAS*T4/p4;
  var s1=0, s2=0, s3=CP*Math.log(T3/T2), s4=s3;
  var qIn=CP*(T3-T2), qOut=CP*(T4-T1), wNet=qIn-qOut, eta=wNet/qIn, etaC=1-T1/T3;
  var result={ states:[{p:p1,v:v1,T:T1,s:s1},{p:p2,v:v2,T:T2,s:s2},{p:p3,v:v3,T:T3,s:s3},{p:p4,v:v4,T:T4,s:s4}],
    qIn:qIn,qOut:qOut,wNet:wNet,eta:eta,etaC:etaC, processCurves:['isentropic','isobaric','isentropic','isobaric'] };
  if(p.regen===1) {
    var epsilon=p.epsilon, feasible=T4>T2, recovered=feasible?epsilon*CP*(T4-T2):0;
    result.regeneration={epsilon:epsilon,feasible:feasible,q:recovered,etaWithout:eta,T5:T2+recovered/CP,T6:T4-recovered/CP};
    result.qIn=qIn-recovered;
    result.qOut=qOut-recovered;
    result.eta=wNet/result.qIn;
  }
  return result;
}
function calculate(cycle, params) {
  if (cycle==='otto') return calcOtto(params);
  if (cycle==='diesel') return calcDiesel(params);
  return calcBrayton(params);
}

function predictionDirection(before, after) {
  return Math.abs(after-before) < 1e-10 ? '不变' : after > before ? '升高' : '降低';
}

function getPredictionQuestions() {
  var scenarios = [
    {cycle:'otto', key:'r', steps:8, reason:'冷空气标准奥托循环的效率只取决于压缩比和比热比；压缩比提高，效率升高。'},
    {cycle:'diesel', key:'r', steps:4, reason:'固定截止比时，提高压缩比会提高冷空气标准狄塞尔循环的效率。'},
    {cycle:'diesel', key:'rc', steps:5, reason:'固定压缩比时，截止比增大，有效膨胀比减小，狄塞尔循环效率降低。'},
    {cycle:'brayton', key:'pi', steps:8, reason:'固定比热比的理想布雷顿循环，效率随增压比提高而升高。'},
    {cycle:'otto', key:'T1', steps:4, reason:'固定压缩比和比热比时，初温变化会改变热量与净功，但奥托循环效率不变。'},
    {cycle:'otto', compare:'diesel', reason:'相同压缩比和比热比下，截止比大于单位值的狄塞尔循环效率低于奥托循环；本题只比较效率，不要求吸热量相同。'},
    {cycle:'otto', key:'T3', steps:4, reason:'奥托循环效率由压缩比和比热比决定。提高最高温度使吸热量和净功增大，效率不变。'},
    {cycle:'brayton', key:'T3', steps:4, reason:'固定增压比和比热比时，理想布雷顿循环效率不随涡轮进口温度改变；提高该温度会使净功增大。'}
  ];
  var names={otto:'奥托循环',diesel:'狄塞尔循环',brayton:'布雷顿循环'};
  function value(th,key) {
    if(key==='r') return th.states[0].v/th.states[1].v;
    if(key==='rc') return th.states[2].v/th.states[1].v;
    if(key==='pi') return th.states[1].p/th.states[0].p;
    return th.states[key==='T1'?0:2].T;
  }
  return scenarios.map(function(s) {
    var beforeParams=getDefaultParams(s.cycle), afterCycle=s.compare||s.cycle;
    var afterParams=getDefaultParams(afterCycle);
    if(s.compare) {
      beforeParams.r=Math.max(PARAM_DEFS.otto[0].min,PARAM_DEFS.diesel[0].min);
      afterParams.r=beforeParams.r;
    } else {
      afterParams=Object.assign({},beforeParams);
      var def=PARAM_DEFS[s.cycle].find(function(d){return d.key===s.key;});
      afterParams[s.key]+=def.step*s.steps;
    }
    var before=calculate(s.cycle,beforeParams), after=calculate(afterCycle,afterParams);
    var prompt;
    if(s.compare) {
      prompt='压缩比同为 '+smartFmt(value(before,'r'))+'，狄塞尔截止比为 '+smartFmt(value(after,'rc'))+'。从奥托循环改为狄塞尔循环，热效率会？';
    } else {
      var label={r:'压缩比',rc:'截止比',pi:'增压比',T1:'初温',T3:s.cycle==='brayton'?'涡轮进口温度':'最高温度'}[s.key];
      var unit=s.key==='T1'||s.key==='T3'?' K':'';
      prompt=names[s.cycle]+'的'+label+'从 '+smartFmt(value(before,s.key))+unit+' 提高到 '+smartFmt(value(after,s.key))+unit+'，'+(s.cycle==='brayton'&&s.key==='T3'?'热效率和净功分别会怎样？':'热效率会？');
    }
    var direction=predictionDirection(before.eta,after.eta);
    var combined=s.cycle==='brayton'&&s.key==='T3';
    var answer=combined?'效率'+direction+'、净功'+(predictionDirection(before.wNet,after.wNet)==='升高'?'增大':'减小'):direction;
    var values=[
      {label:'变化前热效率',value:before.eta*100,unit:'%'},
      {label:'变化后热效率',value:after.eta*100,unit:'%'},
      {label:'变化前净功',value:before.wNet,unit:' kJ/kg'},
      {label:'变化后净功',value:after.wNet,unit:' kJ/kg'}
    ];
    return {prompt:prompt,answer:answer,choices:combined?['效率不变、净功增大','效率升高、净功增大','效率不变、净功减小']:['升高','降低','不变'],reason:s.reason,values:values,beforeCycle:s.cycle,afterCycle:afterCycle,beforeParams:beforeParams,afterParams:afterParams,before:before,after:after};
  });
}

// ================================================================
//  EFFICIENCY CURVES
// ================================================================
function etaOtto(r) { return 1-1/Math.pow(r,K-1); }
function etaBrayton(pi) { return 1-1/Math.pow(pi,(K-1)/K); }
function etaDiesel(r,rc) { return 1-(Math.pow(rc,K)-1)/(K*(rc-1)*Math.pow(r,K-1)); }
function getEffCurveData(cycle, params) {
  var pts=[];
  if (cycle==='otto') { for(var r=4;r<=14;r+=0.2) pts.push({x:r,y:etaOtto(r)}); }
  else if (cycle==='brayton') { for(var pi=4;pi<=25;pi+=0.3) pts.push({x:pi,y:calcBrayton(Object.assign({},params,{pi:pi})).eta}); }
  else { for(var r=12;r<=24;r+=0.2) pts.push({x:r,y:etaDiesel(r,params.rc)}); }
  return pts;
}
function getCurrentRatio(cycle,params) { return cycle==='brayton'?params.pi:params.r; }

// ================================================================
//  DERIVATION TEXT  (fixed formulas + smartFmt)
// ================================================================
function getDerivation(cycle, params, th) {
  if(cycle==='brayton'&&th.regeneration) {
    var regen=th.regeneration,base=calcBrayton(Object.assign({},params,{regen:0}));
    var recovery=[
      '理想回热（忽略压降，冷热侧质量流量与比热相同）：',
      regen.feasible?'T₄ > T₂，回热可行。':'此工况下回热不可行：T₄ ≤ T₂，回热量取零。',
      'ε = '+smartFmt(regen.epsilon),
      'q_reg = ε·cp·max(T₄ − T₂, 0) = '+regen.q.toFixed(2)+' kJ/kg',
      'T₅ = T₂ + q_reg/cp = '+regen.T5.toFixed(2)+' K（高压侧回热出口）',
      'T₆ = T₄ − q_reg/cp = '+regen.T6.toFixed(2)+' K（低压侧回热出口）',
      '外部 q_in = cp·(T₃ − T₅) = '+th.qIn.toFixed(2)+' kJ/kg',
      '外部 q_out = cp·(T₆ − T₁) = '+th.qOut.toFixed(2)+' kJ/kg',
      'w_net = '+th.wNet.toFixed(2)+' kJ/kg（与无回热相同）',
      'η = w_net / q_in = '+(th.eta*100).toFixed(2)+'%；无回热 η = '+(regen.etaWithout*100).toFixed(2)+'%'
    ];
    if(regen.epsilon===1&&regen.feasible)recovery.push('ε = 1：η = 1 − (T₁/T₃)·πp^((κ−1)/κ) = '+(th.eta*100).toFixed(2)+'%');
    return '无回热基准（以下基准热量含之后可回收的内部热量）：\n\n'+getDerivation(cycle,Object.assign({},params,{regen:0}),base)+'\n\n'+recovery.join('\n');
  }
  var s=th.states, lines=[];
  var km1=smartFmt(K-1), kk=smartFmt((K-1)/K), cvStr=smartFmt(CV), cpStr=smartFmt(CP), rStr=smartFmt(R_GAS);

  if (cycle==='otto') {
    lines.push('奥托循环推导过程：\n');
    lines.push('过程 1→2（等熵压缩）：');
    lines.push('  T\u2082 = T\u2081\u00B7r^(\u03BA\u22121) = '+params.T1+' \u00D7 '+params.r+'^'+km1+' = '+s[1].T.toFixed(2)+' K');
    lines.push('  p\u2082 = p\u2081\u00B7r^\u03BA = '+params.p1+' \u00D7 '+params.r+'^'+smartFmt(K)+' = '+s[1].p.toFixed(2)+' kPa');
    lines.push('  v\u2082 = v\u2081/r = '+s[0].v.toFixed(6)+' / '+params.r+' = '+s[1].v.toFixed(6)+' m\u00B3/kg');
    lines.push('');
    lines.push('过程 2→3（定容吸热）：');
    lines.push('  v\u2083 = v\u2082 = '+s[1].v.toFixed(6)+' m\u00B3/kg');
    lines.push('  p\u2083 = p\u2082\u00B7(T\u2083/T\u2082) = '+s[1].p.toFixed(2)+' \u00D7 ('+params.T3+'/'+s[1].T.toFixed(2)+') = '+s[2].p.toFixed(2)+' kPa');
    lines.push('  q_in = cv\u00B7(T\u2083\u2212T\u2082) = '+cvStr+' \u00D7 ('+params.T3+' \u2212 '+s[1].T.toFixed(2)+') = '+th.qIn.toFixed(2)+' kJ/kg');
    lines.push('');
    lines.push('过程 3→4（等熵膨胀）：');
    lines.push('  T\u2084 = T\u2083/r^(\u03BA\u22121) = '+params.T3+' / '+params.r+'^'+km1+' = '+s[3].T.toFixed(2)+' K');
    lines.push('  p\u2084 = p\u2083/r^\u03BA = '+s[2].p.toFixed(2)+' / '+params.r+'^'+smartFmt(K)+' = '+s[3].p.toFixed(2)+' kPa');
    lines.push('  v\u2084 = v\u2081 = '+s[0].v.toFixed(6)+' m\u00B3/kg');
    lines.push('');
    lines.push('过程 4→1（定容放热）：');
    lines.push('  q_out = cv\u00B7(T\u2084\u2212T\u2081) = '+cvStr+' \u00D7 ('+s[3].T.toFixed(2)+' \u2212 '+params.T1+') = '+th.qOut.toFixed(2)+' kJ/kg');
    lines.push('');
    lines.push('热效率：');
    lines.push('  \u03B7 = 1 \u2212 1/r^(\u03BA\u22121) = 1 \u2212 1/'+params.r+'^'+km1+' = '+(th.eta*100).toFixed(2)+'%');
    lines.push('  w_net = q_in \u2212 q_out = '+th.qIn.toFixed(2)+' \u2212 '+th.qOut.toFixed(2)+' = '+th.wNet.toFixed(2)+' kJ/kg');
    lines.push('  卡诺效率 \u03B7_C = 1 \u2212 T\u2081/T\u2083 = 1 \u2212 '+params.T1+'/'+params.T3+' = '+(th.etaC*100).toFixed(2)+'%');
  } else if (cycle==='diesel') {
    lines.push('狄塞尔循环推导过程：\n');
    lines.push('过程 1→2（等熵压缩）：');
    lines.push('  T\u2082 = T\u2081\u00B7r^(\u03BA\u22121) = '+params.T1+' \u00D7 '+params.r+'^'+km1+' = '+s[1].T.toFixed(2)+' K');
    lines.push('  p\u2082 = p\u2081\u00B7r^\u03BA = '+params.p1+' \u00D7 '+params.r+'^'+smartFmt(K)+' = '+s[1].p.toFixed(2)+' kPa');
    lines.push('  v\u2082 = v\u2081/r = '+s[0].v.toFixed(6)+' / '+params.r+' = '+s[1].v.toFixed(6)+' m\u00B3/kg');
    lines.push('');
    lines.push('过程 2→3（定压吸热）：');
    lines.push('  p\u2083 = p\u2082 = '+s[1].p.toFixed(2)+' kPa');
    lines.push('  T\u2083 = T\u2082\u00B7rc = '+s[1].T.toFixed(2)+' \u00D7 '+params.rc+' = '+s[2].T.toFixed(2)+' K');
    lines.push('  v\u2083 = v\u2082\u00B7rc = '+s[1].v.toFixed(6)+' \u00D7 '+params.rc+' = '+s[2].v.toFixed(6)+' m\u00B3/kg');
    lines.push('  q_in = cp\u00B7(T\u2083\u2212T\u2082) = '+cpStr+' \u00D7 ('+s[2].T.toFixed(2)+' \u2212 '+s[1].T.toFixed(2)+') = '+th.qIn.toFixed(2)+' kJ/kg');
    lines.push('');
    lines.push('过程 3→4（等熵膨胀）：');
    lines.push('  T\u2084 = T\u2083\u00B7(v\u2083/v\u2084)^(\u03BA\u22121) = '+s[2].T.toFixed(2)+' \u00D7 ('+s[2].v.toFixed(6)+'/'+s[3].v.toFixed(6)+')^'+km1+' = '+s[3].T.toFixed(2)+' K');
    lines.push('  p\u2084 = R\u00B7T\u2084/v\u2084 = '+rStr+' \u00D7 '+s[3].T.toFixed(2)+' / '+s[3].v.toFixed(6)+' = '+s[3].p.toFixed(2)+' kPa');
    lines.push('');
    lines.push('过程 4→1（定容放热）：');
    lines.push('  q_out = cv\u00B7(T\u2084\u2212T\u2081) = '+cvStr+' \u00D7 ('+s[3].T.toFixed(2)+' \u2212 '+params.T1+') = '+th.qOut.toFixed(2)+' kJ/kg');
    lines.push('');
    lines.push('热效率：');
    lines.push('  \u03B7 = 1 \u2212 (rc^\u03BA\u22121) / [\u03BA\u00B7(rc\u22121)\u00B7r^(\u03BA\u22121)]');
    lines.push('    = 1 \u2212 ('+params.rc+'^'+smartFmt(K)+'\u22121) / ('+smartFmt(K)+' \u00D7 '+(params.rc-1)+' \u00D7 '+params.r+'^'+km1+')');
    lines.push('    = '+(th.eta*100).toFixed(2)+'%');
    lines.push('  w_net = q_in \u2212 q_out = '+th.qIn.toFixed(2)+' \u2212 '+th.qOut.toFixed(2)+' = '+th.wNet.toFixed(2)+' kJ/kg');
    lines.push('  卡诺效率 \u03B7_C = 1 \u2212 T\u2081/T\u2083 = 1 \u2212 '+params.T1+'/'+s[2].T.toFixed(2)+' = '+(th.etaC*100).toFixed(2)+'%');
  } else {
    lines.push('布雷顿循环推导过程：\n');
    lines.push('过程 1→2（等熵压缩）：');
    lines.push('  T\u2082 = T\u2081\u00B7\u03C0p^((\u03BA\u22121)/\u03BA) = '+params.T1+' \u00D7 '+params.pi+'^'+kk+' = '+s[1].T.toFixed(2)+' K');
    lines.push('  p\u2082 = p\u2081\u00B7\u03C0p = '+params.p1+' \u00D7 '+params.pi+' = '+s[1].p.toFixed(2)+' kPa');
    lines.push('  v\u2082 = R\u00B7T\u2082/p\u2082 = '+rStr+' \u00D7 '+s[1].T.toFixed(2)+' / '+s[1].p.toFixed(2)+' = '+s[1].v.toFixed(6)+' m\u00B3/kg');
    lines.push('');
    lines.push('过程 2→3（定压吸热）：');
    lines.push('  p\u2083 = p\u2082 = '+s[1].p.toFixed(2)+' kPa');
    lines.push('  v\u2083 = R\u00B7T\u2083/p\u2083 = '+rStr+' \u00D7 '+params.T3+' / '+s[1].p.toFixed(2)+' = '+s[2].v.toFixed(6)+' m\u00B3/kg');
    lines.push('  q_in = cp\u00B7(T\u2083\u2212T\u2082) = '+cpStr+' \u00D7 ('+params.T3+' \u2212 '+s[1].T.toFixed(2)+') = '+th.qIn.toFixed(2)+' kJ/kg');
    lines.push('');
    lines.push('过程 3→4（等熵膨胀）：');
    lines.push('  T\u2084 = T\u2083/\u03C0p^((\u03BA\u22121)/\u03BA) = '+params.T3+' / '+params.pi+'^'+kk+' = '+s[3].T.toFixed(2)+' K');
    lines.push('  p\u2084 = p\u2081 = '+params.p1+' kPa');
    lines.push('  v\u2084 = R\u00B7T\u2084/p\u2084 = '+rStr+' \u00D7 '+s[3].T.toFixed(2)+' / '+params.p1+' = '+s[3].v.toFixed(6)+' m\u00B3/kg');
    lines.push('');
    lines.push('过程 4→1（定压放热）：');
    lines.push('  q_out = cp\u00B7(T\u2084\u2212T\u2081) = '+cpStr+' \u00D7 ('+s[3].T.toFixed(2)+' \u2212 '+params.T1+') = '+th.qOut.toFixed(2)+' kJ/kg');
    lines.push('');
    lines.push('热效率：');
    lines.push('  \u03B7 = 1 \u2212 1/\u03C0p^((\u03BA\u22121)/\u03BA) = 1 \u2212 1/'+params.pi+'^'+kk+' = '+(th.eta*100).toFixed(2)+'%');
    lines.push('  w_net = q_in \u2212 q_out = '+th.qIn.toFixed(2)+' \u2212 '+th.qOut.toFixed(2)+' = '+th.wNet.toFixed(2)+' kJ/kg');
    lines.push('  卡诺效率 \u03B7_C = 1 \u2212 T\u2081/T\u2083 = 1 \u2212 '+params.T1+'/'+params.T3+' = '+(th.etaC*100).toFixed(2)+'%');
  }
  return lines.join('\n');
}

// ================================================================
//  T-s NORMALIZATION  (cold-air closure fix)
// ================================================================
function normalizeForTs(th) {
  var s3raw=th.states[3].s, lastType=th.processCurves[3], ds41;
  if (lastType==='isochoric') ds41=CV*Math.log(th.states[0].T/th.states[3].T);
  else ds41=CP*Math.log(th.states[0].T/th.states[3].T)-R_GAS*Math.log(th.states[0].p/th.states[3].p);
  var gap=s3raw+ds41;
  var shift=function(i){return i>=3?-gap:0;};
  var normStates=th.states.map(function(s,i){return Object.assign({},s,{s:s.s+shift(i)});});
  var normCurves=th.processCurves.map(function(type,idx){
    var fi=idx, ti=(idx+1)%4;
    var st=Object.assign({},th.states[fi],{s:th.states[fi].s+shift(fi)});
    var en=Object.assign({},th.states[ti],{s:th.states[ti].s+shift(ti)});
    return sampleProcessTs(type,st,en);
  });
  var norm={states:normStates,curves:normCurves};
  if(th.regeneration&&th.regeneration.q>0) {
    var regen=th.regeneration;
    var cold=Object.assign({},normStates[1],{T:regen.T5,v:R_GAS*regen.T5/normStates[1].p,s:normStates[1].s+CP*Math.log(regen.T5/normStates[1].T)});
    var hot=Object.assign({},normStates[3],{T:regen.T6,v:R_GAS*regen.T6/normStates[3].p,s:normStates[3].s+CP*Math.log(regen.T6/normStates[3].T)});
    norm.regeneration={states:[cold,hot],curves:[sampleProcessTs('isobaric',normStates[1],cold,400),sampleProcessTs('isobaric',normStates[3],hot,400)]};
    norm.externalCurves=normCurves.slice();
    norm.externalCurves[1]=sampleProcessTs('isobaric',cold,normStates[2],400);
    norm.externalCurves[3]=sampleProcessTs('isobaric',hot,normStates[0],400);
  }
  return norm;
}

// ================================================================
//  CANVAS UTILITIES
// ================================================================
function setupCanvas(canvas) {
  var rect=canvas.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  var ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  return {ctx:ctx, w:rect.width, h:rect.height};
}

// ── Nice ticks starting from >= 0 ──
function niceNum(range, round) {
  if (range<=0) return 1;
  var exp=Math.floor(Math.log10(range));
  var frac=range/Math.pow(10,exp), nice;
  if (round) { nice=frac<1.5?1:frac<3?2:frac<7?5:10; }
  else { nice=frac<=1?1:frac<=2?2:frac<=5?5:10; }
  return nice*Math.pow(10,exp);
}
function computeNiceTicks(dMin, dMax, nTicks) {
  nTicks=nTicks||5;
  if (dMax-dMin<1e-12) { dMin-=1; dMax+=1; }
  var lo=Math.min(0,dMin);
  var range=niceNum(dMax-lo,false);
  var step=niceNum(range/(nTicks-1),true);
  var graphMin=Math.floor(lo/step)*step;
  var graphMax=Math.ceil(dMax/step)*step;
  if (graphMin<0 && lo>=0) graphMin=0;
  var ticks=[];
  for (var v=graphMin; v<=graphMax+step*0.01; v+=step) ticks.push(parseFloat(v.toPrecision(10)));
  return {min:graphMin, max:graphMax, step:step, ticks:ticks};
}

// ── Format tick value — no scientific notation ──
function fmtTick(v) {
  if (Math.abs(v)<1e-12) return '0';
  if (Math.abs(v)>=1000) return Math.round(v).toString();
  if (Math.abs(v)>=1) return parseFloat(v.toPrecision(4)).toString();
  return parseFloat(v.toPrecision(3)).toString();
}

function drawAxes(ctx, w, h, map, xLabel, yLabel, xTicks, yTicks) {
  var left=60, top=25, pw=map.pw, ph=map.ph;
  // axes
  ctx.strokeStyle='#94a3b8'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(left,top); ctx.lineTo(left,top+ph); ctx.lineTo(left+pw,top+ph); ctx.stroke();
  // labels
  ctx.fillStyle='#64748b'; ctx.font='12px sans-serif'; ctx.textAlign='center';
  ctx.fillText(xLabel, left+pw/2, h-5);
  ctx.save(); ctx.translate(13, top+ph/2); ctx.rotate(-Math.PI/2);
  ctx.fillText(yLabel, 0, 0); ctx.restore();
  // x ticks
  ctx.font='10px sans-serif';
  xTicks.ticks.forEach(function(xv) {
    var px=map.x(xv);
    if (px<left-1||px>left+pw+1) return;
    ctx.strokeStyle='#e2e8f0'; ctx.lineWidth=0.5;
    ctx.beginPath();ctx.moveTo(px,top);ctx.lineTo(px,top+ph);ctx.stroke();
    ctx.fillStyle='#64748b'; ctx.textAlign='center';
    ctx.fillText(fmtTick(xv), px, top+ph+14);
  });
  // y ticks
  yTicks.ticks.forEach(function(yv) {
    var py=map.y(yv);
    if (py<top-1||py>top+ph+1) return;
    ctx.strokeStyle='#e2e8f0'; ctx.lineWidth=0.5;
    ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(left+pw,py);ctx.stroke();
    ctx.fillStyle='#64748b'; ctx.textAlign='right';
    ctx.fillText(fmtTick(yv), left-5, py+3);
  });
}

// ── Arrow helper ──
function drawArrow(ctx, x, y, angle, color) {
  var sz=9;
  ctx.save(); ctx.translate(x,y); ctx.rotate(angle);
  ctx.fillStyle=color;
  ctx.beginPath(); ctx.moveTo(sz,0); ctx.lineTo(-sz*0.6,-sz*0.5); ctx.lineTo(-sz*0.6,sz*0.5); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ================================================================
//  PROCESS CURVE SAMPLING
// ================================================================
function sampleProcess(type, st, en, n) {
  n=n||50; var pts=[];
  if (type==='isentropic') {
    var c=st.p*Math.pow(st.v,K);
    for(var i=0;i<=n;i++){var v=st.v+(i/n)*(en.v-st.v); pts.push({v:v,p:c/Math.pow(v,K)});}
  } else if (type==='isochoric') {
    for(var i=0;i<=n;i++){var T=st.T+(i/n)*(en.T-st.T); pts.push({v:st.v,p:R_GAS*T/st.v});}
  } else if (type==='isobaric') {
    for(var i=0;i<=n;i++){var T=st.T+(i/n)*(en.T-st.T); pts.push({v:R_GAS*T/st.p,p:st.p});}
  }
  return pts;
}
function sampleProcessTs(type, st, en, n) {
  n=n||50; var pts=[];
  if (type==='isentropic') {
    for(var i=0;i<=n;i++) pts.push({s:st.s, T:st.T+(i/n)*(en.T-st.T)});
  } else if (type==='isochoric') {
    for(var i=0;i<=n;i++){var T=st.T+(i/n)*(en.T-st.T); pts.push({s:st.s+CV*Math.log(T/st.T), T:T});}
  } else if (type==='isobaric') {
    for(var i=0;i<=n;i++){var T=st.T+(i/n)*(en.T-st.T); pts.push({s:st.s+CP*Math.log(T/st.T), T:T});}
  }
  return pts;
}

// ================================================================
//  AXIS LOCKING
// ================================================================
function computeAxisBounds(states, xKey, yKey, padFrac) {
  var xs=states.map(function(s){return s[xKey];}), ys=states.map(function(s){return s[yKey];});
  var xMin=Math.min.apply(null,xs), xMax=Math.max.apply(null,xs);
  var yMin=Math.min.apply(null,ys), yMax=Math.max.apply(null,ys);
  var xPad=(xMax-xMin)*padFrac||xMax*0.1||0.1;
  var yPad=(yMax-yMin)*padFrac||yMax*0.1||0.1;
  return {xMin:Math.min(0,xMin-xPad), xMax:xMax+xPad, yMin:Math.min(0,yMin-yPad), yMax:yMax+yPad};
}
function expandBounds(b, states, xKey, yKey, padFrac) {
  var xs=states.map(function(s){return s[xKey];}), ys=states.map(function(s){return s[yKey];});
  var dMin=Math.min.apply(null,xs), dMax=Math.max.apply(null,xs);
  var xPad=(dMax-dMin)*padFrac||dMax*0.1||0.1;
  b.xMin=Math.min(b.xMin, Math.min(0,dMin-xPad));
  b.xMax=Math.max(b.xMax, dMax+xPad);
  var tMin=Math.min.apply(null,ys), tMax=Math.max.apply(null,ys);
  var yPad=(tMax-tMin)*padFrac||tMax*0.1||0.1;
  b.yMin=Math.min(b.yMin, Math.min(0,tMin-yPad));
  b.yMax=Math.max(b.yMax, tMax+yPad);
}
function makeMapFromBounds(bounds, w, h) {
  var left=60, top=25, pw=w-75, ph=h-55;
  return {
    x: function(v){return left+((v-bounds.xMin)/(bounds.xMax-bounds.xMin))*pw;},
    y: function(v){return top+ph-((v-bounds.yMin)/(bounds.yMax-bounds.yMin))*ph;},
    pw:pw, ph:ph, left:left, top:top
  };
}

// ================================================================
//  DRAW PV DIAGRAM
// ================================================================
function getCycleAreaData(th) {
  var norm = normalizeForTs(th);
  return {
    pv: th.processCurves.map(function(type, i) { return sampleProcess(type, th.states[i], th.states[(i+1)%4], 400); }),
    externalTs: norm.externalCurves,
    ts: th.processCurves.map(function(type, i) { return sampleProcessTs(type, norm.states[i], norm.states[(i+1)%4], 400); })
  };
}

function integrateCurve(points, xKey, yKey) {
  var sum = 0;
  for (var i = 1; i < points.length; i++) {
    sum += (points[i][xKey] - points[i-1][xKey]) * (points[i][yKey] + points[i-1][yKey]) / 2;
  }
  return sum;
}

function traceAreaPath(ctx, map, points, xKey, yKey) {
  ctx.beginPath();
  points.forEach(function(point, i) {
    var x = map.x(point[xKey]), y = map.y(point[yKey]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

function drawAreaFill(ctx, map, curves, xKey, yKey, heat, externalCurves) {
  ctx.save();
  ctx.beginPath(); ctx.rect(map.left, map.top, map.pw, map.ph); ctx.clip();
  if (heat) {
    [1, 3].forEach(function(index) {
      var points = (externalCurves||curves)[index];
      traceAreaPath(ctx, map, [{s:points[0].s,T:0}].concat(points, [{s:points[points.length-1].s,T:0}]), 's', 'T');
      ctx.fillStyle = index === 1 ? '#fee2e2' : '#dbeafe'; ctx.fill();
    });
  }
  traceAreaPath(ctx, map, curves.flat(), xKey, yKey);
  if (!heat) { ctx.fillStyle = '#ede9fe'; ctx.fill(); }
  ctx.save(); ctx.clip(); ctx.strokeStyle = 'rgba(109,40,217,0.35)'; ctx.lineWidth = 1;
  for (var x = map.left - map.ph; x < map.left + map.pw; x += 9) {
    ctx.beginPath(); ctx.moveTo(x, map.top + map.ph); ctx.lineTo(x + map.ph, map.top); ctx.stroke();
  }
  ctx.restore(); ctx.restore();
}

function isComparisonActive() {
  return typeof compareMode !== 'undefined' && compareMode.enabled && !compareMode.suspended;
}

function updateAreaExplanation(regenerated) {
  document.getElementById('areaExplanation').textContent=regenerated?'回热时，浅红和浅蓝仅表示外部吸热与放热；内部回热量相互抵消。完整循环围成的斜线面积仍等于净功。':'T-s 图上过程线下方的面积等于该过程的热量；循环围成的面积等于净功。浅红为吸热面积（包含浅蓝的放热面积），斜线为净功。';
}

function updateAreaLabels(th) {
  if (isComparisonActive()) { updateComparisonAreaLabels(); return; }
  var pv = document.getElementById('pvAreaValues'), ts = document.getElementById('tsAreaValues');
  updateAreaExplanation(th.regeneration&&th.regeneration.q>0);
  pv.hidden = !showPvArea; ts.hidden = !showTsArea;
  pv.textContent = '斜线面积：w_net = ' + th.wNet.toFixed(2) + ' kJ/kg';
  ts.innerHTML = '<span class="heat-in">q_in = ' + th.qIn.toFixed(2) + ' kJ/kg</span>' +
    '<span class="heat-out">q_out = ' + th.qOut.toFixed(2) + ' kJ/kg</span>' +
    '<span class="net-work">斜线 w_net = ' + th.wNet.toFixed(2) + ' kJ/kg</span>';
  document.getElementById('areaExplanation').hidden = !showPvArea && !showTsArea;
}

function drawPvDiagram(th) {
  if (isComparisonActive()) { drawComparisonDiagram('pv'); return; }
  var canvas=document.getElementById('pvCanvas');
  var ctx_w=setupCanvas(canvas), ctx=ctx_w.ctx, w=ctx_w.w, h=ctx_w.h;
  ctx.clearRect(0,0,w,h);
  if (!pvLocked) return;
  expandBounds(pvLocked, th.states, 'v', 'p', 0.15);
  var map=makeMapFromBounds(pvLocked, w, h);
  var xT=computeNiceTicks(pvLocked.xMin, pvLocked.xMax, 6);
  var yT=computeNiceTicks(pvLocked.yMin, pvLocked.yMax, 6);
  if (showPvArea) drawAreaFill(ctx, map, getCycleAreaData(th).pv, 'v', 'p', false);
  drawAxes(ctx, w, h, map, 'v (m\u00B3/kg)', 'p (kPa)', xT, yT);

  // reference curve (gray dashed)
  if (showPvRef && pvRefTh) {
    drawCycleOnPv(ctx, map, pvRefTh, '#cbd5e1', 1.5, [6,4]);
  }
  // current cycle
  drawCycleOnPv(ctx, map, th, null, 2.5, []);
  // state points
  drawStatePointsPv(ctx, map, th);
}

function drawCycleOnPv(ctx, map, th, overrideColor, lineWidth, dash) {
  var colors=['#ef4444','#3b82f6','#f59e0b','#8b5cf6'];
  var procs=[[0,1],[1,2],[2,3],[3,0]];
  procs.forEach(function(pair,idx){
    var fi=pair[0], ti=pair[1];
    var type=th.processCurves[idx];
    var pts=sampleProcess(type, th.states[fi], th.states[ti]);
    ctx.strokeStyle=overrideColor||colors[idx];
    ctx.lineWidth=lineWidth;
    ctx.setLineDash(dash||[]);
    ctx.beginPath();
    pts.forEach(function(pt,i){var px=map.x(pt.v),py=map.y(pt.p);i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);});
    ctx.stroke();
    ctx.setLineDash([]);
    // arrow (only for current cycle)
    if (!overrideColor) {
      var mi=Math.floor(pts.length/2);
      if(mi>0&&mi<pts.length-1){
        var dx=map.x(pts[mi+1].v)-map.x(pts[mi-1].v);
        var dy=map.y(pts[mi+1].p)-map.y(pts[mi-1].p);
        drawArrow(ctx,map.x(pts[mi].v),map.y(pts[mi].p),Math.atan2(dy,dx),colors[idx]);
      }
    }
  });
}
function drawStatePointsPv(ctx, map, th) {
  th.states.forEach(function(st,i){
    var px=map.x(st.v), py=map.y(st.p);
    ctx.fillStyle='#1e293b'; ctx.beginPath(); ctx.arc(px,py,5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(px,py,2.5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#1e293b'; ctx.font='bold 13px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillText(''+(i+1), px+8, py-8);
  });
}

// ================================================================
//  DRAW TS DIAGRAM
// ================================================================
function drawTsDiagram(th) {
  if (isComparisonActive()) { drawComparisonDiagram('ts'); return; }
  var canvas=document.getElementById('tsCanvas');
  var ctx_w=setupCanvas(canvas), ctx=ctx_w.ctx, w=ctx_w.w, h=ctx_w.h;
  ctx.clearRect(0,0,w,h);
  if (!tsLocked) return;
  var norm=normalizeForTs(th);
  // expand bounds
  expandBounds(tsLocked, norm.states, 's', 'T', 0.15);
  var displayBounds = showTsArea ? Object.assign({}, tsLocked, {yMin:0}) : tsLocked;
  var map=makeMapFromBounds(displayBounds, w, h);
  var xT=computeNiceTicks(displayBounds.xMin, displayBounds.xMax, 6);
  var yT=computeNiceTicks(displayBounds.yMin, displayBounds.yMax, 6);
  if (showTsArea) {var area=getCycleAreaData(th);drawAreaFill(ctx, map, area.ts, 's', 'T', true, area.externalTs);}
  drawAxes(ctx, w, h, map, 's (kJ/(kg\u00B7K))', 'T (K)', xT, yT);

  // reference curve
  if (showTsRef && tsRefNorm) {
    drawCycleOnTs(ctx, map, tsRefNorm, '#cbd5e1', 1.5, [6,4]);
  }
  // current cycle
  drawCycleOnTs(ctx, map, norm, null, 2.5, []);
  // state points
  drawStatePointsTs(ctx, map, norm);
}
function drawCycleOnTs(ctx, map, norm, overrideColor, lineWidth, dash) {
  var colors=['#ef4444','#3b82f6','#f59e0b','#8b5cf6'];
  norm.curves.forEach(function(pts,idx){
    ctx.strokeStyle=overrideColor||colors[idx];
    ctx.lineWidth=lineWidth;
    ctx.setLineDash(dash||[]);
    ctx.beginPath();
    pts.forEach(function(pt,i){var px=map.x(pt.s),py=map.y(pt.T);i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);});
    ctx.stroke();
    ctx.setLineDash([]);
    if (!overrideColor) {
      var mi=Math.floor(pts.length/2);
      if(mi>0&&mi<pts.length-1){
        var dx=map.x(pts[mi+1].s)-map.x(pts[mi-1].s);
        var dy=map.y(pts[mi+1].T)-map.y(pts[mi-1].T);
        drawArrow(ctx,map.x(pts[mi].s),map.y(pts[mi].T),Math.atan2(dy,dx),colors[idx]);
      }
    }
  });
  if(norm.regeneration) {
    ctx.save();ctx.strokeStyle=overrideColor||'#059669';ctx.lineWidth=lineWidth+1;ctx.setLineDash([3,2]);
    norm.regeneration.curves.forEach(function(points) {
      ctx.beginPath();points.forEach(function(pt,i){i?ctx.lineTo(map.x(pt.s),map.y(pt.T)):ctx.moveTo(map.x(pt.s),map.y(pt.T));});ctx.stroke();
    });
    ctx.fillStyle=overrideColor||'#047857';ctx.font='bold 12px sans-serif';ctx.textAlign='left';
    norm.regeneration.states.forEach(function(st,i){ctx.fillText(String(i+5),map.x(st.s)+6,map.y(st.T)-8);});
    ctx.restore();
  }
}
function drawStatePointsTs(ctx, map, norm) {
  norm.states.forEach(function(st,i){
    var px=map.x(st.s), py=map.y(st.T);
    ctx.fillStyle='#1e293b'; ctx.beginPath(); ctx.arc(px,py,5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(px,py,2.5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#1e293b'; ctx.font='bold 13px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillText(''+(i+1), px+8, py-8);
  });
}

// ── HTML Legend ──
function getProcessLabels(cycle) {
  if (cycle==='otto') return ['1\u21922 \u7B49\u71B5\u538B\u7F29','2\u21923 \u5B9A\u5BB9\u5438\u70ED','3\u21924 \u7B49\u71B5\u81A8\u80C0','4\u21921 \u5B9A\u5BB9\u653E\u70ED'];
  if (cycle==='diesel') return ['1\u21922 \u7B49\u71B5\u538B\u7F29','2\u21923 \u5B9A\u538B\u5438\u70ED','3\u21924 \u7B49\u71B5\u81A8\u80C0','4\u21921 \u5B9A\u5BB9\u653E\u70ED'];
  return ['1\u21922 \u7B49\u71B5\u538B\u7F29','2\u21923 \u5B9A\u538B\u5438\u70ED','3\u21924 \u7B49\u71B5\u81A8\u80C0','4\u21921 \u5B9A\u538B\u653E\u70ED'];
}
function buildLegend() {
  if (isComparisonActive()) { buildComparisonLegend(); return; }
  var colors=['#ef4444','#3b82f6','#f59e0b','#8b5cf6'];
  var labels=getProcessLabels(currentCycle);
  var regenerated=currentThermo.regeneration&&currentThermo.regeneration.q>0;
  if(regenerated) {labels[1]='2→5 内部回热，5→3 外部吸热';labels[3]='4→6 内部回热，6→1 外部放热';}
  var html='';
  labels.forEach(function(label,i){
    html+='<div class="legend-item"><span class="legend-swatch" style="background:'+colors[i]+'"></span>'+label+'</div>';
  });
  document.getElementById('pvLegend').innerHTML=html;
  document.getElementById('tsLegend').innerHTML=html+(regenerated?'<div class="legend-item regeneration-legend">绿色短虚线：2→5 与 4→6 内部回热</div>':'');
}

// ================================================================
//  DRAW EFFICIENCY CURVE  (keeps auto-scaling)
// ================================================================
function drawEffChart(cycle, params, th) {
  var canvas=document.getElementById('effCanvas');
  var ctx_w=setupCanvas(canvas), ctx=ctx_w.ctx, w=ctx_w.w, h=ctx_w.h;
  ctx.clearRect(0,0,w,h);
  var data=getEffCurveData(cycle, params);
  var xs=data.map(function(d){return d.x;}), ys=data.map(function(d){return d.y*100;});
  var xT=computeNiceTicks(Math.min.apply(null,xs), Math.max.apply(null,xs), 6);
  var yT=computeNiceTicks(0, Math.max.apply(null,ys), 6);
  var left=60, top=25, pw=w-75, ph=h-55;
  var map={
    x:function(v){return left+((v-xT.min)/(xT.max-xT.min))*pw;},
    y:function(v){return top+ph-((v-yT.min)/(yT.max-yT.min))*ph;},
    pw:pw,ph:ph
  };
  drawAxes(ctx,w,h,map, cycle==='brayton'?'\u589E\u538B\u6BD4 \u03C0p':'\u538B\u7F29\u6BD4 r', '\u03B7 (%)', xT, yT);
  ctx.strokeStyle='#2563eb'; ctx.lineWidth=2; ctx.setLineDash([]);
  ctx.beginPath();
  data.forEach(function(d,i){var px=map.x(d.x),py=map.y(d.y*100);i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);});
  ctx.stroke();
  var cx=getCurrentRatio(cycle,params), cy=th.eta*100;
  var cpx=map.x(cx), cpy=map.y(cy);
  ctx.setLineDash([4,4]); ctx.strokeStyle='#94a3b8'; ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(cpx,top+ph);ctx.lineTo(cpx,cpy);ctx.stroke();
  ctx.beginPath();ctx.moveTo(left,cpy);ctx.lineTo(cpx,cpy);ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='#ef4444'; ctx.beginPath(); ctx.arc(cpx,cpy,6,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(cpx,cpy,3,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#ef4444'; ctx.font='bold 12px sans-serif'; ctx.textAlign='left';
  ctx.fillText(cy.toFixed(2)+'%', cpx+10, cpy-4);
}

// ================================================================
//  UI: PARAMETER PANEL
// ================================================================
function getDefaultParams(cycle) {
  var p={}; PARAM_DEFS[cycle].forEach(function(d){p[d.key]=d.def;}); return p;
}

var restoringShareURL=true;

function sharedValue(query,key) {
  var values=query.getAll(key);
  return values.length===1?values[0]:null;
}
function readSharedParams(query,cycle,prefix,comparison) {
  var params=getDefaultParams(cycle);
  PARAM_DEFS[cycle].forEach(function(def) {
    var raw=sharedValue(query,prefix+def.key);
    var max=comparison&&cycle==='otto'&&def.key==='r'?24:def.max;
    if(raw===null||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(raw)) return;
    var value=Number(raw);
    if(Number.isFinite(value)&&value>=def.min&&value<=max&&(!def.checkbox||value===0||value===1)) params[def.key]=value;
  });
  return params;
}
function readSharedCondition(search) {
  var query=new URLSearchParams(search);
  var rawCycle=sharedValue(query,'cycle');
  var validCycle=Object.prototype.hasOwnProperty.call(PARAM_DEFS,rawCycle);
  var cycle=validCycle?rawCycle:'otto';
  var state={cycle:cycle,params:readSharedParams(validCycle||!query.has('cycle')?query:new URLSearchParams(),cycle,'',false),comparison:null};
  if(sharedValue(query,'compare')==='1') {
    var cycles=[sharedValue(query,'cycle0'),sharedValue(query,'cycle1')];
    var valid=cycles.map(function(c){return Object.prototype.hasOwnProperty.call(PARAM_DEFS,c);});
    cycles[0]=valid[0]?cycles[0]:'otto';
    cycles[1]=valid[1]?cycles[1]:'diesel';
    if(cycles[0]===cycles[1]) {cycles[1]=cycles[0]==='otto'?'diesel':'otto';valid[1]=false;}
    state.comparison={cycles:cycles,params:cycles.map(function(c,i){return readSharedParams(valid[i]?query:new URLSearchParams(),c,'c'+i+'_',true);})};
  }
  return state;
}
function sharedCondition() {
  var state={cycle:currentCycle,params:currentParams,comparison:null};
  if(isComparisonActive()) state.comparison={cycles:compareMode.cycles,params:compareMode.params};
  return state;
}
function createShareQuery(state) {
  var query=new URLSearchParams();
  query.set('cycle',state.cycle);
  PARAM_DEFS[state.cycle].forEach(function(def){query.set(def.key,String(state.params[def.key]));});
  if(state.comparison) {
    query.set('compare','1');
    state.comparison.cycles.forEach(function(cycle,i) {
      query.set('cycle'+i,cycle);
      PARAM_DEFS[cycle].forEach(function(def){query.set('c'+i+'_'+def.key,String(state.comparison.params[i][def.key]));});
    });
  }
  return query.toString();
}
function syncShareURL() {
  if(restoringShareURL||typeof location==='undefined'||typeof history==='undefined') return;
  var search='?'+createShareQuery(sharedCondition());
  if(location.search!==search) {
    history.replaceState(null,'',location.pathname+search+location.hash);
    document.getElementById('shareStatus').textContent='';
    document.getElementById('shareLink').hidden=true;
  }
}
function restoreSharedCondition() {
  var state=readSharedCondition(location.search);
  restoringShareURL=true;
  try {
    if(!document.getElementById('quizBody').hidden) document.getElementById('quizExit').click();
    if(compareMode.enabled) setComparison(false);
    switchCycle(state.cycle);
    currentParams=state.params;
    PARAM_DEFS[currentCycle].forEach(function(def,i) {
      document.querySelectorAll('#params .param-group')[i].querySelectorAll('input').forEach(function(input){input.value=currentParams[def.key];});
    });
    if(state.comparison) {
      compareMode.cycles=state.comparison.cycles;
      compareMode.params=state.comparison.params;
      setComparison(true);
    } else refresh();
  } finally {
    restoringShareURL=false;
  }
  syncShareURL();
}
async function copyConditionLink() {
  syncShareURL();
  var link=location.href;
  var status=document.getElementById('shareStatus');
  try {
    await navigator.clipboard.writeText(link);
    status.textContent='链接已复制';
  } catch {
    var input=document.getElementById('shareLink');
    input.value=link;input.hidden=false;input.focus();input.select();
    status.textContent='自动复制受限，请复制下方链接';
  }
}

function buildParams() {
  var defs=PARAM_DEFS[currentCycle], container=document.getElementById('params');
  container.innerHTML=''; currentParams={};
  defs.forEach(function(d){
    currentParams[d.key]=d.def;
    var group=document.createElement('div'); group.className='param-group';
    var label=document.createElement('label'); label.textContent=d.label;
    if(d.checkbox) {
      var toggle=document.createElement('input');toggle.type='checkbox';toggle.id='regenToggle';toggle.checked=currentParams[d.key]===1;
      label.htmlFor=toggle.id;
      toggle.addEventListener('change',function(){currentParams[d.key]=toggle.checked?1:0;refresh();});
      group.appendChild(label);group.appendChild(toggle);container.appendChild(group);return;
    }
    var row=document.createElement('div'); row.className='param-row';
    var range=document.createElement('input'); range.type='range';
    range.min=d.min; range.max=d.max; range.step=d.step; range.value=d.def;
    var num=document.createElement('input'); num.type='number';
    num.min=d.min; num.max=d.max; num.step=d.step; num.value=d.def;
    range.addEventListener('input',function(){num.value=range.value;currentParams[d.key]=parseFloat(range.value);refresh();});
    num.addEventListener('input',function(){var v=parseFloat(num.value);if(!isNaN(v)){v=Math.max(d.min,Math.min(d.max,v));range.value=v;currentParams[d.key]=v;refresh();}});
    row.appendChild(range); row.appendChild(num);
    group.appendChild(label); group.appendChild(row);
    container.appendChild(group);
  });
}

// ================================================================
//  UI: RESULTS / TABLE / DERIVATION
// ================================================================
function buildResults(th) {
  var regen=th.regeneration;
  var efficiency=(regen?'有回热 ':'')+(th.eta*100).toFixed(2)+'<small>%</small>'+(regen?'<br><small>无回热 '+(regen.etaWithout*100).toFixed(2)+'%</small>':'');
  document.getElementById('results').innerHTML=
    '<div class="card highlight"><div class="label">\u70ED\u6548\u7387 \u03B7</div><div class="value">'+efficiency+'</div></div>'+
    '<div class="card"><div class="label">\u5361\u8BFA\u6548\u7387 \u03B7<sub>C</sub></div><div class="value">'+(th.etaC*100).toFixed(2)+'<small>%</small></div></div>'+
    '<div class="card"><div class="label">\u5438\u70ED\u91CF q<sub>in</sub></div><div class="value">'+th.qIn.toFixed(2)+'<small> kJ/kg</small></div></div>'+
    '<div class="card"><div class="label">\u653E\u70ED\u91CF q<sub>out</sub></div><div class="value">'+th.qOut.toFixed(2)+'<small> kJ/kg</small></div></div>'+
    '<div class="card"><div class="label">\u51C0\u529F w<sub>net</sub></div><div class="value">'+th.wNet.toFixed(2)+'<small> kJ/kg</small></div></div>';
}
function buildTable(th) {
  var norm=normalizeForTs(th);
  var html='<thead><tr><th>\u72B6\u6001\u70B9</th><th>p (kPa)</th><th>v (m\u00B3/kg)</th><th>T (K)</th><th>s (kJ/(kg\u00B7K))</th></tr></thead><tbody>';
  norm.states.concat(norm.regeneration?norm.regeneration.states:[]).forEach(function(s,i){
    html+='<tr><td><strong>'+(i+1)+'</strong></td><td>'+s.p.toFixed(2)+'</td><td>'+s.v.toFixed(6)+'</td><td>'+s.T.toFixed(2)+'</td><td>'+s.s.toFixed(4)+'</td></tr>';
  });
  html+='</tbody>';
  document.getElementById('stateTable').innerHTML=html;
}
function buildDerivation(th) {
  var el=document.getElementById('derivationContent');
  var text=getDerivation(currentCycle, currentParams, th);
  el.innerHTML=text.split('\n\n').map(function(block){
    var lines=block.split('\n'), title=lines[0], body=lines.slice(1).join('\n');
    return '<div class="step"><div class="step-label">'+title+'</div>'+body+'</div>';
  }).join('');
}
function updateEffTitle() {
  var t={otto:'\u70ED\u6548\u7387 \u03B7 \u2014 \u538B\u7F29\u6BD4 r \u66F2\u7EBF',diesel:'\u70ED\u6548\u7387 \u03B7 \u2014 \u538B\u7F29\u6BD4 r \u66F2\u7EBF',brayton:'\u70ED\u6548\u7387 \u03B7 \u2014 \u589E\u538B\u6BD4 \u03C0p \u66F2\u7EBF'};
  document.getElementById('effCurveTitle').textContent=t[currentCycle];
}

// ================================================================
//  AXIS LOCKING: INIT / RESET
// ================================================================
function initAxesForCycle(cycle) {
  var defParams=getDefaultParams(cycle);
  pvRefTh=calculate(cycle, defParams);
  tsRefNorm=normalizeForTs(pvRefTh);
  pvLocked=computeAxisBounds(pvRefTh.states,'v','p',0.3);
  var tsBounds=computeAxisBounds(tsRefNorm.states,'s','T',0.3);
  tsLocked=tsBounds;
}
function resetPvView() {
  if (isComparisonActive()) { compareMode.pvBounds=null; drawComparisonDiagram('pv'); return; }
  initAxesForCycle(currentCycle); refresh();
}
function resetTsView() {
  if (isComparisonActive()) { compareMode.tsBounds=null; drawComparisonDiagram('ts'); return; }
  initAxesForCycle(currentCycle); refresh();
}

// ================================================================
//  MASTER UPDATE / SWITCH / INIT
// ================================================================
function refresh() {
  currentThermo=calculate(currentCycle, currentParams);
  var toggle=document.getElementById('regenToggle');if(toggle)toggle.checked=currentParams.regen===1;
  var regenNote=document.getElementById('regenerationNote'),regen=currentThermo.regeneration;
  regenNote.hidden=!regen||isComparisonActive();
  regenNote.textContent=regen?(regen.feasible?'回热量 = '+regen.q.toFixed(2)+' kJ/kg；内部回热减少外部吸热和放热，净功不变。':'此工况下回热不可行（T₄ ≤ T₂），按无回热计算。'):'';
  buildResults(currentThermo);
  buildTable(currentThermo);
  buildDerivation(currentThermo);
  buildLegend();
  updateAreaLabels(currentThermo);
  drawPvDiagram(currentThermo);
  drawTsDiagram(currentThermo);
  drawEffChart(currentCycle, currentParams, currentThermo);
  updateEffTitle();
  syncShareURL();
}
function switchCycle(cycle) {
  currentCycle=cycle;
  document.querySelectorAll('.tab').forEach(function(btn){btn.classList.toggle('active',btn.dataset.cycle===cycle);});
  buildParams();
  initAxesForCycle(cycle);
  refresh();
}
function isAIEnabled() {
  return window.CYCLELAB_CONFIG?.AI_ENABLED !== false;
}

function applyAIVisibility() {
  document.querySelectorAll('[data-ai]').forEach(function(element) {
    element.hidden = !isAIEnabled();
  });
}

function init() {
  applyAIVisibility();
  document.querySelectorAll('.tab').forEach(function(btn){btn.addEventListener('click',function(){switchCycle(btn.dataset.cycle);});});
  document.getElementById('pvReset').addEventListener('click', resetPvView);
  document.getElementById('tsReset').addEventListener('click', resetTsView);
  document.getElementById('pvRefToggle').addEventListener('change', function(){showPvRef=this.checked;if(currentThermo)drawPvDiagram(currentThermo);});
  document.getElementById('tsRefToggle').addEventListener('change', function(){showTsRef=this.checked;if(currentThermo)drawTsDiagram(currentThermo);});
  document.getElementById('pvAreaToggle').addEventListener('change', function(){showPvArea=this.checked;updateAreaLabels(currentThermo);drawPvDiagram(currentThermo);});
  document.getElementById('tsAreaToggle').addEventListener('change', function(){showTsArea=this.checked;updateAreaLabels(currentThermo);drawTsDiagram(currentThermo);});
  // AI event listeners
  document.getElementById('aiParseBtn').addEventListener('click', handleAIParse);
  document.getElementById('aiAskBtn').addEventListener('click', function(){handleAIAsk();});
  document.querySelectorAll('.btn-example').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.getElementById('aiAskInput').value = btn.dataset.q;
      showAIResult('aiAskResult', getExampleAnswer(btn.dataset.q), false);
    });
  });
  buildParams();
  initAxesForCycle(currentCycle);
  refresh();
  restoreSharedCondition();
  document.getElementById('copyLink').addEventListener('click',copyConditionLink);
  window.addEventListener('popstate',restoreSharedCondition);
  var resizeTimer;
  window.addEventListener('resize',function(){
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(function(){if(currentThermo){drawPvDiagram(currentThermo);drawTsDiagram(currentThermo);drawEffChart(currentCycle,currentParams,currentThermo);}},150);
  });
}
document.addEventListener('DOMContentLoaded', init);

// ================================================================
//  AI FEATURES
// ================================================================

function getExampleAnswer(question) {
  if (question === "\u4e3a\u4ec0\u4e48\u538b\u7f29\u6bd4\u8d8a\u9ad8\uff0c\u6548\u7387\u8d8a\u9ad8\uff1f") {
    var eta8 = (etaOtto(8) * 100).toFixed(2);
    var eta10 = (etaOtto(10) * 100).toFixed(2);
    return "\u5965\u6258\u5faa\u73af\u7684\u70ed\u6548\u7387 \u03b7 = 1 \u2212 1/r^(\u03ba\u22121)\uff0c\u53ea\u53d6\u51b3\u4e8e\u538b\u7f29\u6bd4\u3002\u538b\u7f29\u6bd4\u8d8a\u9ad8\uff0c\u538b\u7f29\u7ec8\u4e86\u6e29\u5ea6 T\u2082 = T\u2081\u00b7r^(\u03ba\u22121) \u8d8a\u9ad8\uff0c\u5de5\u8d28\u5728\u66f4\u9ad8\u7684\u5e73\u5747\u6e29\u5ea6\u4e0b\u5438\u70ed\uff0c\u6240\u4ee5\u6548\u7387\u63d0\u9ad8\uff08\u53ef\u4ee5\u5bf9\u6bd4\u5361\u8bfa\u5faa\u73af\uff1a\u5438\u70ed\u6e29\u5ea6\u8d8a\u9ad8\uff0c\u6548\u7387\u8d8a\u9ad8\uff09\u3002\u6309\u516c\u5f0f\u8ba1\u7b97\uff1ar = 8 \u65f6 \u03b7 = " + eta8 + "%\uff0cr = 10 \u65f6 \u03b7 = " + eta10 + "%\u3002\u4f46\u6c7d\u6cb9\u673a\u7684\u538b\u7f29\u6bd4\u53d7\u7206\u9707\u9650\u5236\uff0c\u4e0d\u80fd\u65e0\u9650\u63d0\u9ad8\u3002";
  }
  if (question === "\u540c\u6837\u7684\u538b\u7f29\u6bd4\uff0c\u72c4\u585e\u5c14\u4e3a\u4ec0\u4e48\u6bd4\u5965\u6258\u6548\u7387\u4f4e\uff1f") {
    var etaO18 = (etaOtto(18) * 100).toFixed(2);
    var etaD18 = (etaDiesel(18, 2) * 100).toFixed(2);
    return "\u5728\u76f8\u540c\u538b\u7f29\u6bd4\u4e0b\uff0c\u72c4\u585e\u5c14\u5faa\u73af\u5728\u5b9a\u538b\u4e0b\u5438\u70ed\uff0c\u5438\u70ed\u65f6\u6d3b\u585e\u5df2\u7ecf\u5f00\u59cb\u4e0b\u884c\uff0c\u6709\u6548\u81a8\u80c0\u6bd4\u53ea\u6709 r/rc\uff0c\u5c0f\u4e8e\u538b\u7f29\u6bd4 r\uff0c\u4ece\u9ad8\u6e29\u5de5\u8d28\u4e2d\u53d6\u51fa\u7684\u81a8\u80c0\u529f\u8f83\u5c11\uff0c\u6240\u4ee5\u6548\u7387\u8f83\u4f4e\u3002\u5728 T-s \u56fe\u4e0a\uff0c\u5b9a\u538b\u7ebf\u6bd4\u5b9a\u5bb9\u7ebf\u5e73\u7f13\uff0c\u5438\u70ed\u7684\u5e73\u5747\u6e29\u5ea6\u66f4\u4f4e\u3002\u6309\u516c\u5f0f\u8ba1\u7b97\uff0cr = 18 \u65f6\uff1a\u5965\u6258 \u03b7 = " + etaO18 + "%\uff0c\u72c4\u585e\u5c14\uff08rc = 2\uff09\u03b7 = " + etaD18 + "%\u3002\u4e0d\u8fc7\u67f4\u6cb9\u673a\u5b9e\u9645\u4f7f\u7528\u7684\u538b\u7f29\u6bd4\u6bd4\u6c7d\u6cb9\u673a\u9ad8\u5f97\u591a\uff0c\u6240\u4ee5\u5b9e\u9645\u6548\u7387\u53cd\u800c\u66f4\u9ad8\u3002";
  }
  if (question === "\u5b9e\u9645\u53d1\u52a8\u673a\u7684\u6548\u7387\u4e3a\u4ec0\u4e48\u8fdc\u4f4e\u4e8e\u8fd9\u4e2a\u503c\uff1f") {
    return "\u7a7a\u6c14\u6807\u51c6\u5faa\u73af\u5047\u8bbe\u4e86\u7406\u60f3\u6761\u4ef6\uff1a\u5de5\u8d28\u4e3a\u7406\u60f3\u7a7a\u6c14\u3001\u6bd4\u70ed\u4e3a\u5e38\u6570\u3001\u6240\u6709\u8fc7\u7a0b\u53ef\u9006\u3001\u65e0\u6469\u64e6\u548c\u70ed\u635f\u5931\u3002\u5b9e\u9645\u53d1\u52a8\u673a\u5b58\u5728\uff1a\u6469\u64e6\u635f\u5931\u3001\u4f20\u70ed\u635f\u5931\u3001\u4e0d\u5b8c\u5168\u71c3\u70e7\u3001\u5de5\u8d28\u6bd4\u70ed\u968f\u6e29\u5ea6\u53d8\u5316\u3001\u6392\u6c14\u5e26\u8d70\u70ed\u91cf\u7b49\u3002\u5b9e\u9645\u6c7d\u6cb9\u673a\u6548\u7387\u7ea6 25-35%\uff0c\u67f4\u6cb9\u673a\u7ea6 35-45%\uff0c\u8fdc\u4f4e\u4e8e\u7406\u8bba\u503c\u3002";
  }
  return null;
}

function getCycleContext() {
  if (!currentThermo) return '';
  var th = currentThermo;
  var cycleName = {otto:'奥托循环',diesel:'狄塞尔循环',brayton:'布雷顿循环'}[currentCycle];
  var paramDefs = PARAM_DEFS[currentCycle];
  var params = paramDefs.map(function(d){return d.label+': '+currentParams[d.key];}).join(', ');
  var states = th.states.map(function(s,i){
    return '状态'+(i+1)+': p='+s.p.toFixed(2)+' kPa, v='+s.v.toFixed(6)+' m³/kg, T='+s.T.toFixed(2)+' K, s='+s.s.toFixed(4)+' kJ/(kg·K)';
  }).join('; ');
  var regen=th.regeneration;
  var recovery=currentCycle==='brayton'?(regen?' | 回热：开启；回热度 ε='+regen.epsilon+'；回热可行：'+(regen.feasible?'是':'否')+'；无回热效率='+(regen.etaWithout*100).toFixed(2)+'%；回热量='+regen.q.toFixed(2)+' kJ/kg':' | 回热：关闭'):'';
  return cycleName+' | 参数: '+params+' | 热效率 η='+(th.eta*100).toFixed(2)+'%'+recovery+' | 状态点: '+states;
}

function showAIResult(elementId, text, isError) {
  var el = document.getElementById(elementId);
  el.textContent = text;
  el.className = 'ai-result show' + (isError ? ' error' : '');
}

function hideAIResult(elementId) {
  var el = document.getElementById(elementId);
  el.className = 'ai-result';
}

async function callAIFunction(endpoint, data) {
  var response = await fetch('/functions/v1/app' + endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data),
  });
  var result = await response.json();
  if (!response.ok) {
    // Special handling for unconfigured AI service
    if (response.status === 503 && result.error === 'AI 服务尚未配置') {
      throw new Error('AI 功能暂未开放，其他功能正常使用');
    }
    throw new Error(result.error || '请求失败');
  }
  return result;
}

function mapAIParams(params) {
  return { r: params.r, rc: params.rc, pi: params.pi_p, T1: params.T1, T3: params.T3, p1: params.p1 };
}

async function handleAIParse() {
  if (!isAIEnabled()) return;
  var input = document.getElementById('aiQuestionInput');
  var btn = document.getElementById('aiParseBtn');
  var question = input.value.trim();
  if (!question) {
    showAIResult('aiParseResult', '请输入题目', true);
    return;
  }
  btn.disabled = true;
  btn.textContent = '识别中...';
  hideAIResult('aiParseResult');
  try {
    var result = await callAIFunction('/ai/parse-question', {question: question});
    var parsed = result.result;
    var mappedParams = mapAIParams(parsed.params);
    // Apply the parsed result
    switchCycle(parsed.cycle);
    // Set parameters
    var paramDefs = PARAM_DEFS[parsed.cycle];
    var outOfRange = [];
    var usedDefaults = [];
    paramDefs.forEach(function(d) {
      var val = mappedParams[d.key];
      if (val === null || val === undefined) {
        usedDefaults.push(d.label + ' 使用默认值 ' + d.def);
        val = d.def;
      } else {
        // Check range
        if (val < d.min || val > d.max) {
          outOfRange.push(d.label + ' ' + val + ' 超出范围 (' + d.min + '–' + d.max + ')，已按 ' + (val < d.min ? d.min : d.max) + ' 显示');
          val = val < d.min ? d.min : d.max;
        }
      }
      currentParams[d.key] = val;
      // Update UI
      var group = document.querySelectorAll('.param-group')[paramDefs.indexOf(d)];
      if (group) {
        if (d.checkbox) {
          group.querySelector('input[type="checkbox"]').checked = val === 1;
        } else {
          group.querySelector('input[type="range"]').value = val;
          group.querySelector('input[type="number"]').value = val;
        }
      }
    });
    refresh();
    // Show result
    var msg = '已按题目设置参数，结果由公式计算。';
    if (parsed.corrected && parsed.corrected.length) msg += '\n已按题目原文校正：' + parsed.corrected.join('、');
    if (usedDefaults.length) msg += '\n以下参数使用了默认值：' + usedDefaults.join('; ');
    if (outOfRange.length) msg += '\n' + outOfRange.join('\n');
    showAIResult('aiParseResult', msg, false);
    // Open derivation
    document.querySelector('.derivation').open = true;
  } catch (e) {
    showAIResult('aiParseResult', e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '识别题目';
  }
}

async function handleAIAsk(question) {
  if (!isAIEnabled()) return;
  var input = document.getElementById('aiAskInput');
  var btn = document.getElementById('aiAskBtn');
  if (!question) {
    question = input.value.trim();
  } else {
    input.value = question;
  }
  if (!question) {
    showAIResult('aiAskResult', '请输入问题', true);
    return;
  }
  btn.disabled = true;
  btn.textContent = '思考中...';
  hideAIResult('aiAskResult');
  try {
    var context = getCycleContext();
    var result = await callAIFunction('/ai/ask', {question: question, context: context});
    showAIResult('aiAskResult', result.answer, false);
  } catch (e) {
    showAIResult('aiAskResult', e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '提问';
  }
}

// ================================================================
//  ACCEPTANCE TESTS (browser console: runTests())
// ================================================================
window.runTests = function() {
  console.log('=== CycleLab Acceptance Tests ===\n');
  var pass=0,fail=0;
  function check(n,a,e,t){var d=Math.abs(a-e);if(d<t){pass++;console.log('PASS  '+n+': '+a.toFixed(4));}else{fail++;console.log('FAIL  '+n+': got '+a.toFixed(4)+', exp '+e.toFixed(4));}}
  var o=calcOtto({r:8,T3:1800,T1:300,p1:100});
  check('Otto \u03B7 (r=8)',o.eta*100,56.47,0.1);
  check('Otto energy',o.wNet,o.qIn-o.qOut,1e-10);
  var oN=normalizeForTs(o);
  check('Otto T-s closure',oN.states[3].s+CV*Math.log(oN.states[0].T/oN.states[3].T),0,1e-6);
  var b=calcBrayton({pi:10,T3:1400,T1:300,p1:100});
  check('Brayton \u03B7 (\u03C0p=10)',b.eta*100,48.21,0.1);
  check('Brayton energy',b.wNet,b.qIn-b.qOut,1e-10);
  var bN=normalizeForTs(b);
  check('Brayton T-s closure',bN.states[3].s+CP*Math.log(bN.states[0].T/bN.states[3].T)-R_GAS*Math.log(bN.states[0].p/bN.states[3].p),0,1e-6);
  var d=calcDiesel({r:18,rc:2,T1:300,p1:100});
  check('Diesel \u03B7 (r=18,rc=2)',d.eta*100,63.16,0.1);
  check('Diesel energy',d.wNet,d.qIn-d.qOut,1e-10);
  var dN=normalizeForTs(d);
  check('Diesel T-s closure',dN.states[3].s+CV*Math.log(dN.states[0].T/dN.states[3].T),0,1e-6);
  check('Otto s4=s3',o.states[3].s-o.states[2].s,0,1e-10);
  check('Diesel s4=s3',d.states[3].s-d.states[2].s,0,1e-10);
  check('Brayton s4=s3',b.states[3].s-b.states[2].s,0,1e-10);
  // Cache answer value tests
  var a1=getExampleAnswer("\u4e3a\u4ec0\u4e48\u538b\u7f29\u6bd4\u8d8a\u9ad8\uff0c\u6548\u7387\u8d8a\u9ad8\uff1f");
  if(a1&&a1.indexOf((etaOtto(8)*100).toFixed(2))>=0&&a1.indexOf((etaOtto(10)*100).toFixed(2))>=0){pass++;console.log('PASS  Cache Q1 values match: '+((etaOtto(8)*100).toFixed(2))+'%, '+((etaOtto(10)*100).toFixed(2))+'%');}else{fail++;console.log('FAIL  Cache Q1 values mismatch');}
  var a2=getExampleAnswer("\u540c\u6837\u7684\u538b\u7f29\u6bd4\uff0c\u72c4\u585e\u5c14\u4e3a\u4ec0\u4e48\u6bd4\u5965\u6258\u6548\u7387\u4f4e\uff1f");
  if(a2&&a2.indexOf((etaOtto(18)*100).toFixed(2))>=0&&a2.indexOf((etaDiesel(18,2)*100).toFixed(2))>=0){pass++;console.log('PASS  Cache Q2 values match: '+((etaOtto(18)*100).toFixed(2))+'%, '+((etaDiesel(18,2)*100).toFixed(2))+'%');}else{fail++;console.log('FAIL  Cache Q2 values mismatch');}
  check('Cache Otto r=8',etaOtto(8)*100,56.47,0.01);
  check('Cache Otto r=10',etaOtto(10)*100,60.19,0.01);
  check('Cache Otto r=18',etaOtto(18)*100,68.53,0.01);
  check('Cache Diesel r=18 rc=2',etaDiesel(18,2)*100,63.16,0.01);
  console.log('\n=== '+pass+' passed, '+fail+' failed ===');
  return {pass:pass,fail:fail};
};
