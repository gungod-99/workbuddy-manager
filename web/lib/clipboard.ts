/** Copy on HTTPS and ordinary HTTP, including inside a modal focus trap. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission rejection still permits the legacy path in some browsers.
    }
  }

  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i += 1) ranges.push(selection.getRangeAt(i).cloneRange());
  }
  const input = active as HTMLInputElement | HTMLTextAreaElement | null;
  let inputRange: [number, number, 'forward' | 'backward' | 'none'] | null = null;
  try {
    if (input && typeof input.selectionStart === 'number' && typeof input.selectionEnd === 'number') {
      inputRange = [input.selectionStart, input.selectionEnd, input.selectionDirection ?? 'none'];
    }
  } catch { /* Some input types do not support a selection. */ }

  // Radix redirects focus out of document.body back into the active dialog.
  // Keeping the temporary textarea inside that dialog makes selection stick.
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
    .filter((el) => !el.hidden && el.getAttribute('data-state') !== 'closed' && !el.closest('[inert]'));
  const parent = active?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
    ?? dialogs.at(-1) ?? document.body;
  if (!parent) return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  Object.assign(textarea.style, {position: 'fixed', top: '0', left: '0', width: '1px', height: '1px',
    opacity: '0', padding: '0', border: '0', fontSize: '16px'});
  parent.appendChild(textarea);
  let copied = false;
  try {
    textarea.focus({preventScroll: true});
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    copied = document.execCommand?.('copy') === true;
  } catch { /* Return the real failure to the caller. */ }
  finally {
    textarea.remove();
    try {
      if (active?.isConnected) {
        active.focus({preventScroll: true});
        if (inputRange) input?.setSelectionRange(...inputRange);
      }
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch { /* The original input or range may have been removed meanwhile. */ }
  }
  return copied;
}
