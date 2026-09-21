// Baggage workbench frontend — vanilla JS, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  configId: 'sample',
  revision: null,
  headRevision: null,
  config: null,
  run: null,
  selectedHop: null,
  cmpA: 0,
  cmpB: 1,
};

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data?.detail || data?.errors?.join('; ') || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'err' ? 7000 : 3500);
}

// ---------- tabs ----------

$$('.tabs').forEach((tabBar) => {
  tabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const panel = tabBar.parentElement;
    tabBar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    panel.querySelectorAll(':scope > .tabbody').forEach((tb) =>
      tb.classList.toggle('hidden', tb.dataset.tab !== btn.dataset.tab));
    if (btn.dataset.tab === 'runs') refreshRunsList();
  });
});

// ---------- config / input loading ----------

async function loadHeadConfig(id) {
  const list = await api('GET', '/api/configs');
  const found = list.configs.find((c) => c.configId === id) ?? list.configs[0];
  if (!found) return;
  state.configId = found.configId;
  const rec = await api('GET', `/api/configs/${found.configId}`);
  state.config = rec.config;
  state.revision = rec.revision;
  state.headRevision = rec.revision;
  $('#inConfig').value = JSON.stringify(rec.config, null, 2);
  $('#inExpectedRev').value = rec.revision;
  $('#inStart').value = rec.config.services[0]?.id ?? '';
  updateRevInfo();
}

function updateRevInfo() {
  const stale = state.run && state.run.revision !== state.headRevision;
  $('#revInfo').textContent = `config: ${state.configId} @ rev ${state.headRevision}` +
    (state.run ? ` · 运行固定在 rev ${state.run.revision}${stale ? '（旧 revision）' : ''}` : '');
  $('#revHint').textContent = `当前 head 是 ${state.headRevision}；保存时带 expectedRevision 做乐观并发控制。`;
}

function readEditorConfig() {
  const raw = $('#inConfig').value;
  return JSON.parse(raw);
}

// ---------- run ----------

function readRunInput() {
  const rootsText = $('#inRoots').value.trim();
  if (rootsText) {
    const roots = JSON.parse(rootsText);
    if (!Array.isArray(roots) || !roots.length) throw new Error('roots 必须是非空数组');
    return { roots };
  }
  const baggageLines = $('#inBaggage').value.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    startService: $('#inStart').value.trim() || undefined,
    baggageHeaders: baggageLines.length ? baggageLines : undefined,
    traceparent: $('#inTraceparent').value.trim() || undefined,
    tracestate: $('#inTracestate').value.trim() || undefined,
  };
}

async function doRun() {
  let input;
  try {
    readEditorConfig(); // validate JSON syntax early
    input = readRunInput();
  } catch (e) {
    toast('配置 JSON 解析失败：' + e.message, 'err');
    return;
  }
  // The server is authoritative for the graph. Unsaved editor edits must be
  // saved first; a currently displayed run keeps its pinned revision.
  if (editorDirty()) {
    toast('配置有未保存修改：请先“保存新 revision”（并发冲突会返回 409），再运行。', 'err');
    return;
  }
  try {
    const run = await api('POST', '/api/runs', { configId: state.configId, revision: state.headRevision, input });
    state.run = run;
    state.selectedHop = run.result.hops[0]?.hopNo ?? null;
    state.cmpA = run.result.hops[0]?.hopNo ?? 0;
    state.cmpB = run.result.hops[1]?.hopNo ?? state.cmpA;
    renderAll();
    toast(`运行完成：${run.result.hops.length} 跳${run.reused ? '（与已有运行完全一致，复用记录）' : ''}`, 'ok');
  } catch (e) {
    toast('模拟失败：' + e.message, 'err');
  }
}

function editorDirty() {
  try {
    return JSON.stringify(readEditorConfig()) !== JSON.stringify(state.config);
  } catch {
    return false; // syntax error already surfaced separately
  }
}

