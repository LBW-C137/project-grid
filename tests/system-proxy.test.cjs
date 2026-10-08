const { test } = require('node:test');
const assert = require('node:assert/strict');
const { proxyUrl, systemProxyEnvironment, adoptSystemProxy } = require('../electron/system-proxy.cjs');

test('Chromium proxy rules become proxy URLs', () => {
  assert.equal(proxyUrl('PROXY 127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(proxyUrl('HTTPS proxy.example:443; DIRECT'), 'https://proxy.example:443');
  assert.equal(proxyUrl('SOCKS5 127.0.0.1:1080'), 'socks5h://127.0.0.1:1080');
  assert.equal(proxyUrl('DIRECT'), null);
  assert.equal(proxyUrl(''), null);
});

test('a desktop launch without proxy variables adopts the system proxy', () => {
  assert.deepEqual(systemProxyEnvironment({ PATH: '/usr/bin' }, ['PROXY 127.0.0.1:7897', 'PROXY 127.0.0.1:7897']), {
    HTTPS_PROXY: 'http://127.0.0.1:7897', https_proxy: 'http://127.0.0.1:7897',
    HTTP_PROXY: 'http://127.0.0.1:7897', http_proxy: 'http://127.0.0.1:7897',
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
  });
  assert.deepEqual(systemProxyEnvironment({ no_proxy: '.corp' }, ['DIRECT', 'SOCKS5 127.0.0.1:1080']), { ALL_PROXY: 'socks5h://127.0.0.1:1080', all_proxy: 'socks5h://127.0.0.1:1080' });
});

test('proxy variables the user set, and a direct connection, are left alone', () => {
  assert.deepEqual(systemProxyEnvironment({ https_proxy: 'http://mine:1' }, ['PROXY 127.0.0.1:7897']), {});
  assert.deepEqual(systemProxyEnvironment({ All_Proxy: 'socks5://mine:1' }, ['PROXY 127.0.0.1:7897']), {});
  assert.deepEqual(systemProxyEnvironment({}, ['DIRECT', 'DIRECT']), {});
});

test('the system proxy is written into the environment, and a stalled lookup does not hold up start-up', async () => {
  const env = {};
  await adoptSystemProxy({ env, session: { resolveProxy: async () => 'PROXY 127.0.0.1:7897' } });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  const stalled = {};
  assert.deepEqual(await adoptSystemProxy({ env: stalled, timeout: 10, session: { resolveProxy: () => new Promise(() => {}) } }), {});
  assert.deepEqual(stalled, {});
});

test('a stalled endpoint does not discard the proxy resolved for another endpoint', async () => {
  const env = {};
  await adoptSystemProxy({ env, timeout: 10, session: {
    resolveProxy: url => url.includes('anthropic') ? Promise.resolve('PROXY 127.0.0.1:7897') : new Promise(() => {}),
  } });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
});

test('failed lookups leave direct connections alone and explicit proxies skip discovery', async () => {
  const env = {};
  assert.deepEqual(await adoptSystemProxy({ env, session: { resolveProxy: async () => { throw new Error('unavailable'); } } }), {});
  assert.deepEqual(env, {});
  const explicit = { https_proxy: 'http://mine:1' };
  assert.deepEqual(await adoptSystemProxy({ env: explicit, session: { resolveProxy: () => assert.fail('must not query system proxy') } }), {});
  assert.deepEqual(explicit, { https_proxy: 'http://mine:1' });
});

test('startup uses each machine\'s resolved address and protocol, without a fixed local proxy', async t => {
  for (const scenario of [
    { name: 'no system proxy', rule: 'DIRECT', key: null },
    { name: 'another local port', rule: 'PROXY 127.0.0.1:3128', key: 'HTTPS_PROXY', value: 'http://127.0.0.1:3128' },
    { name: 'network proxy', rule: 'PROXY proxy.example:8080', key: 'HTTPS_PROXY', value: 'http://proxy.example:8080' },
    { name: 'TLS proxy', rule: 'HTTPS proxy.example:8443', key: 'HTTPS_PROXY', value: 'https://proxy.example:8443' },
    { name: 'IPv6 proxy', rule: 'PROXY [::1]:8888', key: 'HTTPS_PROXY', value: 'http://[::1]:8888' },
    { name: 'SOCKS proxy', rule: 'SOCKS5 192.0.2.10:1081', key: 'ALL_PROXY', value: 'socks5h://192.0.2.10:1081' },
  ]) {
    await t.test(scenario.name, async () => {
      const env = { PATH: '/usr/bin' };
      await adoptSystemProxy({ env, session: { resolveProxy: async () => scenario.rule } });
      if (!scenario.key) assert.deepEqual(env, { PATH: '/usr/bin' });
      else {
        assert.equal(env[scenario.key], scenario.value);
        assert.equal(env[scenario.key.toLowerCase()], scenario.value);
      }
    });
  }
});
