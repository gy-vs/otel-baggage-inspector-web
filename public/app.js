// Baggage workbench frontend. Talks to the JSON API, renders per-hop
// propagation results, comparisons and exports.
const $ = (id) => document.getElementById(id);

const state = {
  graphId: null,
  revision: null,
  graph: null,
  runs: [], // run summaries + loaded hop lists
  lastRun: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body.error?.code;
    throw err;
  }
  return body;
}

function setMessage(el, text, kind) {
  el.textContent = text || '';
  el.className = 'message ' + (kind || '');
}

// ---------- graph loading / editing ----------

async function loadGraphList() {
  const { graphs } = await api('/api/graphs');
  const sel = $('graphSelect');
  sel.innerHTML = graphs.map((g) => `<option value="${esc(g.id)}">${esc(g.name)} (${esc(g.id)})</option>`).join('');
  if (graphs.length && !state.graphId) state.graphId = graphs[0].id;
  sel.value = state.graphId;
  return graphs;
}

async function loadGraph(id) {
  const data = await api(`/api/graphs/${id}`);
  state.graphId = data.id;
  state.revision = data.revision;
  state.graph = data.graph;
  $('graphSelect').value = data.id;
  $('revisionBadge').textContent = `revision ${data.revision}`;
  $('graphJson').value = JSON.stringify(data.graph, null, 2);
  renderViz();
  renderEntryNodes();
  setMessage($('graphMessage'), '');
  await refreshRuns();
}

function renderEntryNodes() {
  const sel = $('entryNode');
  sel.innerHTML = state.graph.nodes.map((n) => `<option>${esc(n.id)}</option>`).join('');
}

async function saveGraph() {
  let doc;
  try {
    doc = JSON.parse($('graphJson').value);
  } catch (e) {
    setMessage($('graphMessage'), 'JSON 解析失败：' + e.message, 'error');
    return;
  }
  try {
    const data = await api(`/api/graphs/${state.graphId}`, {
      method: 'PUT',
      body: JSON.stringify({ graph: doc, expectedRevision: state.revision }),
    });
    state.revision = data.revision;
    state.graph = data.graph;
    $('revisionBadge').textContent = `revision ${data.revision}`;
    $('graphJson').value = JSON.stringify(data.graph, null, 2);
    renderViz();
    renderEntryNodes();
    setMessage($('graphMessage'), `已保存为 revision ${data.revision}`, 'ok');
    await refreshRuns();
  } catch (e) {
    if (e.status === 409) {
      setMessage($('graphMessage'), `冲突：${e.message} —— 有人并发修改了配置，请点 ↻ 重新加载后再改。`, 'error');
    } else {
      setMessage($('graphMessage'), `保存失败：${e.message}`, 'error');
    }
  }
}

async function createGraph() {
  const template = {
    name: 'new-graph',
    nodes: [
      { id: 'a', config: {} },
      { id: 'b', config: { sensitive: ['password'] } },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  };
  const data = await api('/api/graphs', { method: 'POST', body: JSON.stringify(template) });
  state.graphId = data.id;
  await loadGraphList();
  await loadGraph(data.id);
}

// ---------- graph visualization (layered SVG) ----------

function computeLayers(graph) {
  const depth = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < graph.nodes.length; i++) {
    for (const e of graph.edges) {
      if (depth.get(e.target) < depth.get(e.source) + 1) {
        depth.set(e.target, depth.get(e.source) + 1);
      }
    }
  }
  return depth;
}