async function saveRevision() {
  let newConfig;
  try {
    newConfig = readEditorConfig();
  } catch (e) {
    toast('配置 JSON 解析失败：' + e.message, 'err');
    return;
  }
  const expected = Number($('#inExpectedRev').value);
  try {
    const rec = await api('PUT', `/api/configs/${state.configId}`, { config: newConfig, expectedRevision: expected });
    state.config = rec.config;
    state.revision = rec.revision;
    state.headRevision = rec.revision;
    $('#inExpectedRev').value = rec.revision;
    updateRevInfo();
    toast(`已保存 revision ${rec.revision}`, 'ok');
  } catch (e) {
    if (e.status === 409) {
      const cur = e.data?.currentRevision;
      toast(`并发冲突：你的 expectedRevision=${expected}，服务器 head 已是 ${cur}。\n请打开运行历史对比或重新拉取 head 后再合并保存。`, 'err');
    } else if (e.status === 400) {
      toast('配置校验失败：\n' + (e.data?.errors?.join('\n') || e.message), 'err');
    } else {
      toast(e.message, 'err');
    }
  }
}

async function exportRun() {
  if (!state.run) { toast('还没有运行记录', 'err'); return; }
  const redacted = await api('GET', `/api/runs/${state.run.runId}?export=redacted`);
  const blob = new Blob([JSON.stringify(redacted, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${redacted.runId}-redacted.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('导出的记录中所有 baggage 值均已移除（含被删除的敏感值）', 'ok');
}

// ---------- rendering ----------

function renderAll() {
  updateRevInfo();
  renderGraph();
  renderHopStrip();
  renderHopDetail();
  renderCompareSelectors();
  renderCompare();
}

function hopsByEdge(run) {
  const map = new Map();
  for (const h of run.result.hops) {
    if (h.edgeId == null) continue;
    if (!map.has(h.edgeId)) map.set(h.edgeId, []);
    map.get(h.edgeId).push(h);
  }
  return map;
}

function renderGraph() {
  const svg = $('#graph');
  svg.innerHTML = '';
  const cfg = state.config;
  if (!cfg) return;

  // levels by longest path
  const indeg = new Map(cfg.services.map((s) => [s.id, 0]));
  const adj = new Map(cfg.services.map((s) => [s.id, []]));
  for (const e of cfg.edges) { adj.get(e.from).push(e.to); indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1); }
  const level = new Map();
  const q = cfg.services.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id);
  q.forEach((id) => level.set(id, 0));
  const rem = new Map(indeg);
  while (q.length) {
    const id = q.shift();
    for (const v of adj.get(id)) {
      level.set(v, Math.max(level.get(v) ?? 0, (level.get(id) ?? 0) + 1));
      rem.set(v, rem.get(v) - 1);
      if (rem.get(v) === 0) q.push(v);
    }
  }
  const cols = new Map();
  for (const s of cfg.services) {
    const l = level.get(s.id) ?? 0;
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(s.id);
  }
  const COL_W = 175, ROW_H = 78, PAD_X = 24, PAD_Y = 26, NODE_W = 150, NODE_H = 52;
  const pos = new Map();
  [...cols.keys()].sort((a, b) => a - b).forEach((l) => {
    cols.get(l).forEach((id, i) => pos.set(id, { x: PAD_X + l * COL_W, y: PAD_Y + i * ROW_H }));
  });

  const width = PAD_X * 2 + ([...cols.keys()].length) * COL_W;
  const maxRows = Math.max(...[...cols.values()].map((v) => v.length), 1);
  const height = PAD_Y * 2 + maxRows * ROW_H;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  const byEdge = state.run ? hopsByEdge(state.run) : new Map();

  // edges
  const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  cfg.edges.forEach((e, idx) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return;
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
    const x2 = b.x, y2 = b.y + NODE_H / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    const hops = byEdge.get(idx) ?? [];
    const hasDrop = hops.some((h) => h.dropped.length > 0);
    const retry = (e.retries ?? 0) > 0;
    const active = hops.some((h) => h.hopNo === state.selectedHop);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `edge${hasDrop ? ' bad' : ''}${retry ? ' retry' : ''}${active ? ' active' : ''}`);
    g.style.cursor = 'pointer';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
    path.setAttribute('marker-end', 'url(#arrow)');
    g.appendChild(path);
    const summary = edgeLabel(e);
    if (summary) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('class', 'edge-label');
      t.setAttribute('x', (x1 + x2) / 2);
      t.setAttribute('y', (y1 + y2) / 2 - 6);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = summary;
      g.appendChild(t);
    }
    g.addEventListener('click', () => {
      if (hops.length) { state.selectedHop = hops[0].hopNo; renderAll(); }
    });
    edgeLayer.appendChild(g);
  });
  svg.appendChild(edgeLayer);

  // arrowhead defs
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
    <path d="M0,0 L8,4 L0,8 z" fill="#8a97b1"/></marker>`;
  svg.appendChild(defs);

  // nodes
  const nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (const s of cfg.services) {
    const p = pos.get(s.id);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `node${state.run?.result.hops.some((h) => h.hopNo === state.selectedHop && h.serviceId === s.id) ? ' active' : ''}`);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', p.x); rect.setAttribute('y', p.y);
    rect.setAttribute('width', NODE_W); rect.setAttribute('height', NODE_H);
    g.appendChild(rect);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', p.x + 10); t.setAttribute('y', p.y + 20);
    t.textContent = s.id;
    g.appendChild(t);
    const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    sub.setAttribute('class', 'svc-sub');
    sub.setAttribute('x', p.x + 10); sub.setAttribute('y', p.y + 38);
    const tags = [];
    if (s.sensitiveKeys?.length) tags.push(`删敏感×${s.sensitiveKeys.length}`);
    if (s.allowlist?.length) tags.push(`白名单×${s.allowlist.length}`);
    if (s.rename?.length) tags.push(`重命名×${s.rename.length}`);
    if (s.merge === 'union') tags.push('union合流');
    sub.textContent = tags.join(' · ') || `${s.limits.maxTotalBytes}B / ${s.limits.maxMembers}成员`;
    g.appendChild(sub);
    nodeLayer.appendChild(g);
  }
  svg.appendChild(nodeLayer);
}

function edgeLabel(e) {
  const t = e.transform;
  const parts = [];
  if (t?.dropAll) parts.push('dropAll');
  if (t?.setMembers) parts.push(`set×${t.setMembers.length}`);
  if (t?.addMembers?.length) parts.push(`+${t.addMembers.length}`);
  if (t?.deleteKeys?.length) parts.push(`-${t.deleteKeys.length}`);
  if (t?.renameKeys?.length) parts.push(`重命名×${t.renameKeys.length}`);
  if (e.retries) parts.push(`重试×${e.retries}`);
  return parts.join(' ');
}

function renderHopStrip() {
  const strip = $('#hopStrip');
  strip.innerHTML = '';
  if (!state.run) return;
  $('#runMeta').textContent =
    `${state.run.result.hops.length} 跳 · 结果哈希 ${state.run.result.resultHash.slice(0, 12)} · 固定 rev ${state.run.revision}`;
  for (const h of state.run.result.hops) {
    const card = document.createElement('div');
    card.className = 'hopcard' + (h.hopNo === state.selectedHop ? ' sel' : '');
    const dropCount = h.dropped.length;
    const addCount = (h.events ?? []).filter((e) => e.type === 'added').length;
    const title = h.kind === 'root' ? '入口'
      : h.kind === 'merge' ? `${h.serviceId} 合流`
      : `${h.fromServiceId} → ${h.serviceId}`;
    card.innerHTML = `
      <div class="hc-head"><span>#${h.hopNo} ${esc(title)}</span>
        ${h.attempt > 0 ? '<span class="badge retry">重试</span>' : ''}
        ${h.kind === 'merge' ? '<span class="badge merge">合流</span>' : ''}
      </div>
      <div class="hc-kind">${h.attemptsTotal > 1 ? `尝试 ${h.attempt + 1}/${h.attemptsTotal} · ` : ''}${h.outgoing.memberCount ?? h.outgoing.members.length} 成员 · ${h.outgoing.byteSize}B</div>
      <div class="hc-members" title="${esc(h.outgoing.members.map((m) => m.key).join(', '))}">${esc(h.outgoing.members.map((m) => m.key).join(', ') || '(空)')}</div>
      <div>${dropCount ? `<span class="badge drop">丢弃 ${dropCount}</span>` : '<span class="badge">无丢弃</span>'}
        ${addCount ? `<span class="badge add">新增 ${addCount}</span>` : ''}</div>`;
    card.addEventListener('click', () => { state.selectedHop = h.hopNo; renderAll(); });
    strip.appendChild(card);
  }
}

// ---------- hop detail ----------

function memberTags(h, member, outgoing) {
  const tags = [];
  const evs = h.events ?? [];
  if (outgoing) {
    const renamed = evs.find((e) => e.type === 'renamed' && e.to === member.key);
    if (renamed) tags.push(`<span class="tag rename">${esc(renamed.from)} → ${esc(renamed.to)}</span>`);
    if (evs.some((e) => e.type === 'added' && e.key === member.key)) tags.push('<span class="tag add">本跳新增</span>');
    if (evs.some((e) => e.type === 'dropped' && e.reason === 'overwritten' && e.key === member.key)) { /* old was dropped */ }
  }
  return tags.join('');
}

function memberTable(members, h, outgoing) {
  if (!members.length) return '<p class="hint">（无成员）</p>';
  const rows = members.map((m) => `
    <tr>
      <td class="k">${esc(m.key)}${memberTags(h, m, outgoing)}</td>
      <td class="v">${esc(m.value)}<div class="hint">${m.properties.map((p) => ';' + esc(p.key) + (p.value ? '=' + esc(p.value) : '')).join('')}</div></td>
    </tr>`).join('');
  return `<table class="member-table"><tr><th>key（大小写敏感）</th><th>解码值 / 属性</th></tr>${rows}</table>`;
}

function renderHopDetail() {
  const el = $('#hopDetail');
  if (!state.run) { el.innerHTML = '<p class="hint">运行后在此查看每跳。</p>'; return; }
  const h = state.run.result.hops.find((x) => x.hopNo === state.selectedHop);
  if (!h) { el.innerHTML = '<p class="hint">选择一跳。</p>'; return; }

  const events = h.events ?? [];
  const drops = events.filter((e) => e.type === 'dropped');
  const infos = events.filter((e) => e.type !== 'dropped');
  const title = h.kind === 'root' ? `入口：${h.serviceId}`
    : h.kind === 'merge' ? `合流：${h.serviceId}（${h.join.arrivalCount} 路到达）`
    : `${h.fromServiceId} → ${h.serviceId}${h.edgeId != null ? `（边 #${h.edgeId}）` : ''}`;

  el.innerHTML = `
    <div class="section-title">${esc(title)} · hop #${h.hopNo}${h.attempt > 0 ? ` · 重试尝试 ${h.attempt}` : ''}</div>
    ${h.join ? `<div class="kv">合流策略：<b>${h.join.merge}</b>，到达 ${h.join.arrivalCount} 路${h.join.warnings?.length ? '，⚠ ' + esc(h.join.warnings.join('；')) : ''}${h.join.merge === 'isolate' ? '（各路状态隔离，不自动合并）' : '（显式 union 合并）'}</div>` : ''}
    <div class="section-title">Trace Context</div>
    <div class="kv">in : ${esc(h.incoming.traceparent ?? '—')}${h.incoming.tracestate ? '<br>ts : ' + esc(h.incoming.tracestate) : ''}</div>
    <div class="kv">out: ${esc(h.outgoing.traceparent)}<br>span=${esc(h.trace.spanId)} parent=${esc(h.trace.parentSpanId ?? '(root)')}${h.trace.reusedSpan ? ' <span class="badge retry">重试复用 span</span>' : ''}</div>

    <div class="section-title">入站 baggage（${h.incoming.memberCount ?? h.incoming.members.length} 成员 / ${h.incoming.byteSize}B）${h.incoming.note ? ' · ' + esc(h.incoming.note) : ''}</div>
    ${h.kind === 'merge' ? '<p class="hint">union 合并，见各到达跳的入站。</p>' : memberTable(h.incoming.members, h, false)}

    <div class="section-title">出站 baggage（${h.outgoing.memberCount ?? h.outgoing.members.length} 成员 / ${h.outgoing.byteSize}B）</div>
    ${memberTable(h.outgoing.members, h, true)}

    <div class="section-title">丢弃 / 覆盖原因（${drops.length}）</div>
    <ul class="eventlist">${drops.map(evHtml).join('') || '<li class="info"><span class="ev-reason">无丢弃</span></li>'}</ul>

    <div class="section-title">其他事件（${infos.length}）</div>
    <ul class="eventlist">${infos.map(evHtml).join('') || '<li class="info"><span class="ev-reason">无</span></li>'}</ul>

    <div class="section-title">分支路径</div>
    <div class="kv">${esc(JSON.stringify(h.branchPath))}</div>`;
}

function evHtml(e) {
  const cls = e.type === 'dropped' ? '' : (e.phase === 'trace' ? 'trace' : 'info');
  const label = e.reason || e.type;
  const key = e.key ? `<span class="ev-key">${esc(e.key)}</span>` : '';
  const rename = e.type === 'renamed' ? `<span class="ev-key">${esc(e.from)} → ${esc(e.to)}</span>` : '';
  const size = e.limit ? ` <span class="ev-phase">limit=${e.limit}${e.bytes != null ? ` actual=${e.bytes}B` : ''}</span>` : '';
  return `<li class="${cls}"><span class="ev-phase">[${esc(e.phase)}]</span><span class="ev-reason">${esc(label)}</span>${key}${rename}${size}<span class="ev-phase">${esc(e.detail ?? '')}</span></li>`;
}

// ---------- compare ----------

function renderCompareSelectors() {
  if (!state.run) return;
  const opts = state.run.result.hops.map((h) => {
    const name = h.kind === 'root' ? `${h.serviceId}(入口)`
      : h.kind === 'merge' ? `${h.serviceId}(合流)`
      : `${h.fromServiceId}→${h.serviceId}${h.attempt > 0 ? ` 重试${h.attempt}` : ''}`;
    return `<option value="${h.hopNo}" ${h.hopNo === state.cmpA ? 'selected' : ''}>#${h.hopNo} ${esc(name)}</option>`;
  }).join('');
  $('#cmpA').innerHTML = opts;
  $('#cmpB').innerHTML = opts;
  const last = state.run.result.hops[state.run.result.hops.length - 1]?.hopNo ?? 0;
  if (state.cmpB == null || state.cmpB === state.cmpA) state.cmpB = last;
  $('#cmpA').value = String(state.cmpA);
  $('#cmpB').value = String(state.cmpB);
}

