(() => {
  const storageKey = 'cyclelab.tour.seen.v1';
  const steps = [
    { target: '#tabs', text: '选一个循环' },
    { target: '#params input[type="range"]', text: '拖动压缩比，看循环怎么变' },
    { target: '#tsCanvas', text: '灰色虚线是默认工况，用来对比' },
    { target: '.derivation summary', text: '展开推导，看每一步怎么算' },
  ];
  let stepIndex = 0;
  let active = false;
  let previousFocus;
  let frame;
  const bubble = document.getElementById('tourBubble');
  const next = document.getElementById('tourNext');
  const help = document.getElementById('tourHelp');

  function hasSeenTour() {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  }

  function currentStep() {
    if (stepIndex === 3 && document.getElementById('compareToggle').checked) {
      return { target: '#compareResults', text: '并排比较两边的效率和热量' };
    }
    return steps[stepIndex];
  }

  function positionBubble() {
    if (!active) return;
    const target = document.querySelector(currentStep().target);
    document.querySelectorAll('.tour-target').forEach(element => element.classList.remove('tour-target'));
    target.classList.add('tour-target');
    const rect = target.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = rect.bottom + height + 28 <= window.innerHeight;
    const top = below ? rect.bottom + 16 : rect.top - height - 16;
    bubble.style.left = left + 'px';
    bubble.style.top = Math.max(12, Math.min(top, window.innerHeight - height - 12)) + 'px';
    bubble.dataset.placement = below ? 'below' : 'above';
    bubble.style.setProperty('--tour-arrow', Math.max(16, Math.min(rect.left + rect.width / 2 - left, width - 28)) + 'px');
  }

  function schedulePosition() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(positionBubble);
  }

  function showStep() {
    const step = currentStep();
    const target = document.querySelector(step.target);
    document.getElementById('tourProgress').textContent = '使用引导 · ' + (stepIndex + 1) + ' / ' + steps.length;
    document.getElementById('tourText').textContent = stepIndex === 1 && document.querySelector('.tab.active').dataset.cycle === 'brayton'
      ? '拖动增压比，看循环怎么变' : step.text;
    next.textContent = stepIndex === steps.length - 1 ? '完成' : '下一步';
    bubble.hidden = false;
    next.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    positionBubble();
  }

  function finishTour() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    bubble.hidden = true;
    document.querySelectorAll('.tour-target').forEach(element => element.classList.remove('tour-target'));
    try {
      localStorage.setItem(storageKey, 'true');
    } catch {
      // Storage may be blocked; the next visit should show the tour again.
    }
    const focusTarget = previousFocus instanceof HTMLElement && previousFocus !== document.body ? previousFocus : help;
    focusTarget.focus({ preventScroll: true });
  }

  function startTour() {
    previousFocus = document.activeElement;
    stepIndex = 0;
    active = true;
    showStep();
  }

  help.addEventListener('click', startTour);
  document.getElementById('tourSkip').addEventListener('click', finishTour);
  next.addEventListener('click', () => {
    if (stepIndex === steps.length - 1) finishTour();
    else { stepIndex++; showStep(); }
  });
  document.addEventListener('keydown', event => {
    if (active && event.key === 'Escape') finishTour();
  });
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  document.getElementById('tabs').addEventListener('click', () => {
    if (active) showStep();
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (!hasSeenTour()) startTour();
  });
})();
