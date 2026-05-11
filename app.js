// ============================================================
// app.js — 메인 애플리케이션 로직
// ============================================================

// ── 상태 ─────────────────────────────────────────────────────
let state = {
  sheetDailyAvg: new Array(12).fill(null),
  sheetMemos:    new Array(12).fill(''),
  profitChart:   null,
  balanceChart:  null,
  scenarioRate:  0,
};

// ── 시나리오 전환 ─────────────────────────────────────────────
function setScenario(rate) {
  state.scenarioRate = rate;
  document.querySelectorAll('.sc-btn').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.rate) === rate);
  });
  const note = document.getElementById('scenarioNote');
  const baseRev = CONFIG.PLAN_REV_6_12;
  const adjRev  = Math.round(baseRev * (1 + rate / 100));
  if (rate === 0) {
    note.textContent = '기준: 광고비 평균 역산값 그대로';
  } else {
    note.textContent = `기준 ${fmt(baseRev)}만 → 조정 ${fmt(adjRev)}만원/월`;
  }
  renderAll();
}

// localStorage에서 설정 복원
function loadLocalSettings() {
  const saved = localStorage.getItem('rm_settings');
  if (saved) {
    const s = JSON.parse(saved);
    if (s.sheetId)    CONFIG.SHEET_ID    = s.sheetId;
    if (s.sheetName)  CONFIG.SHEET_NAME  = s.sheetName;
    if (s.sheetRange) CONFIG.SHEET_RANGE = s.sheetRange;
    if (s.naverRatio) CONFIG.NAVER_RATIO = s.naverRatio / 100;
    if (s.adRatio)    CONFIG.AD_RATIO    = s.adRatio / 100;
  }
  // UI 반영
  if (document.getElementById('sheetId')) {
    document.getElementById('sheetId').value    = CONFIG.SHEET_ID !== 'YOUR_SPREADSHEET_ID_HERE' ? CONFIG.SHEET_ID : '';
    document.getElementById('sheetName').value  = CONFIG.SHEET_NAME;
    document.getElementById('sheetRange').value = CONFIG.SHEET_RANGE;
    document.getElementById('naverRatio').value = Math.round(CONFIG.NAVER_RATIO * 100);
    document.getElementById('adRatio').value    = Math.round(CONFIG.AD_RATIO * 100);
  }
}

// ── Google Sheets CSV 패치 ────────────────────────────────────
async function fetchSheetData() {
  if (CONFIG.SHEET_ID === 'YOUR_SPREADSHEET_ID_HERE' || !CONFIG.SHEET_ID) {
    setSyncStatus('warning', '시트 ID 미설정');
    renderAll();
    return;
  }

  setSyncStatus('loading', '동기화 중...');

  const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CONFIG.SHEET_NAME)}&range=${CONFIG.SHEET_RANGE}&t=${Date.now()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    parseCSV(text);
    setSyncStatus('ok', `${now()} 업데이트`);
  } catch (e) {
    setSyncStatus('error', '연결 실패');
    console.error('Sheets fetch error:', e);
  }
  renderAll();
}

function parseCSV(csv) {
  console.log('[Sheets RAW]', csv.slice(0, 400));
  const lines = csv.trim().split('\n').slice(1);
  state.sheetDailyAvg = new Array(12).fill(null);
  state.sheetMemos    = new Array(12).fill('');

  lines.forEach(line => {
    if (!line.trim()) return;
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const monthStr = cols[0];
    const val      = parseFloat(cols[1]);
    const memo     = cols[2] || '';

    if (!monthStr) return;

    // 여러 형식 지원: "26-05", "2026-05-01", "2026-05-15" 등
    let monthIdx = null;
    const m1 = monthStr.match(/\d{2,4}-(\d{2})/);
    if (m1) monthIdx = parseInt(m1[1], 10) - 1;

    console.log('[Row]', monthStr, '->', monthIdx, 'val:', val);

    if (monthIdx !== null && monthIdx >= 0 && monthIdx < 12) {
      state.sheetDailyAvg[monthIdx] = isNaN(val) ? null : val;
      state.sheetMemos[monthIdx]    = memo;
    }
  });
  console.log('[Parsed sheetDailyAvg]', state.sheetDailyAvg);
}