$('#cmpA')?.addEventListener('change', (e) => { state.cmpA = Number(e.target.value); renderCompare(); });
$('#cmpB')?.addEventListener('change', (e) => { state.cmpB = Number(e.target.value); renderCompare(); });

function renderCompare() {
  const el = $('#cmpResult');
  if (!state.run) { el.innerHTML = '<p class="hint">运行后可比较两跳。</p>'; return; }
  const a = state.run.result.hops.find((x) => x.hopNo === state.cmpA);
  const b = state.run.result.hops.find((x) => x.hopNo === state.cmpB);
  if (!a || !b) return;
  const ma = new Map(a.outgoing.members.map((m) => [m.key, m]));
  const mb = new Map(b.outgoing.members.map((m) => [m.key, m]));
  const keys = [...new Set([...ma.keys(), ...mb.keys()])];
  const rows = keys.map((k) => {
    const x = ma.get(k), y = mb.get(k);
    if (x && !y) return `<tr class="dropped"><td class="minus">−</td><td class="k">${esc(k)}</td><td class="v">${esc(x.value)}</td><td class="v"></td></tr>`;
    if (!x && y) return `<tr class="added"><td class="plus">+</td><td class="k">${esc(k)}</td><td class="v"></td><td class="v">${esc(y.value)}</td></tr>`;
    const changed = x.value !== y.value || JSON.stringify(x.properties) !== JSON.stringify(y.properties);
    return `<tr><td class="${changed ? 'same' : ''}">${changed ? '≠' : '='}</td><td class="k">${esc(k)}</td>
      <td class="v">${esc(x.value)}</td><td class="v">${esc(y.value)}</td></tr>`;
  }).join('');
  const sameTrace = a.trace.traceId === b.trace.traceId;
  el.innerHTML = `
    <div class="kv">
      大小：${a.outgoing.byteSize}B → ${b.outgoing.byteSize}B（${b.outgoing.byteSize - a.outgoing.byteSize >= 0 ? '+' : ''}${b.outgoing.byteSize - a.outgoing.byteSize}B）<br>
      成员：${a.outgoing.members.length} → ${b.outgoing.members.length}<br>
      trace：${sameTrace ? '同一 trace ' + esc(a.trace.traceId) : '<span class="minus">不同 trace（' + esc(a.trace.traceId.slice(0, 8)) + ' vs ' + esc(b.trace.traceId.slice(0, 8)) + '）</span>'}
    </div>
    <table class="member-table">
      <tr><th></th><th>key</th><th>#${a.hopNo} 出站值</th><th>#${b.hopNo} 出站值</th></tr>
      ${rows}
    </table>`;
}

