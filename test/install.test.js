import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL, plistXml } from '../src/install.js';

test('plistXml: label, program arguments, flags, hour and log paths', () => {
  const xml = plistXml({ close: true, reopen: true, bin: '/opt/x/bin/tabularasa.js', hour: 7 });
  assert.match(xml, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
  assert.match(xml, /<string>\/opt\/x\/bin\/tabularasa.js<\/string><string>morning<\/string><string>--close<\/string><string>--reopen<\/string>/);
  assert.match(xml, /<key>Hour<\/key><integer>7<\/integer><key>Minute<\/key><integer>0<\/integer>/);
  assert.match(xml, /tab-archive\.log<\/string>/);
  assert.ok(xml.includes(process.execPath), 'runs with the current node binary');

  const plain = plistXml({ bin: '/b' });
  assert.match(plain, /<string>morning<\/string><\/array>/, 'archive only by default');
  assert.match(plain, /<integer>6<\/integer>/);
});
