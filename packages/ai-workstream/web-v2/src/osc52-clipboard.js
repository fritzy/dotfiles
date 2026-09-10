function decodeBase64Text(encoded) {
  try {
    const binary = globalThis.atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function decodeOsc52(data) {
  const separator = data.indexOf(';');
  if (separator === -1) return null;
  const encoded = data.slice(separator + 1);
  if (encoded === '?') return null;
  return decodeBase64Text(encoded);
}

// Zellij owns ordinary drag selection while its mouse mode is active and emits
// the selected text through OSC 52. Firefox cannot write an asynchronously
// received OSC payload directly to the system clipboard, so retain it until a
// trusted Ctrl+Shift+C or native Copy event supplies user activation.
export function trackOsc52Clipboard(terminal) {
  let text = '';
  const osc52 = terminal.parser.registerOscHandler(52, (data) => {
    const decoded = decodeOsc52(data);
    if (decoded !== null) text = decoded;
    return true;
  });
  const copy = (event) => {
    if (terminal.hasSelection() || !text || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  };
  terminal.element?.addEventListener('copy', copy);

  return {
    get text() { return text; },
    dispose() {
      terminal.element?.removeEventListener('copy', copy);
      osc52.dispose();
    },
  };
}