// ---------- runs history ----------

async function refreshRunsList() {
  const el = $('#runsList');
  const data = await api('GET', '/api/runs');
  if (!data.runs.length) { el.innerHTML = '<p class="hint">暂无运行记录</p>'; return; }
  el.innerHTML = '';
  for (const r of [...data.runs].reverse()) {
    const div = document.createElement('div');
    div.className = 'runitem';
    div.innerHTML = `<b>${esc(r.runId)}</b> · ${esc(r.configName)} @ rev ${r.revision}
      ${r.stale ? '<span class="stale">（图已更新到 rev ' + r.headRevisionAtRun + '，此运行保留旧图结果）</span>' : ''}
      <div class="hint">${esc(r.resultHash.slice(0, 16))} · ${r.labels?.demo ? '示例' : ''}</div>`;
    div.addEventListener('click', async () => {
      const full = await api('GET', `/api/runs/${r.runId}`);
      state.run = full;
      state.selectedHop = full.result.hops[0]?.hopNo ?? null;
      renderAll();
      toast(`已载入 ${r.runId}（固定 rev ${r.revision}）`, 'ok');
    });
    el.appendChild(div);
  }
}

// ---------- demo ----------

async function loadDemo() {
  const rec = await api('GET', '/api/configs/sample');
  state.config = rec.config;
  state.revision = rec.revision;
  state.headRevision = rec.revision;
  $('#inConfig').value = JSON.stringify(rec.config, null, 2);
  $('#inExpectedRev').value = rec.revision;
  $('#inStart').value = 'edge-gateway';
  $('#inBaggage').value = [
    'user-id=u_42,tenant=acme,request-id=req-9f3c,session-id=s3cr3t-token,region=us-east',
    'auth_token=Bearer%20abc,User-Id=duplicate-casing,weird=%zz,emoji=%F0%9F%98%80,blob=' + 'A'.repeat(250),
  ].join('\n');
  $('#inTraceparent').value = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  $('#inTracestate').value = 'vendor1=value1,vendor2=value2';
  await doRun();
}

// ---------- boot ----------

$('#btnRun').addEventListener('click', doRun);
$('#btnSave').addEventListener('click', saveRevision);
$('#btnExport').addEventListener('click', exportRun);
$('#btnDemo').addEventListener('click', loadDemo);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doRun();
});

(async function init() {
  try {
    await loadHeadConfig('sample');
    await loadDemo();
  } catch (e) {
    toast('初始化失败：' + e.message, 'err');
  }
})();