function renderViz() {
  const g = state.graph;
  if (!g) return;
  const depth = computeLayers(g);
  const layers = new Map();
  for (const n of g.nodes) {
    const d = depth.get(n.id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n.id);
  }
  const W = 130, H = 44, GX = 70, GY = 34;
  const pos = new Map();
  let maxLayer = 0, maxCount = 0;
  for (const [d, ids] of layers) {
    maxLayer = Math.max(maxLayer, d);
    maxCount = Math.max(maxCount, ids.length);
    ids.forEach((id, i) => pos.set(id, { x: 20 + d * (W + GX), y: 20 + i * (H + GY) }));
  }
  const width = 40 + (maxLayer + 1) * (W + GX);
  const height = 40 + maxCount * (H + GY);
  const center = (id) => {
    const p = pos.get(id);
    return { x: p.x + W / 2, y: p.y + H / 2 };
  };
  let edgesSvg = '';
  for (const e of g.edges) {
    const a = center(e.source), b = center(e.target);
    const x1 = a.x + W / 2, y1 = a.y, x2 = b.x - W / 2, y2 = b.y;
    const mx = (x1 + x2) / 2;
    edgesSvg += `<path class="edge-line" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none"/>`;
    const label = e.attempts > 1 ? `${esc(e.id)} ×${e.attempts}` : esc(e.id);
    edgesSvg += `<text class="edge-label" x="${mx}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle">${label}</text>`;
  }
  let nodesSvg = '';
  for (const n of g.nodes) {
    const p = pos.get(n.id);
    nodesSvg += `<rect class="node-box" x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="6"/>
      <text class="node-label" x="${p.x + W / 2}" y="${p.y + H / 2 + 4}" text-anchor="middle">${esc(n.id)}</text>`;
  }
  $('graphViz').innerHTML =
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="#4a5a80"/></marker></defs>
      ${edgesSvg}${nodesSvg}</svg>`;
}

// ---------- run simulation ----------

async function runSimulation() {
  const entry = {
    node: $('entryNode').value,
    headers: {
      baggage: $('inBaggage').value,
      traceparent: $('inTraceparent').value,
      tracestate: $('inTracestate').value,
    },
  };
  try {
    const run = await api(`/api/graphs/${state.graphId}/runs`, {
      method: 'POST',
      body: JSON.stringify(entry),
    });
    state.lastRun = run;
    setMessage(
      $('runMessage'),
      `runId ${run.runId} · 绑定 revision ${run.revision} · ${run.hops.length} 跳` +
        (run.existing ? ' ·（相同输入已存在，返回确定性结果）' : ''),
      'ok'
    );
    renderRun(run);
    await refreshRuns();
  } catch (e) {
    setMessage($('runMessage'), `运行失败：${e.message}`, 'error');
  }
}

function statusChip(text, cls) {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

function renderMemberTable(members) {
  const rows = members.map((m) => {
    const status = `<span class="status-${m.status}">${m.status}</span>`;
    const keyOut = m.outKey !== m.key
      ? `${esc(m.key)} → <b>${esc(m.outKey)}</b>`
      : esc(m.key);
    const prev = m.previousValue !== undefined ? ` <span class="reason">(was ${esc(m.previousValue)})</span>` : '';
    const issues = (m.issues || []).map((i) => `<span class="issue">⚠ ${esc(i)}</span>`).join(' ');
    const props = (m.properties || [])
      .map((p) => `${esc(p.key)}${p.value !== null ? '=' + esc(p.value) : ''}`)
      .join('; ');
    return `<tr>
      <td>${keyOut}</td>
      <td>${esc(m.value)}${prev}</td>
      <td>${props ? esc(props) : '<span class="reason">—</span>'}</td>
      <td>${status}</td>
      <td class="reason">${esc(m.reason || '')} ${issues}</td>
    </tr>`;
  });
  return `<table>
    <thead><tr><th>键</th><th>值</th><th>属性</th><th>状态</th><th>原因 / 问题</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}

function renderHop(hop) {
  const events = hop.events
    .map((e) => {
      const detail = Object.entries(e)
        .filter(([k]) => k !== 'type')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      return `<div>· <code>${esc(e.type)}</code> ${esc(detail)}</div>`;
    })
    .join('');
  const redactedNote = hop.input.baggageRedacted ? ' <span class="redacted">（输入已脱敏）</span>' : '';
  return `<div class="hop-card" id="hop-${esc(hop.hopId)}">
    <div class="hop-head">
      <span class="edge">${esc(hop.source)} → ${esc(hop.target)}</span>
      ${statusChip(hop.hopId, '')}
      ${statusChip('路径 ' + hop.pathId, 'path')}
      ${hop.attempts > 1 ? statusChip(`重试 ${hop.attempt}/${hop.attempts}`, 'attempt') : ''}
    </div>
    <div class="headers-io">
      <span class="k">入 baggage</span><span>${esc(hop.input.baggage) || '<空>'}${redactedNote}</span>
      <span class="k">出 baggage</span><span>${esc(hop.output.baggage) || '<空>'}</span>
      <span class="k">出 traceparent</span><span>${esc(hop.output.traceparent)}</span>
    </div>
    ${renderMemberTable(hop.members)}
    <div class="trace-line">trace: <b>${esc(hop.trace.traceId)}</b> · span <b>${esc(hop.trace.spanId)}</b> · parent ${esc(hop.trace.parentSpanId || '—')} · sampled=${hop.trace.sampled} · ${hop.trace.continued ? '延续已有 trace' : '开启新 trace'}</div>
    ${events ? `<div class="events">${events}</div>` : ''}
  </div>`;
}

