// Export-safe run records.
//
// Security guarantee: an exported record never contains any baggage member
// VALUE. In particular, a value deleted as sensitive cannot leak through:
//   - raw incoming header strings (omitted entirely),
//   - parse-failure `raw` text on events (stripped),
//   - earlier hops that carried the key before a downstream service deleted it
//     (values are reduced to byte lengths at every hop).
// Keys, order, properties (key + value byte length), sizes, drop reasons and
// trace identifiers are preserved — enough to audit retention/override/drop.

export function redactRun(run) {
  const redactedKeys = new Set();
  const redactedValueCount = { members: 0, propertyValues: 0 };

  function redactMember(m) {
    redactedValueCount.members += 1;
    return {
      key: m.key,
      valueBytes: memberValueBytes(m.value),
      properties: m.properties.map((p) => {
        redactedValueCount.propertyValues += 1;
        return { key: p.key, valueBytes: p.value == null ? 0 : byteLen(p.value) };
      }),
    };
  }

  const hops = run.result.hops.map((h) => {
    for (const d of h.dropped) {
      if (d.reason === 'sensitive-key-removed') redactedKeys.add(d.key);
    }
    for (const e of h.events ?? []) {
      if (e.reason === 'sensitive-key-removed' && e.key) redactedKeys.add(e.key);
    }
    const safeEvents = (h.events ?? []).map((e) => {
      const { raw, ...rest } = e;
      return rest;
    });
    return {
      hopNo: h.hopNo,
      kind: h.kind,
      serviceId: h.serviceId,
      edgeId: h.edgeId,
      fromServiceId: h.fromServiceId,
      attempt: h.attempt,
      attemptsTotal: h.attemptsTotal,
      branchPath: h.branchPath,
      join: h.join,
      trace: h.trace,
      incoming: {
        byteSize: h.incoming.byteSize,
        memberCount: h.incoming.members.length,
        members: h.incoming.members.map(redactMember),
        traceparent: h.incoming.traceparent,
        tracestate: h.incoming.tracestate,
        ...(h.incoming.note ? { note: h.incoming.note } : {}),
      },
      outgoing: {
        byteSize: h.outgoing.byteSize,
        memberCount: h.outgoing.members.length,
        members: h.outgoing.members.map(redactMember),
        traceparent: h.outgoing.traceparent,
        tracestate: h.outgoing.tracestate,
      },
      dropped: (h.dropped ?? []).map(({ key, reason, phase, bytes, limit }) =>
        stripUndef({ key, reason, phase, bytes, limit })
      ),
      events: safeEvents,
    };
  });

  return {
    format: 'baggage-workbench-export/v1',
    redacted: true,
    redactionPolicy: 'all baggage values removed; keys, sizes and reasons retained',
    runId: run.runId,
    configId: run.configId,
    configName: run.configName,
    revision: run.revision,
    configFingerprint: run.configFingerprint,
    headRevisionAtRun: run.headRevisionAtRun,
    inputFingerprint: run.inputFingerprint,
    labels: run.labels,
    resultHash: run.result.resultHash,
    seed: run.result.seed,
    redactedKeys: [...redactedKeys].sort(),
    redactedValueCount,
    hops,
  };
}

function stripUndef(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
function byteLen(s) {
  return new TextEncoder().encode(String(s)).length;
}
function memberValueBytes(v) {
  return v == null ? 0 : byteLen(v);
}
