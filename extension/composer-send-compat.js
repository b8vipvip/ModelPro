(() => {
  const MARKER = 'modelproSendCompat';
  const PROMPT_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '.ProseMirror[contenteditable="true"]',
  ];

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect?.();
    const style = getComputedStyle(element);
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden');
  }

  function promptElement() {
    return PROMPT_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => visible(element)) || null;
  }

  function promptHasText(prompt) {
    if (!prompt) return false;
    const value = typeof prompt.value === 'string' ? prompt.value : (prompt.innerText || prompt.textContent || '');
    return String(value || '').trim().length > 0;
  }

  function excludedButton(button) {
    const descriptor = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-testid'),
      button.textContent,
    ].filter(Boolean).join(' ').toLowerCase();
    return /stop|停止|voice|语音|dictat|听写|record|录音|attach|upload|file|附件|添加|model|模型|reason|think|思考/.test(descriptor)
      || button.getAttribute('aria-haspopup') === 'menu';
  }

  function scoreButton(button, promptHasValue) {
    if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true' || excludedButton(button)) return -1;
    const descriptor = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-testid'),
      button.getAttribute('name'),
    ].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    if (/send-button|composer-submit-button/.test(descriptor)) score += 140;
    if (/(^|\s)(send|发送|提交)(\s|$)/i.test(descriptor)) score += 110;
    if (/send|发送|submit|提交/i.test(descriptor)) score += 90;
    if (String(button.type || '').toLowerCase() === 'submit') score += 75;
    if (/composer-primary|bg-composer-primary/.test(String(button.className || ''))) score += 35;
    if (promptHasValue) score += 10;
    const rect = button.getBoundingClientRect?.();
    if (rect) score += Math.max(0, Math.min(20, rect.x / 100));
    return score;
  }

  function annotateSendButton() {
    const prompt = promptElement();
    if (!prompt) return null;
    const form = prompt.closest('form');
    const scope = form || prompt.parentElement;
    if (!scope) return null;
    const hasText = promptHasText(prompt);
    const buttons = [...scope.querySelectorAll('button')];
    let best = null;
    let bestScore = -1;
    for (const button of buttons) {
      const score = scoreButton(button, hasText);
      if (score > bestScore) {
        best = button;
        bestScore = score;
      }
    }
    // The redesigned composer can expose only an icon button with no historical
    // data-testid/aria-label. Once prompt text exists, its right-most enabled
    // composer button is the submit control shown by ChatGPT.
    if ((!best || bestScore < 45) && hasText) {
      const fallback = buttons
        .filter((button) => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !excludedButton(button))
        .sort((a, b) => (b.getBoundingClientRect?.().x || 0) - (a.getBoundingClientRect?.().x || 0))[0] || null;
      if (fallback) best = fallback;
    }
    if (!best) return null;
    const existingTestId = best.getAttribute('data-testid');
    if (existingTestId && existingTestId !== 'send-button' && existingTestId !== 'composer-submit-button') {
      best.dataset.modelproOriginalTestid = existingTestId;
    }
    best.setAttribute('data-testid', 'send-button');
    best.dataset[MARKER] = 'true';
    return best;
  }

  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      annotateSendButton();
    }, 40);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule, true);
  window.setInterval(annotateSendButton, 250);
  annotateSendButton();
})();