function renderRun(run) {
  $('runMeta').innerHTML = `
    <div class="meta-line">runId <b>${esc(run.runId)}</b> · 图 <b>${esc(run.graphId)}</b> · 绑定 revision <b>${run.revision}</b> · 入口 <b>${esc(run.entry.node)}</b></div>`;
  $('joinInfo').innerHTML = (run.joins || [])
    .map(
      (j) =>
        `<div class="join-box">合流节点 <b>${esc(j.node)}</b>：来自 ${j.inboundEdges.map(esc).join(', ')} 的状态保持隔离（${j.isolatedStates.map(esc).join(' / ')}），header 不会被凭空合并。</div>`
    )
    .join('');
  const byPath = new Map();
  for (const hop of run.hops) {
    if (!byPath.has(hop.pathId)) byPath.set(hop.pathId, []);
    byPath.get(hop.pathId).push(hop);
  }
  let html = '';
  for (const [pathId, hops] of byPath) {
    html += `<h3>路径 ${esc(pathId)}</h3>` + hops.map(renderHop).join('');
  }
  $('hopList').innerHTML = html;
  populateCompareSelects();
}

// ---------- runs list / export ----------

async function refreshRuns() {
  const { runs } = await api(`/api/graphs/${state.graphId}/runs`);
  state.runs = runs;
  $('runList').innerHTML = runs.length
    ? runs
        .map(
          (r) => `<div class="run-item">
        <span><b>${esc(r.runId)}</b></span>
        <span>revision ${r.revision}</span>
        <span>入口 ${esc(r.entry.node)}</span>
        <span>${r.hopCount} 跳</span>
        <button data-run="${esc(r.runId)}" class="load-run">查看</button>
        <a href="/api/runs/${esc(r.runId)}/export" download><button>导出 JSON（已脱敏）</button></a>
      </div>`
        )
        .join('')
    : '<div class="meta-line">暂无运行</div>';
  for (const btn of document.querySelectorAll('.load-run')) {
    btn.onclick = async () => {
      const run = await api(`/api/runs/${btn.dataset.run}`);
      state.lastRun = run;
      renderRun(run);
      setMessage($('runMessage'), `已加载历史运行 ${run.runId}（revision ${run.revision}，不受后续配置修改影响）`, 'ok');
    };
  }
  populateCompareSelects();
}

// ---------- compare ----------

function populateCompareSelects() {
  const options = [];
  for (const r of state.runs) {
    options.push(`<optgroup label="${esc(r.runId)} (rev ${r.revision})" data-run="${esc(r.runId)}"></optgroup>`);
  }
  // We need hop ids per run; fetch lazily when the user focuses the select.
  const fill = async (sel) => {
    const parts = [];
    for (const r of state.runs) {
      const run = await api(`/api/runs/${r.runId}`);
      for (const h of run.hops) {
        const label = `${run.runId.slice(0, 10)}… rev${run.revision} · ${h.hopId} · ${h.source}→${h.target} · ${h.pathId}` +
          (h.attempts > 1 ? ` · 尝试${h.attempt}` : '');
        parts.push(`<option value="${run.runId}:${h.hopId}">${esc(label)}</option>`);
      }
    }
    sel.innerHTML = parts.join('');
  };
  fill($('compareA'));
  fill($('compareB'));
}

async function compareHops() {
  const a = $('compareA').value;
  const b = $('compareB').value;
  if (!a || !b) return;
  try {
    const data = await api(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    const rows = data.members
      .map((m) => {
        const cell = (x) => (x ? `${esc(x.status)} · ${esc(x.value)}${x.reason ? ` <span class="reason">(${esc(x.reason)})</span>` : ''}` : '<span class="reason">—</span>');
        return `<tr>
          <td>${esc(m.key)}</td>
          <td>${cell(m.a)}</td>
          <td>${cell(m.b)}</td>
          <td class="diff-${esc(m.change)}">${esc(m.change)}</td>
        </tr>`;
      })
      .join('');
    $('compareResult').innerHTML = `
      <div class="meta-line">A: <b>${esc(data.a.hopId)}</b> (${esc(data.a.edge)}, rev ${data.a.revision}, 路径 ${esc(data.a.pathId)}) · trace ${esc(data.a.trace.traceId)}</div>
      <div class="meta-line">B: <b>${esc(data.b.hopId)}</b> (${esc(data.b.edge)}, rev ${data.b.revision}, 路径 ${esc(data.b.pathId)}) · trace ${esc(data.b.trace.traceId)}</div>
      <table><thead><tr><th>键</th><th>A</th><th>B</th><th>差异</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) {
    $('compareResult').innerHTML = `<div class="message error">比较失败：${esc(e.message)}</div>`;
  }
}

// ---------- boot ----------

$('saveGraphBtn').onclick = saveGraph;
$('newGraphBtn').onclick = createGraph;
$('runBtn').onclick = runSimulation;
$('compareBtn').onclick = compareHops;
$('reloadGraphBtn').onclick = () => loadGraph(state.graphId);
$('graphSelect').onchange = (e) => loadGraph(e.target.value);

(async () => {
  try {
    await loadGraphList();
    if (state.graphId) await loadGraph(state.graphId);
  } catch (e) {
    setMessage($('graphMessage'), '初始化失败：' + e.message, 'error');
  }
})();
