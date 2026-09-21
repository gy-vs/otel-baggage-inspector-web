// Demo graph seeded at startup so the UI is explorable immediately:
//
//   frontend ──e1──> api ──e2──> auth ─┐
//                      │               ├──e4──> notify
//                      └──e3──> billing┘
//
// Showcases: allowlist + sensitive removal (api), rename (auth),
// retry attempts (api->billing), fork isolation and join (notify).
export function seedDemo(store) {
  store.createGraph({
    name: 'demo-shop',
    nodes: [
      { id: 'frontend', config: {} },
      {
        id: 'api',
        config: {
          sensitive: ['password', 'authorization'],
          set: { 'api-touched': 'true' },
          limits: { maxTotalBytes: 256, maxMembers: 12, maxMemberBytes: 128 },
        },
      },
      {
        id: 'auth',
        config: {
          renames: { user_id: 'uid' },
          allowlist: ['user_id', 'uid', 'session', 'env', 'Foo', 'foo', 'api-touched'],
        },
      },
      { id: 'billing', config: { sensitive: ['card-number'] } },
      { id: 'notify', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'frontend', target: 'api' },
      { id: 'e2', source: 'api', target: 'auth' },
      { id: 'e3', source: 'api', target: 'billing', attempts: 2 },
      { id: 'e4', source: 'auth', target: 'notify' },
      { id: 'e5', source: 'billing', target: 'notify' },
    ],
  });
}