// ── 핵심 계산 ─────────────────────────────────────────────────
function calcRows() {
  const rows = [];
  let balance = 0;

  for (let i = 0; i < 12; i++) {
    const fixed = CONFIG.COSTS.fixed[i];
    const order = CONFIG.COSTS.order[i];
    const ad    = CONFIG.COSTS.ad[i];
    const other = CONFIG.COSTS.other[i];

    let revenue, basis, dailyTarget;

    if (i < 4) {
      // 1~4월: 확정 실적
      revenue     = CONFIG.ACTUAL.revenue[i];
      basis       = '확정실적';
      dailyTarget = null;
    } else if (i === 4) {
      // 5월: 시트 입력값 우선, 없으면 0
      const d = state.sheetDailyAvg[4];
      if (d && d > 0) {
        revenue = Math.round((d * CONFIG.DAYS[4]) / CONFIG.NAVER_RATIO);
        basis   = `일평균 ${fmt(d)}만원`;
      } else {
        revenue = 0;
        basis   = '미입력';
      }
      dailyTarget = null;
    } else {
      // 6~12월: 시트 입력값 있으면 우선, 없으면 광고비 역산 + 시나리오 적용
      const sheetD = state.sheetDailyAvg[i];
      const factor = 1 + state.scenarioRate / 100;
      let basisTag;

      if (sheetD && sheetD > 0) {
        // 시트에 일평균 입력된 경우
        const adjustedDaily = Math.round(sheetD * factor);
        revenue  = Math.round((adjustedDaily * CONFIG.DAYS[i]) / CONFIG.NAVER_RATIO);
        basisTag = `시트입력 ${fmt(sheetD)}만${state.scenarioRate !== 0 ? '×(1' + state.scenarioRate + '%)' : ''}`;
      } else {
        // 시트 미입력 → 광고비 역산
        revenue  = Math.round(CONFIG.PLAN_REV_6_12 * factor);
        basisTag = `광고비역산${state.scenarioRate !== 0 ? '(' + state.scenarioRate + '%)' : ''}`;
      }

      const adCost    = Math.round(revenue * CONFIG.AD_RATIO);
      dailyTarget     = Math.round((revenue * CONFIG.NAVER_RATIO) / CONFIG.DAYS[i]);
      basis           = `${basisTag} · 목표 ${fmt(dailyTarget)}만원/일`;

      const fixedM    = CONFIG.COSTS.fixed[i];
      const orderM    = CONFIG.COSTS.order[i];
      const otherM    = CONFIG.COSTS.other[i];
      const totalCost = fixedM + orderM + adCost + otherM;
      const profit    = revenue - totalCost;
      balance        += profit;

      rows.push({
        idx: i,
        month: CONFIG.MONTH_LABELS[i],
        isActual: false, isMay: false, isPlan: true,
        revenue, fixed: fixedM, order: orderM, ad: adCost, other: otherM,
        totalCost, profit, balance, basis,
        dailyTarget,
        memo: state.sheetMemos[i] || '',
        sheetDaily: sheetD,
      });
      continue;
    }

    const totalCost = fixed + order + ad + other;
    const profit    = revenue - totalCost;
    balance        += profit;

    rows.push({
      idx: i,
      month: CONFIG.MONTH_LABELS[i],
      isActual: i < 4,
      isMay:    i === 4,
      isPlan:   i >= 5,
      revenue, fixed, order, ad, other,
      totalCost, profit, balance, basis,
      dailyTarget,
      memo: state.sheetMemos[i] || '',
      sheetDaily: state.sheetDailyAvg[i],
    });
  }
  return rows;
}

function findTurnovers(rows) {
  let profitMonth = null, balanceMonth = null;
  for (let i = 4; i < rows.length; i++) {
    if (!profitMonth  && rows[i].profit  > 0) profitMonth  = rows[i].month;
    if (!balanceMonth && rows[i].balance > 0) balanceMonth = rows[i].month;
  }
  return { profitMonth, balanceMonth };
}

// ── 렌더링 ────────────────────────────────────────────────────
function renderAll() {
  const rows = calcRows();
  const { profitMonth, balanceMonth } = findTurnovers(rows);

  renderKPI(rows, profitMonth, balanceMonth);
  renderTurnoverBanner(profitMonth, balanceMonth);
  renderCharts(rows);
  renderTargetTable(rows);
  renderTable(rows);

  document.getElementById('lastUpdated').textContent =
    `마지막 업데이트: ${now()} · 1~4월 확정, 5월 시트 입력, 6~12월 광고비 역산`;
}

