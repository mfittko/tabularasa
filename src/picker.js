import readline from 'node:readline';

/** Terminal picker. ↑↓/jk move, space toggles, a toggles all, enter confirms, q quits (resolves []).
 *  single: enter picks the row under the cursor. preselect: start with every row selected. */
export function selectInteractive(items, { input = process.stdin, output = process.stdout, single = false, preselect = false,
  format = (x) => String(x), title = '' } = {}) {
  return new Promise((resolve) => {
    let cursor = 0;
    const on = new Set(preselect ? items.keys() : []);
    const help = single ? 'enter: choose  q: quit' : 'space: toggle  a: all  enter: confirm  q: quit';
    const draw = () => {
      readline.cursorTo(output, 0, 0); readline.clearScreenDown(output);
      output.write(`${title || `${items.length} items`}. ${help}\n\n`);
      items.forEach((it, i) => output.write(`${i === cursor ? '>' : ' '} ${single ? '' : `[${on.has(i) ? 'x' : ' '}] `}${format(it)}\n`));
    };
    const done = (result) => { input.setRawMode(false); input.pause(); input.off('keypress', onKey); output.write('\n'); resolve(result); };
    const onKey = (_, k) => {
      if (k.name === 'q' || k.name === 'escape' || (k.ctrl && k.name === 'c')) return done([]);
      if (k.name === 'return') return done(single ? [items[cursor]] : items.filter((_, i) => on.has(i)));
      if (k.name === 'up' || k.name === 'k') cursor = (cursor + items.length - 1) % items.length;
      if (k.name === 'down' || k.name === 'j') cursor = (cursor + 1) % items.length;
      if (!single && k.name === 'space') on.has(cursor) ? on.delete(cursor) : on.add(cursor);
      if (!single && k.name === 'a') items.forEach((_, i) => (on.size === items.length ? on.delete(i) : on.add(i)));
      draw();
    };
    readline.emitKeypressEvents(input);
    input.setRawMode(true); input.resume(); input.on('keypress', onKey);
    draw();
  });
}
