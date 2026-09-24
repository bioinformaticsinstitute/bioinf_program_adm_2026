const COLORS = {
  blue: '#3A81E8',
  darkBlue: '#2D528A',
  gray: '#3C3C50',
  muted: '#9FA8B8',
  pale: '#DDEBFC',
  paleBlue: '#A8C9F5'
};

const charts = {};
let DATA = null;
let cityMap = null;
let cityPopup = null;
let pendingCityPoints = [];

Chart.defaults.font.family = 'Open Sans, Arial, sans-serif';
Chart.defaults.color = '#596174';
Chart.defaults.borderColor = '#E6EAF0';

function formatNumber(v) {
  return new Intl.NumberFormat('ru-RU').format(v);
}
function formatDecimal(v) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v);
}
function values(series) { return series.map(d => d.value); }
function labels(series) { return series.map(d => d.label); }
function destroy(name) { if (charts[name]) charts[name].destroy(); }

function tooltipCountPercent(context) {
  const dataset = context.dataset.data;
  const total = dataset.reduce((a, b) => a + Number(b), 0);
  const p = total ? (Number(context.raw) / total * 100).toFixed(1).replace('.', ',') : '0';
  return `${context.label}: ${formatNumber(context.raw)} (${p}%)`;
}

function barChart(name, canvasId, series, opts = {}) {
  destroy(name);
  const ctx = document.getElementById(canvasId);
  charts[name] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels(series),
      datasets: [{
        data: values(series),
        backgroundColor: opts.color || COLORS.blue,
        borderRadius: 5,
        borderSkipped: false,
        maxBarThickness: opts.maxBarThickness || 32
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: opts.horizontal === false ? 'x' : 'y',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: tooltipCountPercent } }
      },
      scales: opts.horizontal === false ? {
        x: { grid: { display: false }, ticks: { autoSkip: false, font: { size: opts.tickSize || 10 } } },
        y: { beginAtZero: true, grid: { color: '#EEF1F5' }, ticks: { precision: 0, font: { size: 10 } } }
      } : {
        x: { beginAtZero: true, grid: { color: '#EEF1F5' }, ticks: { precision: 0, font: { size: 10 } } },
        y: { grid: { display: false }, ticks: { autoSkip: false, font: { size: opts.tickSize || 10 } } }
      }
    }
  });
}

function doughnutChart(name, canvasId, series, colors = [COLORS.blue, COLORS.darkBlue]) {
  destroy(name);
  const ctx = document.getElementById(canvasId);
  charts[name] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: labels(series), datasets: [{ data: values(series), backgroundColor: colors, borderWidth: 0, hoverOffset: 5 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '64%',
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', padding: 10, boxWidth: 7, font: { size: 9 } } },
        tooltip: { callbacks: { label: tooltipCountPercent } }
      }
    }
  });
}

function renderStages() {
  const holder = document.getElementById('stageFlow');
  const series = DATA.funnel;
  const parts = [];
  series.forEach((item, index) => {
    parts.push(`
      <div class="stage-card">
        <strong>${formatNumber(item.value)}</strong>
        <span>${item.label}</span>
      </div>`);
    if (index < series.length - 1) {
      const next = series[index + 1];
      const pct = item.value ? (next.value / item.value * 100) : 0;
      parts.push(`
        <div class="stage-link" aria-label="${formatDecimal(pct)} процента переходят к следующему этапу">
          <b>${formatDecimal(pct)}%</b><i></i>
        </div>`);
    }
  });
  holder.innerHTML = parts.join('');
}

function initCityMap() {
  cityMap = new maplibregl.Map({
    container: 'cityMap',
    center: [47, 49], // MapLibre uses [longitude, latitude].
    zoom: 2,
    minZoom: 1,
    maxZoom: 4,
    renderWorldCopies: true,
    style: 'https://tiles.openfreemap.org/styles/positron'
  });
  cityMap.scrollZoom.disable();
  cityMap.addControl(new maplibregl.NavigationControl(), 'top-right');

  cityMap.on('load', () => {
    // Borders are separate vector layers in this style. Hide them before adding city data.
    cityMap.getStyle().layers.forEach(layer => {
      const sourceLayer = layer['source-layer'] || '';
      if (layer.type === 'line' &&
          (sourceLayer === 'boundary' || /boundary|admin/i.test(layer.id))) {
        cityMap.setLayoutProperty(layer.id, 'visibility', 'none');
      }
    });

    cityMap.addSource('cities', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    cityMap.addLayer({
      id: 'city-circles',
      type: 'circle',
      source: 'cities',
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': COLORS.blue,
        'circle-opacity': 0.74,
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 1.4
      }
    });

    function showCity(event) {
      const feature = event.features && event.features[0];
      if (!feature) return;
      const content = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = feature.properties.city;
      content.append(name, document.createElement('br'),
        document.createTextNode(`${formatNumber(feature.properties.count)} чел.`));
      if (cityPopup) cityPopup.remove();
      cityPopup = new maplibregl.Popup({ closeButton: false, offset: 12, className: 'city-tooltip' })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(content)
        .addTo(cityMap);
    }

    cityMap.on('mouseenter', 'city-circles', event => {
      cityMap.getCanvas().style.cursor = 'pointer';
      showCity(event);
    });
    cityMap.on('mouseleave', 'city-circles', () => {
      cityMap.getCanvas().style.cursor = '';
      if (cityPopup) cityPopup.remove();
      cityPopup = null;
    });
    cityMap.on('click', 'city-circles', showCity); // Also works on touch devices.
    renderCityMap(pendingCityPoints);
  });

  if (window.ResizeObserver) {
    const mapEl = document.getElementById('cityMap');
    const ro = new ResizeObserver(() => window.requestAnimationFrame(() => cityMap.resize()));
    ro.observe(mapEl);
  }
  window.addEventListener('resize', () => window.requestAnimationFrame(() => cityMap.resize()), { passive: true });
}

