// Built-in sample: a checkout fan-out/fan-in graph designed to exercise every
// workbench feature — retries, allowlist, rename, sensitive deletion,
// isolate vs explicit union merge, and tight limits causing overflow drops.

export const SAMPLE_CONFIG = {
  name: 'Checkout pipeline',
  services: [
    {
      id: 'edge-gateway',
      sensitiveKeys: ['session-id'],
      limits: { maxTotalBytes: 8192, maxMembers: 100, maxMemberBytes: 4096 },
    },
    {
      id: 'auth',
      limits: { maxTotalBytes: 2000, maxMembers: 50, maxMemberBytes: 1000 },
      allowlist: ['user-id', 'tenant', 'request-id', 'region', 'blob'],
      rename: [{ from: 'user-id', to: 'uid' }],
    },
    {
      id: 'inventory',
      ignoreCase: true,
      sensitiveKeys: ['auth_token'],
      limits: { maxTotalBytes: 8192, maxMembers: 100, maxMemberBytes: 4096 },
    },
    {
      id: 'pricing',
      limits: { maxTotalBytes: 300, maxMembers: 10, maxMemberBytes: 200 },
    },
    {
      id: 'ledger',
      merge: 'union',
      limits: { maxTotalBytes: 8192, maxMembers: 100, maxMemberBytes: 4096 },
    },
    {
      id: 'notify',
      merge: 'isolate',
    },
  ],
  edges: [
    {
      from: 'edge-gateway',
      to: 'auth',
      retries: 1,
      retrySpan: 'new',
      transform: { addMembers: [{ key: 'region', value: 'cn-north' }] },
    },
    { from: 'auth', to: 'inventory', transform: { renameKeys: [{ from: 'uid', to: 'user-id' }] } },
    { from: 'auth', to: 'pricing', transform: { addMembers: [{ key: 'promo', value: 'SPRING-%E4%BC%98%E6%83%A0' }] } },
    { from: 'inventory', to: 'ledger', transform: { addMembers: [{ key: 'sku', value: 'A-1001' }] } },
    { from: 'pricing', to: 'ledger', transform: { addMembers: [{ key: 'sku', value: 'B-2002' }, { key: 'price', value: '19.99' }] } },
    { from: 'inventory', to: 'notify', transform: { addMembers: [{ key: 'channel', value: 'sms' }] } },
    { from: 'pricing', to: 'notify', transform: { addMembers: [{ key: 'channel', value: 'email' }] } },
  ],
};

export const SAMPLE_INPUT = {
  startService: 'edge-gateway',
  baggageHeaders: [
    [
      'user-id=u_42,tenant=acme,request-id=req-9f3c',
      'session-id=s3cr3t-token,region=us-east',
      'auth_token=Bearer%20abc,User-Id=duplicate-casing',
      'weird=%zz,emoji=%F0%9F%98%80',
      `blob=${'A'.repeat(250)}`,
    ].join(','),
  ],
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  tracestate: 'vendor1=value1,vendor2=value2',
};
