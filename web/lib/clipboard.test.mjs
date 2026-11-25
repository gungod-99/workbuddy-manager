import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {copyText} from './clipboard.ts';

function setup(html = '<button id="copy">copy</button>') {
  const dom = new JSDOM(html, {url: 'http://panel.test:8090'});
  Object.defineProperty(globalThis, 'document', {value: dom.window.document, configurable: true});
  Object.defineProperty(globalThis, 'navigator', {value: dom.window.navigator, configurable: true});
  return dom.window.document;
}

test('HTTP copying stays inside the modal and restores the focused input selection', async () => {
  const doc = setup('<div role="dialog" data-state="open"><input id="field" value="callback address" /></div>');
  const field = doc.querySelector('#field');
  const dialog = doc.querySelector('[role="dialog"]');
  field.focus(); field.setSelectionRange(2, 8, 'backward');
  doc.addEventListener('focusin', (event) => {
    if (!dialog.contains(event.target)) field.focus();
  });
  doc.execCommand = (command) => {
    assert.equal(command, 'copy');
    assert.equal(doc.activeElement.tagName, 'TEXTAREA');
    assert.equal(doc.activeElement.closest('[role="dialog"]'), dialog);
    assert.equal(doc.activeElement.value, '完整授权链接');
    assert.equal(doc.activeElement.selectionEnd, '完整授权链接'.length);
    return true;
  };
  assert.equal(await copyText('完整授权链接'), true);
  assert.equal(doc.activeElement, field);
  assert.deepEqual([field.selectionStart, field.selectionEnd, field.selectionDirection], [2, 8, 'backward']);
  assert.equal(doc.querySelector('textarea'), null);
});

test('Clipboard API rejection falls back and execCommand false is a real failure', async () => {
  const doc = setup();
  Object.defineProperty(navigator, 'clipboard', {value: {writeText: async () => {throw new Error('denied');}}});
  let attempts = 0;
  doc.execCommand = () => {attempts += 1; return false;};
  assert.equal(await copyText('key'), false);
  assert.equal(attempts, 1);
  assert.equal(doc.querySelector('textarea'), null);
});

test('Clipboard API success avoids the fallback', async () => {
  const doc = setup();
  let value;
  Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (text) => {value = text;}}});
  doc.execCommand = () => {throw new Error('should not run');};
  assert.equal(await copyText('key'), true);
  assert.equal(value, 'key');
});

test('legacy exceptions restore document selection and leave no temporary fields', async () => {
  const doc = setup('<p id="text">selected text</p><button id="copy">copy</button>');
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('#text'));
  doc.querySelector('#copy').focus();
  doc.getSelection().removeAllRanges();
  doc.getSelection().addRange(range);
  assert.equal(doc.getSelection().toString(), 'selected text');
  doc.execCommand = () => {doc.getSelection().removeAllRanges(); throw new Error('blocked');};
  assert.equal(await copyText('key'), false);
  assert.equal(doc.getSelection().toString(), 'selected text');
  assert.equal(doc.activeElement.id, 'copy');
  assert.equal(doc.querySelector('textarea'), null);
});

test('server rendering without a document returns failure safely', async () => {
  delete globalThis.document;
  delete globalThis.navigator;
  assert.equal(await copyText('key'), false);
});