function renderCityMap(points) {
  pendingCityPoints = points;
  if (!cityMap) initCityMap();
  const source = cityMap.getSource('cities');
  if (!source) return; // The load handler renders the latest selection.

  if (cityPopup) cityPopup.remove();
  cityPopup = null;
  source.setData({
    type: 'FeatureCollection',
    features: points.map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        city: p.city,
        count: p.count,
        radius: Math.min(32, 4 + Math.sqrt(p.count) * 2.2)
      }
    }))
  });

  if (points.length > 1) {
    const bounds = new maplibregl.LngLatBounds();
    points.forEach(p => bounds.extend([p.lng, p.lat]));
    cityMap.fitBounds(bounds, { padding: 24, maxZoom: 4, duration: 0 });
  } else if (points.length === 1) {
    cityMap.jumpTo({ center: [points[0].lng, points[0].lat], zoom: 4 });
  } else {
    cityMap.jumpTo({ center: [47, 49], zoom: 2 });
  }
  window.requestAnimationFrame(() => cityMap.resize());
}

function subtractSeries(allSeries, subsetSeries) {
  const subset = new Map(subsetSeries.map(d => [d.label, Number(d.value)]));
  return allSeries
    .map(d => ({ label: d.label, value: Math.max(0, Number(d.value) - (subset.get(d.label) || 0)) }))
    .filter(d => d.value > 0);
}

function notAllowedCohort() {
  const all = DATA.cohorts.all;
  const allowed = DATA.cohorts.allowed;
  const allowedCities = new Map(allowed.city_points.map(p => [p.city, p.count]));
  return {
    n: all.n - allowed.n,
    city_points: all.city_points
      .map(p => ({ ...p, count: Math.max(0, p.count - (allowedCities.get(p.city) || 0)) }))
      .filter(p => p.count > 0),
    study_status: subtractSeries(all.study_status, allowed.study_status),
    grad_group: subtractSeries(all.grad_group, allowed.grad_group),
    prior: subtractSeries(all.prior, allowed.prior)
  };
}

function renderCohort(key) {
  const c = key === 'not_allowed' ? notAllowedCohort() : DATA.cohorts[key];
  document.getElementById('cohortN').textContent = formatNumber(c.n);
  renderCityMap(c.city_points);
  doughnutChart('prior', 'priorChart', c.prior, [COLORS.blue, COLORS.darkBlue]);
  barChart('study', 'studyChart', c.study_status, { color: COLORS.darkBlue, maxBarThickness: 25, tickSize: 8.5 });
  barChart('grad', 'gradChart', c.grad_group, { horizontal: false, color: COLORS.blue, maxBarThickness: 30, tickSize: 8.5 });
}

function renderCourseChart() {
  barChart('course', 'courseChart', DATA.overall.course_score, { horizontal: false, color: COLORS.darkBlue, maxBarThickness: 50, tickSize: 10 });
}

function blockShortLabel(label) {
  if (label.startsWith('Молекулярная')) return ['Молекулярная', 'биология'];
  if (label === 'Статистика и R') return ['Статистика', 'и R'];
  return label;
}

const valueLabelsPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#596174';
    ctx.font = '600 10px Open Sans, Arial, sans-serif';
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      meta.data.forEach((bar, i) => {
        const value = Number(dataset.data[i]);
        const y = Math.max(bar.y - 6, chartArea.top + 11);
        ctx.fillText(`${formatDecimal(value)}%`, bar.x, y);
      });
    });
    ctx.restore();
  }
};

