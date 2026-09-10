function copyWithExecCommand(text, documentObject) {
  if (!documentObject?.body || typeof documentObject.execCommand !== 'function') return false;

  const previouslyFocused = documentObject.activeElement;
  const textarea = documentObject.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.inset = '0 auto auto -10000px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  documentObject.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = documentObject.execCommand('copy');
  } catch {
    // The caller cannot surface a browser clipboard-permission prompt here.
  } finally {
    textarea.remove();
    try { previouslyFocused?.focus({ preventScroll: true }); } catch { previouslyFocused?.focus(); }
  }
  return copied;
}

export function writeClipboardText(text, {
  navigatorObject = globalThis.navigator,
  documentObject = globalThis.document,
} = {}) {
  const clipboard = navigatorObject?.clipboard;
  if (typeof clipboard?.writeText !== 'function') {
    return Promise.resolve(copyWithExecCommand(text, documentObject));
  }

  try {
    return Promise.resolve(clipboard.writeText(text))
      .then(() => true, () => copyWithExecCommand(text, documentObject));
  } catch {
    return Promise.resolve(copyWithExecCommand(text, documentObject));
  }
}

export function copyTerminalSelection(terminal, options = {}) {
  const terminalText = terminal.getSelection();
  const text = terminalText || options.fallbackText || '';
  if (!text) return Promise.resolve(false);

  const documentObject = options.documentObject ?? globalThis.document;
  // xterm installs a native `copy` listener on its element. Invoking the copy
  // command while xterm's textarea still has focus lets that listener put the
  // terminal selection directly on the clipboard. This must happen inside the
  // keydown event for Firefox to treat it as user-initiated.
  if ((terminalText || options.copyEventHandlesFallback)
    && typeof documentObject?.execCommand === 'function') {
    try {
      if (documentObject.execCommand('copy')) return Promise.resolve(true);
    } catch {
      // Fall through to the browser Clipboard API and its textarea fallback.
    }
  }
  return writeClipboardText(text, { ...options, documentObject });
}