function renderKPI(rows, profitMonth, balanceMonth) {
  const may = rows[4];
  const totalRevForecast = rows.slice(4).reduce((s, r) => s + r.revenue, 0);
  const totalProfit12 = rows.reduce((s, r) => s + r.profit, 0);
  const endBalance = rows[11].balance;

  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">5월 예상 전체매출</div>
      <div class="kpi-value">${may.revenue > 0 ? fmt(may.revenue) + '만' : '미입력'}</div>
      <div class="kpi-sub">${may.sheetDaily ? `일평균 ${fmt(may.sheetDaily)}만원 기준` : '시트에 5월 일평균 입력 필요'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">5~12월 누적 매출 예상</div>
      <div class="kpi-value">${fmt(Math.round(totalRevForecast / 10000))}억</div>
      <div class="kpi-sub">${fmt(totalRevForecast)}만원</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">영업이익 흑자 전환</div>
      <div class="kpi-value ${profitMonth ? 'positive' : 'negative'}">${profitMonth || '미전환'}</div>
      <div class="kpi-sub">${profitMonth ? '이달부터 흑자 예상' : '12월까지 흑자 전환 없음'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">기말잔액 플러스 전환</div>
      <div class="kpi-value ${balanceMonth ? 'info' : 'negative'}">${balanceMonth || '미전환'}</div>
      <div class="kpi-sub">${balanceMonth ? '이달부터 누적 흑자' : '12월까지 누적 적자'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">12월말 예상 기말잔액</div>
      <div class="kpi-value ${endBalance >= 0 ? 'positive' : 'negative'}">${fmtSign(endBalance)}만</div>
      <div class="kpi-sub">연간 누적 기준</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">연간 영업이익 합계</div>
      <div class="kpi-value ${totalProfit12 >= 0 ? 'positive' : 'negative'}">${fmtSign(Math.round(totalProfit12))}만</div>
      <div class="kpi-sub">1~12월 전체</div>
    </div>
  `;
}

function renderTurnoverBanner(profitMonth, balanceMonth) {
  const el = document.getElementById('turnoverBanner');
  el.innerHTML = `
    <div class="banner-item ${profitMonth ? 'banner-green' : 'banner-red'}">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
      영업이익 흑자 전환: <strong>${profitMonth ? profitMonth + ' 예상' : '12월까지 미전환'}</strong>
    </div>
    <div class="banner-item ${balanceMonth ? 'banner-blue' : 'banner-red'}">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
      기말잔액 플러스 전환: <strong>${balanceMonth ? balanceMonth + ' 예상' : '12월까지 미전환'}</strong>
    </div>
    <div class="banner-item banner-gray">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      6~12월 매출: 1~4월 평균 광고비 ${fmt(CONFIG.AVG_AD)}만원 ÷ 25% = <strong>월 ${fmt(CONFIG.PLAN_REV_6_12)}만원</strong>
    </div>
  `;
}

function renderCharts(rows) {
  const labels = CONFIG.MONTH_LABELS;
  const profitData  = rows.map(r => Math.round(r.profit));
  const balanceData = rows.map(r => Math.round(r.balance));

  const profitColors = profitData.map((v, i) =>
    i < 4 ? '#64748b' : v >= 0 ? '#22c55e' : '#ef4444'
  );
  const balanceColors = balanceData.map((v, i) =>
    i < 4 ? '#64748b' : v >= 0 ? '#3b82f6' : '#ef4444'
  );

  if (state.profitChart)  state.profitChart.destroy();
  if (state.balanceChart) state.balanceChart.destroy();

  const commonOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 11, family: 'DM Mono' }, color: '#64748b', autoSkip: false, maxRotation: 0 }
      },
      y: {
        grid: { color: 'rgba(100,116,139,0.1)' },
        ticks: { font: { size: 10, family: 'DM Mono' }, color: '#64748b', callback: v => fmt(v) }
      }
    }
  };

  state.profitChart = new Chart(document.getElementById('profitChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: profitData,
        backgroundColor: profitColors,
        borderRadius: 4,
        borderSkipped: false,
      }]
    },
    options: {
      ...commonOpts,
      plugins: {
        ...commonOpts.plugins,
        tooltip: {
          callbacks: {
            label: ctx => {
              const r = rows[ctx.dataIndex];
              const lines = [`영업이익: ${fmtSign(ctx.raw)}만원`];
              if (r.memo) lines.push(`메모: ${r.memo}`);
              return lines;
            }
          }
        }
      }
    }
  });

  state.balanceChart = new Chart(document.getElementById('balanceChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: balanceData,
        backgroundColor: balanceColors,
        borderRadius: 4,
        borderSkipped: false,
      }]
    },
    options: {
      ...commonOpts,
      plugins: {
        ...commonOpts.plugins,
        tooltip: { callbacks: { label: ctx => `기말잔액: ${fmtSign(ctx.raw)}만원` } }
      }
    }
  });
}

function renderTargetTable(rows) {
  const planRows = rows.filter(r => r.isPlan);
  document.getElementById('targetTable').innerHTML = planRows.map(r => `
    <div class="target-item">
      <span class="target-mon">${r.month}</span>
      <span class="target-days">${CONFIG.DAYS[r.idx]}일</span>
      <span class="target-val">${fmt(r.dailyTarget)}만원/일</span>
      ${r.sheetDaily ? `<span class="target-actual">실입력: ${fmt(r.sheetDaily)}만원
        <span class="target-diff ${r.sheetDaily >= r.dailyTarget ? 'diff-pos' : 'diff-neg'}">
          ${r.sheetDaily >= r.dailyTarget ? '▲' : '▼'}${fmt(Math.abs(r.sheetDaily - r.dailyTarget))}
        </span>
      </span>` : '<span class="target-actual muted">미입력</span>'}
    </div>
  `).join('');
}

function renderTable(rows) {
  document.getElementById('tableBody').innerHTML = rows.map(r => `
    <tr class="${r.isActual ? 'row-actual' : r.isMay ? 'row-may' : 'row-plan'}">
      <td>
        ${r.month}
        <span class="tbadge ${r.isActual ? 'tbadge-act' : r.isMay ? 'tbadge-may' : 'tbadge-plan'}">
          ${r.isActual ? '확정' : r.isMay ? '일평균' : '역산'}
        </span>
      </td>
      <td class="num">${fmt(r.revenue)}</td>
      <td class="num">${fmt(r.fixed)}</td>
      <td class="num">${fmt(r.order)}</td>
      <td class="num">${fmt(r.ad)}</td>
      <td class="num">${fmt(r.other)}</td>
      <td class="num">${fmt(r.totalCost)}</td>
      <td class="num ${r.profit >= 0 ? 'pos' : 'neg'}">${fmtSign(r.profit)}</td>
      <td class="num ${r.balance >= 0 ? 'info' : 'neg'}">${fmtSign(r.balance)}</td>
      <td class="basis-cell">${r.basis}</td>
    </tr>
  `).join('');
}

// ── 설정 저장 ─────────────────────────────────────────────────
function saveSettings() {
  const sheetId    = document.getElementById('sheetId').value.trim();
  const sheetName  = document.getElementById('sheetName').value.trim() || '매출데이터';
  const sheetRange = document.getElementById('sheetRange').value.trim() || 'A1:C13';

  CONFIG.SHEET_ID    = sheetId;
  CONFIG.SHEET_NAME  = sheetName;
  CONFIG.SHEET_RANGE = sheetRange;

  localStorage.setItem('rm_settings', JSON.stringify({
    sheetId, sheetName, sheetRange,
    naverRatio: Math.round(CONFIG.NAVER_RATIO * 100),
    adRatio:    Math.round(CONFIG.AD_RATIO * 100),
  }));

  fetchSheetData();
}

function saveRatios() {
  const naverRatio = parseFloat(document.getElementById('naverRatio').value) || 68;
  const adRatio    = parseFloat(document.getElementById('adRatio').value) || 25;

  CONFIG.NAVER_RATIO = naverRatio / 100;
  CONFIG.AD_RATIO    = adRatio / 100;

  // 평균 광고비 역산값 재계산
  CONFIG.PLAN_REV_6_12 = Math.round(CONFIG.AVG_AD / CONFIG.AD_RATIO);

  const saved = JSON.parse(localStorage.getItem('rm_settings') || '{}');
  localStorage.setItem('rm_settings', JSON.stringify({ ...saved, naverRatio, adRatio }));

  renderAll();
  alert(`저장 완료: 자사몰+네이버 비중 ${naverRatio}%, 광고비 비중 ${adRatio}%`);
}

// ── 탭 전환 ───────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');
  });
});

// ── 유틸 ──────────────────────────────────────────────────────
function fmt(v) {
  if (v === null || v === undefined) return '-';
  const abs = Math.abs(Math.round(v));
  return (v < 0 ? '-' : '') + abs.toLocaleString('ko-KR');
}
function fmtSign(v) {
  if (v === null || v === undefined) return '-';
  v = Math.round(v);
  return (v > 0 ? '+' : '') + v.toLocaleString('ko-KR');
}
function now() {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
function setSyncStatus(type, text) {
  const dot  = document.getElementById('syncDot');
  const span = document.getElementById('syncText');
  dot.className  = 'sync-dot sync-' + type;
  span.textContent = text;
}

// ── 자동 새로고침 (5분) ───────────────────────────────────────
setInterval(fetchSheetData, 5 * 60 * 1000);

// ── 초기화 ───────────────────────────────────────────────────
loadLocalSettings();
fetchSheetData();