function renderBlockComparison(key) {
  destroy('blocks');
  const labelsOrder = DATA.testing.all.blocks.map(b => b.label);
  let datasets;

  if (key === 'all') {
    datasets = ['v1', 'v2'].map((v, index) => {
      const stat = DATA.testing[v];
      return {
        label: stat.title,
        data: labelsOrder.map(lbl => stat.blocks.find(b => b.label === lbl).median_pct),
        backgroundColor: index === 0 ? COLORS.darkBlue : COLORS.blue,
        borderRadius: 6,
        borderSkipped: false,
        maxBarThickness: 30
      };
    });
  } else {
    const stat = DATA.testing[key];
    datasets = [{
      label: stat.title,
      data: labelsOrder.map(lbl => stat.blocks.find(b => b.label === lbl).median_pct),
      backgroundColor: key === 'v1' ? COLORS.darkBlue : COLORS.blue,
      borderRadius: 6,
      borderSkipped: false,
      maxBarThickness: 44
    }];
  }

  charts.blocks = new Chart(document.getElementById('blockChart'), {
    type: 'bar',
    data: { labels: labelsOrder.map(blockShortLabel), datasets },
    plugins: [valueLabelsPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { display: key === 'all', position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, font: { size: 10 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${formatDecimal(ctx.raw)}%` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9.5 } } },
        y: { beginAtZero: true, max: 100, grid: { color: '#EEF1F5' }, ticks: { callback: v => `${v}%`, font: { size: 9.5 } } }
      }
    }
  });
}

function renderTestDistribution(stat, key) {
  destroy('testScore');
  charts.testScore = new Chart(document.getElementById('testScoreChart'), {
    type: 'bar',
    data: {
      labels: stat.score_distribution.map(d => d.label),
      datasets: [{
        label: 'Число участников',
        data: stat.score_distribution.map(d => d.value),
        backgroundColor: key === 'v1' ? COLORS.darkBlue : (key === 'v2' ? COLORS.blue : COLORS.paleBlue),
        borderRadius: 2,
        borderSkipped: false,
        maxBarThickness: 18
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${formatNumber(ctx.raw)} чел.` } } },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 12, font: { size: 9.5 } }, title: { display: true, text: 'Общий балл', font: { size: 10, weight: '600' } } },
        y: { beginAtZero: true, grid: { color: '#EEF1F5' }, ticks: { precision: 0, font: { size: 9.5 } }, title: { display: true, text: 'Число участников', font: { size: 10, weight: '600' } } }
      }
    }
  });
}

function renderTesting(key) {
  const stat = DATA.testing[key];
  document.getElementById('testVariantN').textContent = formatNumber(stat.n);
  document.getElementById('testMean').textContent = formatDecimal(stat.mean_total);
  document.getElementById('testPassing').textContent = formatDecimal(stat.passing_score);
  document.getElementById('testVariantCaption').textContent = key === 'all' ? 'Все варианты' : `${stat.title} · ${stat.date}`;
  renderTestDistribution(stat, key);
  renderBlockComparison(key);
  document.querySelectorAll('.segment').forEach(btn => btn.classList.toggle('active', btn.dataset.variant === key));
}

function renderKpis() {
  const k = DATA.kpis;
  const all = DATA.cohorts.all;
  const prior = all.prior.find(d => d.label === 'Пробовал поступать раньше');
  const course170 = DATA.overall.course_score.reduce((sum, d) => {
    const lower = Number(String(d.label).match(/^\d+/)?.[0] || 0);
    return sum + (lower >= 170 ? Number(d.value) : 0);
  }, 0);
  const competition = k.accepted ? k.applications_unique / k.accepted : 0;

  document.getElementById('kpiApplications').textContent = formatNumber(k.applications_unique);
  document.getElementById('kpiCities').textContent = formatNumber(all.city_points.length);
  document.getElementById('kpiPrior').textContent = formatNumber(prior ? prior.value : 0);
  document.getElementById('kpiCompetition').textContent = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(competition);
  document.getElementById('kpiCourse170').textContent = formatNumber(224);
  document.getElementById('kpiTests').textContent = formatNumber(k.test_completed_unique);
  document.getElementById('kpiAllowed').textContent = formatNumber(k.interview_allowed_unique);
  document.getElementById('courseN').textContent = formatNumber(k.course_scores_available);
}

async function init() {
  try {
    const response = await fetch('./data/admissions.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    DATA = await response.json();

    renderKpis();
    renderStages();
    renderCourseChart();
    renderCohort('all');
    renderTesting('all');

    document.getElementById('cohortSelect').addEventListener('change', e => renderCohort(e.target.value));
    document.querySelectorAll('.segment').forEach(btn => btn.addEventListener('click', () => renderTesting(btn.dataset.variant)));
  } catch (error) {
    console.error(error);
  }
}

document.addEventListener('DOMContentLoaded', init);
