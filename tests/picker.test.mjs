import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { fixture, model, selection } from './helpers.mjs';

test('AC-1 inline picker marks current model, searches, forwards focus, resizes and cancels', async t => {
  const f = await fixture(t); f.ctx.hasUI = true; f.ctx.mode = 'tui';
  const models = [model, ...Array.from({ length: 25 }, (_, i) => ({ ...model, id: 'other-' + i, name: 'Other ' + i }))];
  f.ctx.modelRegistry.getAvailable = () => models;
  f.ctx.ui.select = () => assert.fail('TUI must use inline picker, not generic dialog');
  let exercised = false;
  f.ctx.ui.custom = async factory => {
    exercised = true;
    const terminal = { rows: 24 }, tui = { terminal, requestRender() {} }, theme = { fg: (_color, text) => text, bold: text => text };
    let result, done = false;
    const component = factory(tui, theme, {}, value => { result = value; done = true; });
    assert.match(component.render(80).join('\n'), /✓.*summary/);
    component.focused = true;
    assert.ok(component.render(80).join('\n').includes(CURSOR_MARKER));
    component.handleInput('Other 17');
    assert.match(component.render(80).join('\n'), /→.*other-17/);
    for (const rows of [24, 10, 6, 3, 1]) {
      terminal.rows = rows;
      for (const width of [1, 30, 80]) {
        const lines = component.render(width);
        assert.ok(lines.length <= Math.max(1, rows - 2));
        assert.ok(lines.every(line => visibleWidth(line) <= width));
      }
    }
    component.handleInput('\x1b');
    assert.equal(done, true); return result;
  };
  await f.invoke('');
  assert.equal(exercised, true);
  assert.deepEqual(await f.settings(), { model: selection });
  assert.equal(f.requests.length, 0);
});
