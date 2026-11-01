import { escapeHTML } from './escape.js';
import { refreshIcons as renderIcons } from './icons.js';

const branches = ['Guadalajara', 'Zapopan', 'León', 'Querétaro', 'Aguascalientes'];
const pageNames = {
  inicio: 'Inicio',
  inventario: 'Inventario inteligente',
  facturas: 'Revisión de facturas',
  reclamaciones: 'Atención de reclamaciones',
  asistente: 'Asistente IA',
  documentacion: 'Documentación',
  responsable: 'IA responsable',
  acerca: 'Acerca del proyecto',
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name) => `<i data-lucide="${name}"></i>`;
const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
let dataOrigin = sessionStorage.getItem('rioclaro-data-origin') || 'practice';
let products = [];
let searchedProducts = null;
let productSearchRequest = 0;
let invoices = [];
let complaints = [];
let complaintListRequest = 0;
let complaintDetailRequest = 0;
let dashboard = null;
let salesReport = null;
let dataLoadRequest = 0;
let requestPending = false;
let editingProductId = null;
let chatRecognition = null;
let chatListening = false;
let chatRecognitionCancelled = false;
let evaluationMode = false;
let chatEnabled = false;
let practiceWritesEnabled = false;
let conversationId = sessionStorage.getItem('rioclaro-chat-conversation');
let chatHistory = [];
const chatSessionId = sessionStorage.getItem('rioclaro-chat-session') || crypto.randomUUID();
sessionStorage.setItem('rioclaro-chat-session', chatSessionId);

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'X-Data-Origin': dataOrigin,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error('No fue posible contactar al servidor. Verifica que la aplicación esté ejecutándose.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `No se pudo completar la solicitud (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function refreshIcons() {
  renderIcons();
}

function updateStatus(element, label, state, dotClass = 'connection-dot') {
  element.replaceChildren();
  const dot = document.createElement('span');
  dot.className = `${dotClass} ${state}`;
  element.append(dot, document.createTextNode(label));
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  $('#toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function navigate(page) {
  if (!pageNames[page]) return;
  if (page !== 'asistente' && chatListening) stopChatRecognition(true);
  $$('.page-view').forEach((view) => view.classList.toggle('active', view.id === `page-${page}`));
  $$('.nav-link').forEach((link) => {
    const active = link.dataset.page === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#breadcrumb-current').textContent = pageNames[page];
  $('#sidebar').classList.remove('open');
  $('#menu-button').setAttribute('aria-expanded', 'false');
  if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  if (page === 'reclamaciones') void loadComplaints();
}

function renderDashboard() {
  if (!dashboard) return;
  $('#dashboard-date').textContent = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date()).toLocaleUpperCase('es-MX');
  $('#stat-products').textContent = dashboard.productCount;
  $('#stat-invoices').textContent = dashboard.invoiceCount;
  $('#stat-alerts').textContent = dashboard.pendingAlerts;
  const activityText = (text) => text.trim();
  const maximum = Math.max(1, ...dashboard.branches.map((branch) => branch.products));
  $('#branch-list').innerHTML = dashboard.branches.map((branch) => `
    <div class="branch-row"><span>${escapeHTML(branch.name)}</span><progress class="branch-progress" value="${branch.products}" max="${maximum}" aria-label="${escapeHTML(branch.name)}: ${branch.products} productos"></progress><span class="branch-count">${branch.products}</span></div>`).join('');
  $('#activity-list').innerHTML = dashboard.recentActivity.map((item) => `
    <div class="activity-item"><span class="activity-marker"></span><div><strong>${escapeHTML(activityText(item.title))}</strong><small>${escapeHTML(activityText(item.detail))}</small></div></div>`).join('');
  refreshIcons();
}

function isoDate(date) {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
    .toISOString()
    .slice(0, 10);
}

function renderSalesReport(report) {
  salesReport = report;
  $('#sales-total-revenue').textContent = money.format(report.totalRevenue);
  $('#sales-total-orders').textContent = report.totalOrders;
  $('#sales-total-units').textContent = report.totalUnits;
  $('#sales-average-order').textContent = money.format(report.averageOrderValue);
  $('#sales-report-status').textContent = report.message;
  const maximumRevenue = Math.max(1, ...report.branches.map(({ revenue }) => revenue));
  $('#sales-branch-list').innerHTML = report.branches.length
    ? report.branches.map((item) => `
      <div class="sales-bar-row"><span>${escapeHTML(item.branch)}</span><progress max="${maximumRevenue}" value="${item.revenue}" aria-label="${escapeHTML(item.branch)}: ${money.format(item.revenue)}"></progress><strong>${money.format(item.revenue)}</strong><small>${item.orders} ventas</small></div>`).join('')
    : '<p class="empty-state">No hay ventas sintéticas para mostrar.</p>';
  $('#sales-product-list').innerHTML = report.topProducts.length
    ? report.topProducts.map((item) => `<li><span>${escapeHTML(item.name)}</span><strong>${item.units} unidades</strong></li>`).join('')
    : '<li class="empty-state">No hay productos vendidos en este periodo.</li>';
  const maximumDailyRevenue = Math.max(1, ...report.dailyTrend.map(({ revenue }) => revenue));
  $('#sales-trend-list').innerHTML = report.dailyTrend.length
    ? report.dailyTrend.map((item) => `
      <div class="sales-trend-row"><time datetime="${escapeHTML(item.date)}">${escapeHTML(item.date)}</time><progress max="${maximumDailyRevenue}" value="${item.revenue}" aria-label="${escapeHTML(item.date)}: ${money.format(item.revenue)}"></progress><strong>${money.format(item.revenue)}</strong></div>`).join('')
    : '<p class="empty-state">No hay datos para calcular una tendencia.</p>';
  $('#sales-ai-summary').disabled = !chatEnabled || !report.dataAvailable;
  refreshIcons();
}

async function loadSalesReport() {
  const from = $('#sales-from').value;
  const to = $('#sales-to').value;
  if (!from || !to) return;
  const query = new URLSearchParams({ from, to });
  if ($('#sales-branch').value) query.set('branch', $('#sales-branch').value);
  $('#sales-report-status').textContent = 'Calculando el reporte con datos sintéticos…';
  $('#sales-report').setAttribute('aria-busy', 'true');
  try {
    const report = await api(`/api/sales?${query}`);
    renderSalesReport(report);
  } catch (error) {
    $('#sales-report-status').textContent = error.message;
    $('#sales-total-revenue').textContent = '—';
    $('#sales-total-orders').textContent = '—';
    $('#sales-total-units').textContent = '—';
    $('#sales-average-order').textContent = '—';
    $('#sales-branch-list').replaceChildren();
    $('#sales-product-list').replaceChildren();
    $('#sales-trend-list').replaceChildren();
  } finally {
    $('#sales-report').setAttribute('aria-busy', 'false');
  }
}

async function requestSalesSummary() {
  if (!salesReport || !chatEnabled || requestPending) return;
  const query = new URLSearchParams({
    from: salesReport.from,
    to: salesReport.to,
  });
  if (salesReport.branch) query.set('branch', salesReport.branch);
  const button = $('#sales-ai-summary');
  button.disabled = true;
  $('#sales-ai-summary-text').textContent = 'Solicitando interpretación a RioClaroAssistant…';
  try {
    const result = await api(`/api/sales/summary?${query}`, {
      method: 'POST',
      headers: { 'X-Chat-Session': chatSessionId },
      body: JSON.stringify(conversationId ? { conversationId } : {}),
    });
    $('#sales-ai-summary-text').textContent = `${result.summary} Revisión humana requerida; cifras calculadas por el servidor.`;
    if (result.conversationId) {
      conversationId = result.conversationId;
      sessionStorage.setItem('rioclaro-chat-conversation', conversationId);
    }
  } catch (error) {
    $('#sales-ai-summary-text').textContent = error.message;
  } finally {
    button.disabled = !chatEnabled || !salesReport?.dataAvailable;
  }
}

function stockState(stock) {
  if (stock === 0) return ['Sin existencias', 'status-empty'];
  if (stock <= 10) return ['Existencia baja', 'status-low'];
  return ['Disponible', 'status-ok'];
}

function renderProducts() {
  const category = $('#category-filter').value;
  const branch = $('#branch-filter').value;
  const catalog = searchedProducts ?? products;
  const visible = catalog.flatMap((product) => {
    const branchStocks = product.branches ?? [{ name: product.branch, stock: product.stock }];
    const matchingBranches = branch
      ? branchStocks.filter((item) => item.name === branch)
      : branchStocks;
    if (!matchingBranches.length || (category && product.category !== category)) return [];
    return [{
      ...product,
      branch: branch || (matchingBranches.length > 1 ? 'Varias sucursales' : matchingBranches[0].name),
      branches: matchingBranches,
      ...(matchingBranches.length === 1 ? { stock: matchingBranches[0].stock } : { stock: undefined }),
    }];
  });
  $('#product-count').textContent = `${visible.length} de ${searchedProducts ? visible.length : products.length} productos`;
  $('#product-rows').innerHTML = visible.length ? visible.map((product) => {
    const singleStock = product.branches.length === 1 ? product.branches[0].stock : null;
    const [label, state] = singleStock === null
      ? ['Separada por sucursal', 'status-ok']
      : stockState(singleStock);
    const stock = product.branches.length === 1
      ? `<span class="stock-value">${singleStock}</span> <span class="stock-unit">unid.</span>`
      : product.branches.map((item) =>
        `<span class="branch-stock">${escapeHTML(item.name)}: <strong>${item.stock}</strong></span>`,
      ).join('');
    const review = product.reviewRequired ? '<span class="review-pill review-needed">Revisión humana</span>' : '';
    const editable = evaluationMode
      && product.sourceIds?.length === 1
      && product.id === product.sourceIds[0]
      && product.normalizationStatus === 'normalized'
      && !product.reviewRequired;
    const editAction = editable
      ? `<button class="button button-secondary" type="button" data-edit-product-id="${product.sourceIds[0]}" aria-label="Editar ${escapeHTML(product.name)}">Editar</button>`
      : '';
    const deleteAction = evaluationMode
      ? `<button class="button button-secondary product-delete-button" type="button" data-delete-product-id="${product.id}" aria-label="Eliminar ${escapeHTML(product.name)}">Eliminar</button>`
      : '';
    return `<tr><td><span class="product-name"><span class="product-mini-icon">${icon('package')}</span>${escapeHTML(product.name)}</span>${review}</td><td>${escapeHTML(product.category)}</td><td><span class="branch-tag">${escapeHTML(product.branch)}</span></td><td class="branch-stock-list">${stock}</td><td><span class="status-pill ${state}">${label}</span></td><td><div class="product-row-actions"><button class="button button-secondary product-detail-button" type="button" data-product-id="${product.id}">Detalle</button>${editAction}${deleteAction}</div></td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-state">No hay productos que coincidan con esta búsqueda.</td></tr>';
  renderSuggestions(visible);
  refreshIcons();
}

async function searchProducts() {
  const requestId = ++productSearchRequest;
  const query = $('#product-search').value.trim();
  if (!query) {
    searchedProducts = null;
    renderProducts();
    return;
  }
  try {
    const result = await api(`/api/products?search=${encodeURIComponent(query)}`);
    if (requestId !== productSearchRequest) return;
    searchedProducts = result.items;
    renderProducts();
  } catch (error) {
    if (requestId === productSearchRequest) showToast(error.message, 'error');
  }
}

function renderSuggestions(visibleProducts) {
  const candidates = visibleProducts.filter((product) => product.reviewRequired);
  const matching = [...new Set(candidates.flatMap((product) => product.aliases ?? [product.name]))];
  const hasMatch = candidates.length > 0;
  $('#normalization-copy').textContent = hasMatch
    ? `Estos nombres son candidatos para ${candidates[0].suggestedCanonicalName}. Confirma descripción, composición, presentación y fabricante antes de consolidar existencias.`
    : 'Los nombres confirmados se buscan también por sus alias. Ningún candidato se fusiona ni modifica automáticamente.';
  $('#suggestion-list').innerHTML = hasMatch
    ? `${matching.map((name) => `<span class="match-chip">${escapeHTML(name)}</span>`).join('')}<span class="match-chip">Revisión humana</span>`
    : '<span class="suggestion-none">Sin coincidencias sugeridas en los resultados visibles.</span>';
}

function renderInvoices() {
  $('#invoice-rows').innerHTML = invoices.length ? invoices.map((invoice) => {
    const missingFields = ['supplier', 'reference', 'date', 'amount']
      .filter((field) => invoice[field] === undefined || invoice[field] === null || invoice[field] === '');
    const reviewLabel = invoice.possibleDuplicate
      ? 'Posible duplicado · revisar'
      : missingFields.length
        ? `Falta validar: ${missingFields.join(', ')}`
        : 'Pendiente de revisión';
    const amount = Number.isFinite(invoice.amount)
      ? new Intl.NumberFormat('es-MX', { style: 'currency', currency: invoice.currency || 'MXN' }).format(invoice.amount)
      : 'Sin verificar';
    const supplier = invoice.supplier || 'Sin verificar';
    const canReview = evaluationMode && !['confirmed', 'rejected'].includes(invoice.status);
    const actions = [
      canReview
        ? `<button class="button button-secondary invoice-review-button" type="button" data-invoice-review="${invoice.id}">Revisar decisión</button>`
        : evaluationMode ? 'Revisión finalizada' : 'Requiere revisión humana autorizada',
      evaluationMode && !invoice.inventoryPostedAt
        ? `<button class="button button-secondary" type="button" data-delete-invoice-id="${invoice.id}" aria-label="Eliminar factura ${escapeHTML(invoice.reference || invoice.id)}">Eliminar</button>`
        : '',
    ].filter(Boolean).join(' ');
    return `<tr><td><span class="invoice-supplier">${escapeHTML(supplier)}</span><span class="invoice-ref">${escapeHTML(invoice.reference || 'Folio sin verificar')}</span></td><td>${escapeHTML(invoice.date || 'Sin verificar')}</td><td>${escapeHTML(amount)}</td><td><span class="review-pill ${invoice.possibleDuplicate || missingFields.length ? 'review-needed' : ''}">${escapeHTML(invoice.status || reviewLabel)}</span></td><td>${actions}</td></tr>`;
  }).join('')
    : '<tr><td colspan="5" class="empty-state">No hay registros de facturas.</td></tr>';
}

function openInvoiceReview(invoiceId) {
  const invoice = invoices.find((item) => item.id === invoiceId);
  if (!invoice || !evaluationMode) return;
  $('#invoice-review-form').reset();
  const select = $('#invoice-review-decision');
  select.replaceChildren();
  const decisions = invoice.possibleDuplicate
    ? [['confirm_distinct', 'Confirmar que es distinta'], ['reject', 'Rechazar factura']]
    : [['confirm', 'Confirmar factura revisada'], ['reject', 'Rechazar factura']];
  for (const [value, label] of decisions) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  $('#invoice-review-dialog').dataset.invoiceId = String(invoice.id);
  setFeedback($('#invoice-review-feedback'), '');
  $('#invoice-review-dialog').showModal();
}

async function submitInvoiceReview(event) {
  event.preventDefault();
  if (requestPending) return;
  const dialog = $('#invoice-review-dialog');
  const invoiceId = Number(dialog.dataset.invoiceId);
  const evidence = $('#invoice-review-evidence').value.trim();
  if (!Number.isSafeInteger(invoiceId) || invoiceId < 1 || evidence.length < 20 || evidence.length > 500) {
    setFeedback($('#invoice-review-feedback'), 'La justificación debe tener entre 20 y 500 caracteres.', true);
    return;
  }
  const form = $('#invoice-review-form');
  requestPending = true;
  setLoading(form, true);
  try {
    const result = await api(`/api/invoices/${invoiceId}/review`, {
      method: 'POST',
      body: JSON.stringify({
        decision: $('#invoice-review-decision').value,
        evidence,
      }),
    });
    dialog.close();
    const refreshed = await loadData();
    showToast(
      refreshed
        ? `Revisión registrada: ${result.item.status}. No se ejecutó ningún pago.`
        : 'La revisión se registró, pero no se pudo actualizar la vista. Recarga los datos.',
      refreshed ? '' : 'error',
    );
  } catch (error) {
    setFeedback($('#invoice-review-feedback'), error.message, true);
  } finally {
    requestPending = false;
    setLoading(form, false);
  }
}

async function extractInvoiceDocument(file) {
  const feedback = $('#invoice-extraction-feedback');
  if (!file) return;
  if (file.size < 1 || file.size > 5 * 1024 * 1024
    || !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) {
    feedback.textContent = 'Selecciona un PDF, JPG o PNG de hasta 5 MB.';
    feedback.classList.add('error');
    return;
  }
  feedback.textContent = 'Analizando documento con Azure Document Intelligence… el archivo no se almacenará.';
  feedback.classList.remove('error');
  try {
    const result = await api('/api/invoices/extract', {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file.type },
    });
    const form = $('#invoice-form');
    const assignIfPresent = (name, value) => {
      if (value !== null && value !== undefined && String(value).trim()) {
        form.elements.namedItem(name).value = String(value);
      }
    };
    assignIfPresent('supplier', result.supplier);
    assignIfPresent('reference', result.reference);
    if (typeof result.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.date)) {
      assignIfPresent('date', result.date);
    }
    if (['MXN', 'USD', 'EUR'].includes(result.currency)) {
      assignIfPresent('amount', result.amount);
      assignIfPresent('currency', result.currency);
    }
    if (Array.isArray(result.items) && result.items.length) {
      $('#invoice-lines').replaceChildren();
      for (const item of result.items) {
        addInvoiceLine(false);
        const line = $$('.invoice-line', $('#invoice-lines')).at(-1);
        $('input[name="description"]', line).value = item.description || '';
        $('input[name="quantity"]', line).value = Number.isInteger(item.quantity) ? String(item.quantity) : '';
        $('input[name="unitPrice"]', line).value = Number.isFinite(item.unitPrice) ? String(item.unitPrice) : '';
      }
      updateInvoiceTotal();
    }
    const confidence = Number.isFinite(result.confidence)
      ? ` Confianza promedio reportada por OCR: ${Math.round(result.confidence * 100)}%.`
      : ' El servicio no proporcionó confianza para los campos.';
    const missing = result.missingFields?.length
      ? ` Campos incompletos: ${result.missingFields.join(', ')}.`
      : '';
    feedback.textContent = `${result.status === 'complete' ? 'Extracción recibida.' : 'Extracción incompleta; verifica y completa los campos manualmente.'}${confidence}${missing} El resultado no aprueba la factura.`;
  } catch (error) {
    feedback.textContent = `${error.message} Puedes continuar con captura manual; no se inventó ni conservó ningún campo.`;
    feedback.classList.add('error');
  }
}

const complaintStates = {
  pending: 'Pendiente',
  in_progress: 'En atención',
  resolved: 'Resuelta',
  closed: 'Cerrada',
};

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Fecha no disponible'
    : new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function complaintAgeMinutes(receivedAt) {
  const received = new Date(receivedAt).getTime();
  return Number.isFinite(received) ? Math.max(0, (Date.now() - received) / 60000) : null;
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return 'Tiempo no disponible';
  const totalMinutes = Math.floor(minutes);
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return hours ? `${hours} h ${remainingMinutes} min` : `${totalMinutes} min`;
}

function complaintSlaState(complaint) {
  if (complaint.firstResponseAt) {
    return complaint.slaBreached
      ? ['Primera respuesta fuera del SLA', 'complaint-sla-breached']
      : ['Primera respuesta dentro del SLA', 'complaint-sla-met'];
  }
  const minutes = complaintAgeMinutes(complaint.receivedAt);
  if (minutes === null) return ['Sin respuesta · tiempo no disponible', ''];
  if (minutes >= 15) return [`SLA excedido · ${formatMinutes(minutes)} sin respuesta`, 'complaint-sla-breached'];
  if (minutes >= 12) return [`Próximo al límite · ${formatMinutes(minutes)} sin respuesta`, 'complaint-sla-warning'];
  return [`Sin respuesta · ${formatMinutes(minutes)}`, ''];
}

function complaintCard(complaint) {
  const [slaLabel, slaClass] = complaintSlaState(complaint);
  return `<article class="complaint-card ${slaClass}" data-received-at="${escapeHTML(complaint.receivedAt)}" data-has-response="${Boolean(complaint.firstResponseAt)}" data-response-minutes="${Number.isFinite(complaint.slaMinutes) ? complaint.slaMinutes : ''}">
    <div class="complaint-card-top"><span class="status-pill ${complaint.status === 'resolved' || complaint.status === 'closed' ? 'status-ok' : complaint.status === 'in_progress' ? 'status-low' : 'status-empty'}">${escapeHTML(complaintStates[complaint.status] ?? complaint.status)}</span><time datetime="${escapeHTML(complaint.receivedAt)}">${escapeHTML(formatDateTime(complaint.receivedAt))}</time></div>
    <h3>${escapeHTML(complaint.category)} · ${escapeHTML(complaint.customerName)}</h3>
    <p class="complaint-card-description">${escapeHTML(complaint.description)}</p>
    <div class="complaint-card-meta"><span><i data-lucide="map-pin"></i>${escapeHTML(complaint.branch)}</span><span class="complaint-sla-label">${escapeHTML(slaLabel)}</span></div>
    <button class="button button-secondary complaint-detail-button" type="button" data-complaint-id="${complaint.id}">Abrir reclamación <i data-lucide="arrow-up-right"></i></button>
  </article>`;
}

function updateComplaintClocks() {
  $$('.complaint-card[data-received-at]').forEach((card) => {
    if (card.dataset.hasResponse === 'true') return;
    const minutes = complaintAgeMinutes(card.dataset.receivedAt);
    const label = $('.complaint-sla-label', card);
    if (minutes === null || !label) return;
    card.classList.toggle('complaint-sla-warning', minutes >= 12 && minutes < 15);
    card.classList.toggle('complaint-sla-breached', minutes >= 15);
    label.textContent = minutes >= 15
      ? `SLA excedido · ${formatMinutes(minutes)} sin respuesta`
      : minutes >= 12
        ? `Próximo al límite · ${formatMinutes(minutes)} sin respuesta`
        : `Sin respuesta · ${formatMinutes(minutes)}`;
  });
}

function renderComplaints() {
  const list = $('#complaint-list');
  list.innerHTML = complaints.length
    ? complaints.map(complaintCard).join('')
    : '<p class="empty-state complaint-empty">No hay reclamaciones para esta sucursal y estado.</p>';
  updateComplaintClocks();
  refreshIcons();
}

async function loadComplaints() {
  const branch = $('#complaint-branch-filter').value;
  const status = $('#complaint-status-filter').value;
  const list = $('#complaint-list');
  const statusMessage = $('#complaint-list-status');
  const requestId = ++complaintListRequest;
  complaints = [];
  renderComplaints();
  if (!branch) {
    list.setAttribute('aria-busy', 'false');
    statusMessage.textContent = 'Selecciona una sucursal autorizada para consultar sus reclamaciones.';
    return;
  }
  list.setAttribute('aria-busy', 'true');
  statusMessage.textContent = 'Consultando reclamaciones…';
  try {
    const query = new URLSearchParams({ branch, ...(status ? { status } : {}) });
    const result = await api(`/api/complaints?${query}`);
    if (requestId !== complaintListRequest) return;
    if (!Array.isArray(result.items) || result.items.some((item) => item.branch !== branch)) {
      throw new Error('La respuesta no corresponde a la sucursal seleccionada. No se mostraron los registros.');
    }
    complaints = result.items;
    renderComplaints();
    statusMessage.textContent = `${complaints.length} reclamación${complaints.length === 1 ? '' : 'es'} en ${branch}.`;
  } catch (error) {
    if (requestId !== complaintListRequest) return;
    complaints = [];
    renderComplaints();
    statusMessage.textContent = error.message;
    statusMessage.classList.add('has-error');
  } finally {
    if (requestId === complaintListRequest) list.setAttribute('aria-busy', 'false');
  }
  statusMessage.classList.toggle('has-error', !statusMessage.textContent.startsWith(`${complaints.length} reclamación`));
}

function renderComplaintDetail(complaint) {
  const content = $('#complaint-detail-content');
  const history = Array.isArray(complaint.history) ? complaint.history : [];
  const historyRows = history.length
    ? history.map((entry) => `<li><time datetime="${escapeHTML(entry.at)}">${escapeHTML(formatDateTime(entry.at))}</time><strong>${escapeHTML(complaintStates[entry.status] ?? entry.status ?? 'Actualización')}${entry.event === 'first_response' ? ' · Primera respuesta' : ''}</strong><span>${escapeHTML(entry.actor || 'Sistema')}${entry.note ? ` · ${escapeHTML(entry.note)}` : ''}</span></li>`).join('')
    : '<li class="complaint-history-empty">Sin movimientos registrados.</li>';
  const contact = complaint.contactChannel || complaint.contactValue
    ? `<p><strong>Contacto autorizado:</strong> ${escapeHTML(complaint.contactChannel || 'Medio no indicado')} · ${escapeHTML(complaint.contactValue || 'Dato no indicado')}</p>`
    : '';
  const responseInfo = complaint.firstResponseAt
    ? `<p class="complaint-response-recorded"><strong>Primera respuesta:</strong> ${escapeHTML(formatDateTime(complaint.firstResponseAt))}${Number.isFinite(complaint.slaMinutes) ? ` · ${escapeHTML(formatMinutes(complaint.slaMinutes))} desde recepción` : ''}</p>`
    : '<p class="complaint-response-pending">Aún no se registra una primera respuesta.</p>';
  const draftButton = !complaint.firstResponseAt
    ? `<button class="button button-secondary" type="button" data-draft-response${chatEnabled ? '' : ' disabled'}>Sugerir borrador con IA</button><span class="field-help">El agente recibe solo la categoría y el estado; no se envía al cliente.</span>`
    : '';
  const deleteAction = evaluationMode
    ? '<section class="complaint-detail-section"><button class="button button-secondary" type="button" data-delete-complaint>Eliminar reclamación sintética</button></section>'
    : '';
  content.innerHTML = `
    <div class="complaint-detail-summary"><span class="status-pill ${complaint.status === 'resolved' || complaint.status === 'closed' ? 'status-ok' : complaint.status === 'in_progress' ? 'status-low' : 'status-empty'}">${escapeHTML(complaintStates[complaint.status] ?? complaint.status)}</span><span>${escapeHTML(complaint.branch)}</span></div>
    <dl class="complaint-detail-fields"><div><dt>Recibida</dt><dd>${escapeHTML(formatDateTime(complaint.receivedAt))}</dd></div><div><dt>Cliente</dt><dd>${escapeHTML(complaint.customerName)}</dd></div><div><dt>Categoría</dt><dd>${escapeHTML(complaint.category)}</dd></div><div><dt>Responsable</dt><dd>${escapeHTML(complaint.assignedTo || 'Sin asignar')}</dd></div></dl>
    <p class="complaint-detail-description">${escapeHTML(complaint.description)}</p>${contact}${responseInfo}
    <section class="complaint-detail-section"><h3>Actualizar estado</h3><form class="complaint-action-form" data-action="status"><label>Nuevo estado<select name="status">${Object.entries(complaintStates).map(([value, label]) => `<option value="${value}"${complaint.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label>Nota del cambio (opcional)<textarea name="note" rows="2" maxlength="500" placeholder="Contexto del cambio"></textarea></label><button class="button button-secondary" type="submit">Guardar estado</button><div class="form-feedback" data-action-feedback role="status" aria-live="polite"></div></form></section>
    ${complaint.firstResponseAt ? '' : `<section class="complaint-detail-section"><h3>Revisar respuesta antes de registrar</h3><form class="complaint-action-form" data-action="response"><label>Borrador revisado<textarea name="message" rows="3" maxlength="2000" required placeholder="Escribe o corrige el borrador antes de registrarlo"></textarea></label>${draftButton}<label class="complaint-consent"><input type="checkbox" name="humanApproved" required> Confirmo que revisé y aprobé este texto. No se enviará automáticamente.</label><button class="button button-primary" type="submit">Registrar respuesta revisada</button><div class="form-feedback" data-action-feedback role="status" aria-live="polite"></div></form></section>`}
    <section class="complaint-detail-section"><h3>Historial completo</h3><ol class="complaint-history">${historyRows}</ol></section>${deleteAction}`;
}

async function showComplaintDetails(complaintId) {
  const requestId = ++complaintDetailRequest;
  const dialog = $('#complaint-detail-dialog');
  const content = $('#complaint-detail-content');
  content.textContent = 'Cargando reclamación e historial…';
  if (!dialog.open) dialog.showModal();
  try {
    const result = await api(`/api/complaints/${complaintId}`);
    if (requestId !== complaintDetailRequest) return;
    const selectedBranch = $('#complaint-branch-filter').value;
    if (!result.item || !selectedBranch || result.item.branch !== selectedBranch) {
      throw new Error('El registro no pertenece a la sucursal seleccionada. No se mostraron sus datos.');
    }
    dialog.dataset.complaintId = String(result.item.id);
    renderComplaintDetail(result.item);
  } catch (error) {
    if (requestId === complaintDetailRequest) content.textContent = error.message;
  }
}

function populateBranchOptions() {
  $('#branch-filter').insertAdjacentHTML('beforeend', branches.map((branch) => `<option value="${escapeHTML(branch)}">${escapeHTML(branch)}</option>`).join(''));
  const options = branches.map((branch) => `<option value="${escapeHTML(branch)}">${escapeHTML(branch)}</option>`).join('');
  $('#product-form select[name="branch"]').innerHTML = `<option value="">Selecciona una sucursal</option>${options}`;
  $('#invoice-form select[name="branch"]').insertAdjacentHTML('beforeend', options);
  $('#complaint-create-branch').insertAdjacentHTML('beforeend', options);
  $('#complaint-branch-filter').insertAdjacentHTML('beforeend', options);
}

function invoiceLineValues() {
  return $$('.invoice-line', $('#invoice-lines')).map((line) => ({
    description: $('input[name="description"]', line).value.trim(),
    quantity: $('input[name="quantity"]', line).value.trim()
      ? Number($('input[name="quantity"]', line).value)
      : null,
    unitPrice: $('input[name="unitPrice"]', line).value.trim()
      ? Number($('input[name="unitPrice"]', line).value)
      : null,
  }));
}

function updateInvoiceTotal() {
  const total = invoiceLineValues().reduce((sum, item) => {
    if (!Number.isInteger(item.quantity) || !Number.isFinite(item.unitPrice)) return sum;
    return sum + Math.round(item.quantity * item.unitPrice * 100) / 100;
  }, 0);
  const currency = $('#invoice-form').elements.namedItem('currency').value || 'MXN';
  $('#invoice-total').textContent = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
  }).format(Math.round(total * 100) / 100);
}

function addInvoiceLine(focusDescription = true) {
  const line = document.createElement('div');
  line.className = 'invoice-line';
  const fields = [
    { name: 'description', label: 'Artículo', placeholder: 'Nombre del producto', maxLength: 160 },
    { name: 'quantity', label: 'Cant.', type: 'number', min: 1, max: 1_000_000, step: 1, placeholder: '1' },
    { name: 'unitPrice', label: 'Precio unitario', type: 'number', min: 0.01, max: 100_000_000, step: 0.01, placeholder: '0.00' },
  ];
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement('input');
    input.name = field.name;
    input.required = true;
    if (field.type) input.type = field.type;
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
    if (field.value) input.value = field.value;
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.maxLength) input.maxLength = field.maxLength;
    label.append(input);
    line.append(label);
  }
  const remove = document.createElement('button');
  remove.className = 'icon-button invoice-line-remove';
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Eliminar artículo');
  remove.innerHTML = icon('trash-2');
  remove.addEventListener('click', () => {
    line.remove();
    updateInvoiceTotal();
  });
  line.append(remove);
  const enabled = practiceWritesEnabled && dataOrigin === 'practice';
  $$('input, button', line).forEach((control) => { control.disabled = !enabled; });
  $('#invoice-lines').append(line);
  updateInvoiceTotal();
  refreshIcons();
  if (focusDescription && enabled) $('input[name="description"]', line).focus();
}

function populateProductFilters() {
  const categories = [...new Set(products.map((product) => product.category))].sort((a, b) => a.localeCompare(b, 'es-MX'));
  $('#category-filter').innerHTML = `<option value="">Todas las categorías</option>${categories.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join('')}`;
}

function clearErrors(form) {
  $$('.field-error', form).forEach((element) => { element.textContent = ''; });
  $$('[aria-invalid="true"]', form).forEach((element) => element.removeAttribute('aria-invalid'));
}

function setFieldError(form, field, message) {
  const input = form.elements.namedItem(field);
  if (input) input.setAttribute('aria-invalid', 'true');
  const error = $(`[data-error="${field}"]`, form);
  if (error) error.textContent = message;
}

function validateForm(form, fields) {
  clearErrors(form);
  let valid = true;
  for (const [name, validate] of fields) {
    const input = form.elements.namedItem(name);
    const message = validate(input.value);
    if (message) {
      setFieldError(form, name, message);
      valid = false;
    }
  }
  return valid;
}

function setFeedback(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('has-error', isError);
}

async function deleteDemoRecord(url, confirmation, successMessage, onDeleted) {
  if (!evaluationMode || requestPending || !window.confirm(confirmation)) return false;
  requestPending = true;
  try {
    await api(url, { method: 'DELETE' });
    const refreshed = await onDeleted();
    showToast(
      refreshed === false
        ? `${successMessage} No se pudo actualizar la vista; vuelve a cargar los datos.`
        : successMessage,
      refreshed === false ? 'error' : '',
    );
    return true;
  } catch (error) {
    showToast(error.message, 'error');
    return false;
  } finally {
    requestPending = false;
  }
}

function setChatVoiceStatus(message, state = '') {
  const status = $('#chat-voice-status');
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('is-error', state === 'error');
  status.classList.toggle('is-listening', state === 'listening');
}

function updateChatMicrophone(listening) {
  const button = $('#chat-mic-button');
  button.classList.toggle('is-listening', listening);
  button.setAttribute('aria-label', listening ? 'Detener dictado' : 'Iniciar dictado');
  button.title = listening ? 'Detener dictado' : 'Iniciar dictado';
  $('#chat-voice-cancel').hidden = !listening;
  $('#chat-form button[type="submit"]').disabled = listening || !chatEnabled;
}

function stopChatRecognition(cancel = false) {
  if (!chatRecognition || !chatListening) return;
  chatListening = false;
  chatRecognitionCancelled = cancel;
  if (cancel) {
    chatRecognition.abort();
    setChatVoiceStatus('Grabación cancelada. No se envió ningún mensaje.');
  } else {
    chatRecognition.stop();
    setChatVoiceStatus('Finalizando dictado…', 'listening');
  }
  updateChatMicrophone(false);
}

function setupChatRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = $('#chat-mic-button');
  if (!Recognition) {
    button.disabled = true;
    button.title = 'Este navegador no admite reconocimiento de voz';
    setChatVoiceStatus('Este navegador no admite reconocimiento de voz. Puedes seguir escribiendo en el chat.');
    return;
  }
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  if (!window.isSecureContext && !localHost) {
    button.disabled = true;
    button.title = 'El dictado requiere HTTPS';
    setChatVoiceStatus('El dictado requiere HTTPS en el entorno público (o localhost). Puedes seguir escribiendo en el chat.');
    return;
  }

  chatRecognition = new Recognition();
  chatRecognition.lang = 'es-MX';
  chatRecognition.continuous = false;
  chatRecognition.interimResults = false;
  chatRecognition.maxAlternatives = 1;
  chatRecognition.onstart = () => {
    chatListening = true;
    chatRecognitionCancelled = false;
    updateChatMicrophone(true);
    setChatVoiceStatus('Escuchando… habla con RioClaroAssistant.', 'listening');
  };
  chatRecognition.onresult = (event) => {
    const transcript = [...event.results]
      .map((result) => result[0]?.transcript ?? '')
      .join(' ')
      .trim();
    if (!transcript) {
      setChatVoiceStatus('No se reconocieron palabras. Intenta de nuevo o escribe tu mensaje.', 'error');
      return;
    }
    const input = $('#chat-input');
    input.value = transcript.slice(0, 2000);
    input.focus();
    setChatVoiceStatus(transcript.length > 2000
      ? 'La transcripción superó el límite y se recortó a 2,000 caracteres. Revísala antes de enviarla.'
      : 'Transcripción lista. Revísala o edítala y pulsa enviar para conversar con RioClaroAssistant.');
  };
  chatRecognition.onerror = (event) => {
    if (event.error === 'aborted' && chatRecognitionCancelled) return;
    const errors = {
      'not-allowed': 'Permiso de micrófono denegado. Habilítalo en la configuración del navegador o escribe tu mensaje.',
      'service-not-allowed': 'El navegador bloqueó el reconocimiento de voz. Puedes seguir escribiendo.',
      'audio-capture': 'No se encontró un micrófono disponible. Puedes seguir escribiendo.',
      'no-speech': 'No se detectó voz. Intenta de nuevo o escribe tu mensaje.',
      network: 'Falló la conexión del reconocimiento de voz. Puedes seguir escribiendo.',
      aborted: 'La grabación se interrumpió. Puedes intentar de nuevo o escribir tu mensaje.',
    };
    setChatVoiceStatus(errors[event.error] ?? 'Ocurrió un error de reconocimiento. Puedes seguir escribiendo.', 'error');
  };
  chatRecognition.onend = () => {
    chatListening = false;
    updateChatMicrophone(false);
    chatRecognitionCancelled = false;
    if ($('#chat-voice-status').textContent === 'Escuchando… habla con RioClaroAssistant.') {
      setChatVoiceStatus('Micrófono inactivo.');
    }
  };
}

function updateWriteControls() {
  const enabled = (evaluationMode || practiceWritesEnabled) && dataOrigin === 'practice';
  $('#open-product-form').disabled = !enabled;
  $('#open-product-form').title = enabled
    ? 'Agregar un producto a los datos de práctica'
    : 'Las altas requieren datos de práctica local';
  $$('input, select, button', $('#invoice-form')).forEach((control) => {
    control.disabled = !enabled;
  });
}

function setLoading(form, loading) {
  const button = $('button[type="submit"]', form);
  button.disabled = loading;
  if (loading) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

async function loadData() {
  const requestId = ++dataLoadRequest;
  try {
    const [dashboardData, productData, invoiceData] = await Promise.all([
      api('/api/dashboard'), api('/api/products'), api('/api/invoices'),
    ]);
    if (requestId !== dataLoadRequest) return true;
    dashboard = dashboardData;
    products = productData.items;
    searchedProducts = null;
    invoices = invoiceData.items;
    populateProductFilters();
    renderDashboard();
    renderProducts();
    renderInvoices();
    return true;
  } catch (error) {
    if (requestId !== dataLoadRequest) return true;
    dashboard = null;
    products = [];
    searchedProducts = null;
    invoices = [];
    $('#stat-products').textContent = '—';
    $('#stat-invoices').textContent = '—';
    $('#stat-alerts').textContent = '—';
    $('#branch-list').replaceChildren();
    $('#activity-list').replaceChildren();
    populateProductFilters();
    renderProducts();
    renderInvoices();
    showToast(error.message, 'error');
    return false;
  }
}

async function showProductDetails(productId) {
  const dialog = $('#product-detail-dialog');
  const content = $('#product-detail-content');
  content.textContent = 'Cargando ficha e historial…';
  dialog.showModal();
  try {
    const result = await api(`/api/products/${productId}`);
    const item = result.item;
    const branchRows = item.branches.map((branch) =>
      `<tr><td>${escapeHTML(branch.name)}</td><td>${branch.stock}</td><td>${branch.productId}</td></tr>`,
    ).join('');
    const movementRows = result.movements.length
      ? result.movements.map((movement) =>
        `<tr><td>${escapeHTML(movement.createdAt)}</td><td>${escapeHTML(movement.type)}</td><td>${escapeHTML(movement.branch)}</td><td>${movement.quantity}</td><td>${movement.invoiceId ?? '—'}</td></tr>`,
      ).join('')
      : '<tr><td colspan="5" class="empty-state">No hay movimientos registrados para este producto.</td></tr>';
    const invoiceRows = result.invoiceReferences.length
      ? result.invoiceReferences.map((invoice) =>
        `<tr><td>${escapeHTML(invoice.reference)}</td><td>${escapeHTML(invoice.supplier)}</td><td>${escapeHTML(invoice.date)}</td><td>${escapeHTML(invoice.status)}</td></tr>`,
      ).join('')
      : '';
    content.innerHTML = `
      <p class="product-detail-name">${escapeHTML(item.name)}</p>
      <p class="product-detail-meta">Clave normalizada: <code>${escapeHTML(item.normalizedName)}</code> · Estado: ${item.reviewRequired ? 'Revisión humana pendiente' : 'Normalizado'}</p>
      <div class="product-detail-section"><h3>Existencias por sucursal</h3><div class="table-wrap"><table><thead><tr><th>SUCURSAL</th><th>EXISTENCIA</th><th>ID DE REGISTRO</th></tr></thead><tbody>${branchRows}</tbody></table></div></div>
      <p class="product-detail-meta">Alias registrados: ${item.aliases.map(escapeHTML).join(' · ') || 'Ninguno'}</p>
      <div class="product-detail-section"><h3>Historial de movimientos</h3><div class="table-wrap"><table><thead><tr><th>FECHA</th><th>TIPO</th><th>SUCURSAL</th><th>CANTIDAD</th><th>FACTURA ID</th></tr></thead><tbody>${movementRows}</tbody></table></div></div>
      ${invoiceRows ? `<div class="product-detail-section"><h3>Facturas relacionadas</h3><div class="table-wrap"><table><thead><tr><th>FOLIO</th><th>PROVEEDOR</th><th>FECHA</th><th>ESTADO</th></tr></thead><tbody>${invoiceRows}</tbody></table></div></div>` : ''}
    `;
  } catch (error) {
    content.textContent = error.message;
  }
}

async function loadSecurityStatus() {
  try {
    await api('/health');
    updateStatus($('#backend-status'), 'Backend · activo', 'connected', 'status-pulse');
    updateStatus($('#sidebar-backend-status'), 'Backend · activo', 'connected');
  } catch {
    updateStatus($('#backend-status'), 'Backend · sin conexión', 'error', 'status-pulse');
    updateStatus($('#sidebar-backend-status'), 'Backend · sin conexión', 'error');
  }
  try {
    const status = await api('/api/security/status');
    const previousEvaluationMode = evaluationMode;
    evaluationMode = Boolean(status.evaluationMode);
    let refreshData = evaluationMode !== previousEvaluationMode;
    if (evaluationMode) {
      refreshData ||= dataOrigin !== 'practice';
      dataOrigin = 'practice';
      sessionStorage.setItem('rioclaro-data-origin', dataOrigin);
      $('#data-origin').value = dataOrigin;
      $('#data-origin').closest('.origin-select-label').hidden = true;
      $('#complaint-access-copy').textContent = 'El servidor limita todas las consultas y cambios al entorno sintético de evaluación.';
    } else {
      $('#data-origin').closest('.origin-select-label').hidden = false;
      $('#complaint-access-copy').textContent = 'La API valida los permisos; Operación requiere inicio de sesión con Entra, que aún no está disponible en esta interfaz.';
    }
    practiceWritesEnabled = Boolean(status.practiceWritesEnabled || evaluationMode);
    $('#security-banner-text').textContent = evaluationMode
      ? 'Entorno público de evaluación: se usan datos sintéticos aislados. Puedes probar las funciones disponibles; no se consultan datos productivos.'
      : practiceWritesEnabled
        ? 'Las altas de productos y facturas se guardan solo en Práctica local. Operación requiere Entra; las facturas quedan pendientes de revisión y no se realizan pagos.'
      : 'Las escrituras requieren un token de Entra verificado por la API. La interfaz web aún no implementa inicio de sesión.';
    if (refreshData) {
      await loadData();
      void loadSalesReport();
      complaintListRequest += 1;
      complaints = [];
      renderComplaints();
      if ($('#complaint-branch-filter').value) void loadComplaints();
    }
    updateWriteControls();
    const connection = status.foundryConnection;
    const connected = Boolean(connection?.connected && status.aiEnabled && !status.aiSuspended);
    chatEnabled = Boolean((status.localChatEnabled || evaluationMode) && connected);
    $('#sales-ai-summary').disabled = !chatEnabled || !salesReport?.dataAvailable;
    $$('[data-draft-response]').forEach((button) => { button.disabled = !chatEnabled; });
    const foundryLabel = !status.aiConfigured
      ? 'Foundry · pendiente de configuración'
      : status.aiSuspended
        ? 'Foundry · suspendida'
        : connected
          ? 'Foundry · conectada'
          : connection?.state === 'connecting'
            ? 'Foundry · preparando agente'
            : connection?.state === 'rate_limited'
              ? 'Foundry · cuota temporalmente limitada'
              : status.aiEnabled
                ? 'Foundry · no disponible'
                : 'Foundry · desactivada';
    const foundryState = connected ? 'connected' : status.aiSuspended ? 'warning' : connection?.state === 'unavailable' || connection?.state === 'rate_limited' ? 'error' : 'pending';
    updateStatus($('#sidebar-foundry-status'), foundryLabel, foundryState);
    updateStatus($('#assistant-status'), connected ? 'Agente conectado' : connection?.state === 'connecting' ? 'Preparando agente' : foundryLabel, foundryState);
    $('#foundry-top-status').textContent = foundryLabel;
    if (connected) {
      $('#assistant-connection-message').textContent = 'RioClaroAssistant está listo para recibir consultas.';
      $('#assistant-connection-meta').textContent = 'AGENTE CONECTADO';
    } else if (connection?.state === 'connecting') {
      $('#assistant-connection-message').textContent = 'Preparando conexión con RioClaroAssistant…';
      $('#assistant-connection-meta').textContent = 'PREPARANDO AGENTE';
    } else if (status.aiConfigured && status.aiEnabled && !status.aiSuspended) {
      $('#assistant-connection-message').textContent = connection?.message || 'El servidor reintentará la conexión automáticamente.';
      $('#assistant-connection-meta').textContent = 'CONEXIÓN PENDIENTE';
    }
    $('#chat-input').disabled = !chatEnabled;
    $('#chat-form button[type="submit"]').disabled = !chatEnabled || chatListening;
    $$('.suggestion-chip').forEach((button) => { button.disabled = !chatEnabled; });
    $('#chat-input').placeholder = chatEnabled
      ? 'Escribe tu pregunta…'
      : connection?.state === 'connecting'
        ? 'Preparando el agente…'
        : 'El chat estará disponible cuando el agente esté conectado…';
  } catch {
    $('#security-banner-text').textContent = 'No fue posible consultar el estado de seguridad del servidor.';
  }
}

function addMessage(text, role, meta = '') {
  const message = document.createElement('div');
  message.className = `message ${role === 'assistant' ? 'assistant-message' : 'user-message'}`;
  if (role === 'assistant') {
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.innerHTML = icon('sparkles');
    message.append(avatar);
  }
  const content = document.createElement('div');
  content.className = 'message-content';
  const body = document.createElement('p');
  body.textContent = text;
  content.append(body);
  const metadata = document.createElement('span');
  metadata.className = 'message-meta';
  metadata.textContent = meta || (role === 'assistant' ? 'RIOCLAROASSISTANT' : 'TÚ');
  content.append(metadata);
  message.append(content);
  $('#chat-messages').append(message);
  $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
  if (meta !== 'CONSULTANDO' && meta !== 'CONEXIÓN PENDIENTE' && meta !== 'PREPARANDO AGENTE') {
    chatHistory.push({ text, role, meta });
    try {
      sessionStorage.setItem('rioclaro-chat-history', JSON.stringify(chatHistory));
    } catch {
      showToast('No fue posible conservar el historial en esta sesión.', 'error');
    }
  }
  refreshIcons();
  return message;
}

function initialize() {
  $('#data-origin').value = dataOrigin;
  try {
    const savedHistory = JSON.parse(sessionStorage.getItem('rioclaro-chat-history') || '[]');
    if (Array.isArray(savedHistory)) {
      chatHistory = savedHistory.filter((item) =>
        item && typeof item.text === 'string' && ['user', 'assistant'].includes(item.role),
      );
      for (const item of chatHistory) addMessage(item.text, item.role, item.meta);
    }
  } catch {
    chatHistory = [];
  }
  populateBranchOptions();
  const salesTo = new Date();
  const salesFrom = new Date(salesTo);
  salesFrom.setDate(salesFrom.getDate() - 6);
  $('#sales-from').value = isoDate(salesFrom);
  $('#sales-to').value = isoDate(salesTo);
  $('#sales-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    void loadSalesReport();
  });
  $('#sales-branch').addEventListener('change', () => void loadSalesReport());
  $('#sales-ai-summary').addEventListener('click', requestSalesSummary);
  setupChatRecognition();
  $('#chat-mic-button').addEventListener('click', () => {
    if (!chatRecognition) return;
    if (chatListening) {
      stopChatRecognition();
      return;
    }
    chatListening = true;
    chatRecognitionCancelled = false;
    updateChatMicrophone(true);
    setChatVoiceStatus('Solicitando acceso al micrófono…', 'listening');
    try {
      chatRecognition.start();
    } catch {
      chatListening = false;
      updateChatMicrophone(false);
      setChatVoiceStatus('No se pudo iniciar el micrófono. Verifica los permisos del navegador y vuelve a intentar.', 'error');
    }
  });
  $('#chat-voice-cancel').addEventListener('click', () => stopChatRecognition(true));
  updateWriteControls();
  $('#menu-button').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#menu-button').setAttribute('aria-expanded', String(open));
  });
  $$('.nav-link').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(link.dataset.page);
  }));
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || 'inicio'));
  navigate(location.hash.slice(1) || 'inicio');
  $('#product-search').addEventListener('input', searchProducts);
  $('#category-filter').addEventListener('change', renderProducts);
  $('#branch-filter').addEventListener('change', renderProducts);
  $('#complaint-branch-filter').addEventListener('change', loadComplaints);
  $('#complaint-status-filter').addEventListener('change', loadComplaints);
  $('#refresh-complaints').addEventListener('click', loadComplaints);
  $('#complaint-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-complaint-id]');
    if (button) void showComplaintDetails(Number(button.dataset.complaintId));
  });
  $('#close-complaint-detail').addEventListener('click', () => $('#complaint-detail-dialog').close());
  $('#complaint-detail-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  const complaintContactConsent = $('#complaint-contact-consent');
  complaintContactConsent.addEventListener('change', () => {
    $('#complaint-contact-fields').hidden = !complaintContactConsent.checked;
  });
  const complaintForm = $('#complaint-form');
  complaintForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (requestPending || !validateForm(complaintForm, [
      ['branch', (value) => branches.includes(value) ? '' : 'Selecciona una sucursal válida.'],
      ['customerName', (value) => value.trim() ? '' : 'Ingresa el nombre del cliente.'],
      ['category', (value) => value.trim() ? '' : 'Ingresa la categoría.'],
      ['description', (value) => value.trim() ? '' : 'Describe la reclamación.'],
    ])) return;
    const contactChannel = complaintForm.elements.namedItem('contactChannel').value.trim();
    const contactValue = complaintForm.elements.namedItem('contactValue').value.trim();
    if (complaintContactConsent.checked && (!contactChannel || !contactValue)) {
      setFeedback($('#complaint-feedback'), 'Completa el medio y el dato de contacto autorizados, o desmarca la autorización.', true);
      return;
    }
    requestPending = true;
    setLoading(complaintForm, true);
    setFeedback($('#complaint-feedback'), '');
    try {
      const branch = complaintForm.elements.namedItem('branch').value;
      const result = await api('/api/complaints', {
        method: 'POST',
        body: JSON.stringify({
          branch,
          customerName: complaintForm.elements.namedItem('customerName').value.trim(),
          description: complaintForm.elements.namedItem('description').value.trim(),
          category: complaintForm.elements.namedItem('category').value.trim(),
          ...(complaintContactConsent.checked ? { contactChannel, contactValue } : {}),
        }),
      });
      if (!result.item || !result.item.id || result.item.branch !== branch) {
        throw new Error('El servidor no confirmó la creación de la reclamación.');
      }
      complaintForm.reset();
      $('#complaint-contact-fields').hidden = true;
      $('#complaint-branch-filter').value = branch;
      setFeedback($('#complaint-feedback'), `Reclamación #${result.item.id} registrada el ${formatDateTime(result.item.receivedAt)}.`);
      await loadComplaints();
    } catch (error) {
      setFeedback($('#complaint-feedback'), error.message, true);
    } finally {
      requestPending = false;
      setLoading(complaintForm, false);
    }
  });
  $('#complaint-detail-content').addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-action]');
    if (!form) return;
    event.preventDefault();
    if (requestPending) return;
    const complaintId = Number($('#complaint-detail-dialog').dataset.complaintId);
    const action = form.dataset.action;
    const feedback = $('[data-action-feedback]', form);
    if (!Number.isSafeInteger(complaintId) || complaintId < 1) {
      setFeedback(feedback, 'No se pudo identificar la reclamación.', true);
      return;
    }
    const requestOptions = action === 'status'
      ? {
        url: `/api/complaints/${complaintId}/status`,
        body: {
          status: form.elements.namedItem('status').value,
          note: form.elements.namedItem('note').value.trim(),
        },
      }
      : {
        url: `/api/complaints/${complaintId}/response`,
        body: {
          message: form.elements.namedItem('message').value.trim(),
          humanApproved: form.elements.namedItem('humanApproved').checked,
        },
      };
    if (action === 'response' && !requestOptions.body.message) {
      setFeedback(feedback, 'Escribe el mensaje de respuesta.', true);
      return;
    }
    if (action === 'response' && !form.elements.namedItem('humanApproved').checked) {
      setFeedback(feedback, 'Confirma que revisaste y aprobaste el borrador antes de registrarlo.', true);
      return;
    }
    requestPending = true;
    setLoading(form, true);
    setFeedback(feedback, '');
    try {
      const result = await api(requestOptions.url, {
        method: 'POST',
        body: JSON.stringify(requestOptions.body),
      });
      if (!result.item || result.item.branch !== $('#complaint-branch-filter').value) {
        throw new Error('La API no confirmó la operación para la sucursal seleccionada.');
      }
      if (action === 'status' && result.item.status !== requestOptions.body.status) {
        throw new Error('La API no confirmó el nuevo estado solicitado.');
      }
      if (action === 'response' && !result.item.firstResponseAt) {
        throw new Error('La API no confirmó el registro de la primera respuesta.');
      }
      $('#complaint-detail-dialog').dataset.complaintId = String(result.item.id);
      renderComplaintDetail(result.item);
      if (action === 'status') {
        setFeedback($('[data-action-feedback]', $('#complaint-detail-content')), 'Estado actualizado por el servidor.');
        showToast('Estado actualizado.');
      } else {
        showToast(`Respuesta aprobada y registrada: ${formatDateTime(result.item.firstResponseAt)}. No se envió al cliente.`);
      }
      await loadComplaints();
    } catch (error) {
      setFeedback($('[data-action-feedback]', form) || feedback, error.message, true);
    } finally {
      requestPending = false;
      if (form.isConnected) setLoading(form, false);
    }
  });
  $('#complaint-detail-content').addEventListener('click', async (event) => {
    const deleteButton = event.target.closest('[data-delete-complaint]');
    if (deleteButton) {
      const complaintId = Number($('#complaint-detail-dialog').dataset.complaintId);
      if (!Number.isSafeInteger(complaintId) || complaintId < 1) return;
      const deleted = await deleteDemoRecord(
        `/api/complaints/${complaintId}`,
        'La reclamación sintética y su historial se eliminarán permanentemente. ¿Deseas continuar?',
        'Reclamación sintética eliminada.',
        async () => {
          $('#complaint-detail-dialog').close();
          await loadComplaints();
          return loadData();
        },
      );
      if (deleted) return;
    }
    const button = event.target.closest('[data-draft-response]');
    if (!button) return;
    if (!chatEnabled || requestPending) {
      setFeedback($('[data-action-feedback]', button.closest('form')), 'Foundry no está disponible para generar un borrador.', true);
      return;
    }
    const complaintId = Number($('#complaint-detail-dialog').dataset.complaintId);
    if (!Number.isSafeInteger(complaintId) || complaintId < 1) return;
    const form = button.closest('form');
    const feedback = $('[data-action-feedback]', form);
    button.disabled = true;
    setFeedback(feedback, 'Solicitando borrador; no se enviará al cliente.');
    try {
      const result = await api(`/api/complaints/${complaintId}/draft-response`, {
        method: 'POST',
        headers: { 'X-Chat-Session': chatSessionId },
        body: JSON.stringify({}),
      });
      form.elements.namedItem('message').value = result.draft;
      setFeedback(feedback, 'Borrador generado. Revísalo, corrígelo y apruébalo antes de registrarlo.');
      form.elements.namedItem('message').focus();
    } catch (error) {
      setFeedback(feedback, error.message, true);
    } finally {
      button.disabled = !chatEnabled;
    }
  });
  window.setInterval(updateComplaintClocks, 30000);
  $('#product-rows').addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit-product-id]');
    if (editButton) {
      const productId = Number(editButton.dataset.editProductId);
      const product = products.find((item) =>
        item.id === productId
        && item.sourceIds?.length === 1
        && item.normalizationStatus === 'normalized'
        && !item.reviewRequired,
      );
      if (!product || !evaluationMode) return;
      editingProductId = productId;
      productForm.reset();
      clearErrors(productForm);
      setFeedback($('#product-feedback'), '');
      productForm.elements.namedItem('name').value = product.name;
      productForm.elements.namedItem('category').value = product.category;
      productForm.elements.namedItem('branch').value = product.branches[0].name;
      $('#product-form-eyebrow').textContent = 'ACTUALIZACIÓN DEMO';
      $('#product-dialog-title').textContent = 'Editar producto';
      $('#product-form-note').textContent = 'Solo se editarán el nombre, la categoría y la sucursal. Las existencias y los movimientos se conservan.';
      $('button[type="submit"]', productForm).innerHTML = `${icon('save')} <span>Guardar cambios</span>`;
      $('#product-stock-field').hidden = true;
      refreshIcons();
      $('#product-dialog').showModal();
      return;
    }
    const deleteButton = event.target.closest('[data-delete-product-id]');
    if (deleteButton) {
      const productId = Number(deleteButton.dataset.deleteProductId);
      const product = products.find((item) => item.id === productId);
      if (!product) return;
      const records = product.sourceIds?.length ?? 1;
      void deleteDemoRecord(
        `/api/products/${productId}`,
        `Se eliminará permanentemente ${product.name}${records > 1 ? ` y sus ${records} registros agrupados por sucursal` : ''}. Los productos con movimientos o facturas relacionados no pueden eliminarse. ¿Deseas continuar?`,
        'Producto sintético eliminado.',
        loadData,
      );
      return;
    }
    const button = event.target.closest('[data-product-id]');
    if (button) void showProductDetails(Number(button.dataset.productId));
  });
  $('#close-product-detail').addEventListener('click', () => $('#product-detail-dialog').close());
  $('#product-detail-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $('#data-origin').addEventListener('change', (event) => {
    dataOrigin = event.currentTarget.value;
    sessionStorage.setItem('rioclaro-data-origin', dataOrigin);
    updateWriteControls();
    loadData();
    void loadSalesReport();
    void loadComplaints();
    loadSecurityStatus();
  });
  const dialog = $('#product-dialog');
  const productForm = $('#product-form');
  $('#open-product-form').addEventListener('click', () => {
    editingProductId = null;
    productForm.reset();
    clearErrors(productForm);
    setFeedback($('#product-feedback'), '');
    $('#product-form-eyebrow').textContent = 'NUEVO REGISTRO';
    $('#product-dialog-title').textContent = 'Agregar producto';
    $('#product-form-note').textContent = 'Se guarda únicamente en el conjunto de Práctica local.';
    $('button[type="submit"]', productForm).innerHTML = `${icon('plus')} <span>Agregar producto</span>`;
    $('#product-stock-field').hidden = false;
    refreshIcons();
    dialog.showModal();
  });
  $('#close-product-form').addEventListener('click', () => dialog.close());
  $('#cancel-product-form').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  productForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const validators = [
      ['name', (value) => value.trim() ? '' : 'Ingresa un nombre.'],
      ['category', (value) => value.trim() ? '' : 'Ingresa una categoría.'],
      ['branch', (value) => branches.includes(value) ? '' : 'Selecciona una sucursal válida.'],
    ];
    if (editingProductId === null) {
      validators.push(['stock', (value) => value.trim() && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1_000_000 ? '' : 'Ingresa un entero entre 0 y 1,000,000.']);
    }
    if (requestPending || !validateForm(productForm, validators)) return;
    requestPending = true;
    setLoading(productForm, true);
    try {
      const payload = {
        name: productForm.elements.namedItem('name').value.trim(),
        category: productForm.elements.namedItem('category').value.trim(),
        branch: productForm.elements.namedItem('branch').value,
      };
      if (editingProductId === null) payload.stock = Number(productForm.elements.namedItem('stock').value);
      const wasEditing = editingProductId !== null;
      await api(wasEditing ? `/api/products/${editingProductId}` : '/api/products', {
        method: wasEditing ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      const refreshed = await loadData();
      dialog.close();
      const successMessage = wasEditing ? 'Producto actualizado.' : 'Producto agregado.';
      showToast(
        refreshed
          ? successMessage
          : `El producto se ${wasEditing ? 'actualizó' : 'agregó'}, pero no se pudo actualizar la vista. Recarga los datos.`,
        refreshed ? '' : 'error',
      );
      editingProductId = null;
    } catch (error) {
      setFeedback($('#product-feedback'), error.message, true);
    } finally {
      requestPending = false;
      setLoading(productForm, false);
    }
  });

  const invoiceForm = $('#invoice-form');
  addInvoiceLine(false);
  $('#add-invoice-line').addEventListener('click', addInvoiceLine);
  $('#invoice-lines').addEventListener('input', updateInvoiceTotal);
  invoiceForm.elements.namedItem('currency').addEventListener('change', updateInvoiceTotal);
  $('#invoice-document').addEventListener('change', async (event) => {
    try {
      await extractInvoiceDocument(event.currentTarget.files[0]);
    } finally {
      event.currentTarget.value = '';
    }
  });
  $('#invoice-rows').addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-delete-invoice-id]');
    if (deleteButton) {
      const invoiceId = Number(deleteButton.dataset.deleteInvoiceId);
      void deleteDemoRecord(
        `/api/invoices/${invoiceId}`,
        'La factura sintética se eliminará permanentemente. ¿Deseas continuar?',
        'Factura sintética eliminada.',
        loadData,
      );
      return;
    }
    const button = event.target.closest('[data-invoice-review]');
    if (button) openInvoiceReview(Number(button.dataset.invoiceReview));
  });
  $('#invoice-review-form').addEventListener('submit', submitInvoiceReview);
  $('#close-invoice-review').addEventListener('click', () => $('#invoice-review-dialog').close());
  $('#cancel-invoice-review').addEventListener('click', () => $('#invoice-review-dialog').close());
  $('#invoice-review-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  invoiceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (requestPending || !validateForm(invoiceForm, [
      ['supplier', (value) => value.trim() ? '' : 'Ingresa el proveedor.'],
      ['reference', (value) => value.trim() ? '' : 'Ingresa el folio.'],
      ['date', (value) => value && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? '' : 'Selecciona una fecha válida.'],
      ['branch', (value) => branches.includes(value) ? '' : 'Selecciona la sucursal que recibirá los artículos.'],
      ['amount', (value) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 100_000_000 ? '' : 'Ingresa un importe total válido.'],
      ['currency', (value) => ['MXN', 'USD', 'EUR'].includes(value) ? '' : 'Selecciona una moneda admitida.'],
    ])) return;
    const items = invoiceLineValues().filter((item) =>
      item.description || item.quantity !== null || item.unitPrice !== null,
    );
    const invalidItem = items.some((item) =>
      !item.description
      || !Number.isInteger(item.quantity)
      || item.quantity < 1
      || item.quantity > 1_000_000
      || !Number.isFinite(item.unitPrice)
      || item.unitPrice <= 0
      || item.unitPrice > 100_000_000,
    );
    if (invalidItem) {
      setFeedback($('#invoice-feedback'), 'Completa cada artículo agregado con descripción, cantidad y precio válidos; elimina las líneas vacías.', true);
      return;
    }
    const amount = Math.round(Number(invoiceForm.elements.namedItem('amount').value) * 100) / 100;
    if (amount <= 0 || amount > 100_000_000) {
      setFeedback($('#invoice-feedback'), 'El total debe ser mayor que cero y no superar $100,000,000.', true);
      return;
    }
    if (items.length) {
      const lineTotal = Math.round(items.reduce((total, item) =>
        total + Math.round(item.quantity * item.unitPrice * 100) / 100, 0) * 100) / 100;
      if (lineTotal !== amount) {
        setFeedback($('#invoice-feedback'), 'El total de las líneas no coincide con el importe de la factura. Verifica los datos originales; no se estimaron impuestos ni cargos.', true);
        return;
      }
    }
    requestPending = true;
    setLoading(invoiceForm, true);
    setFeedback($('#invoice-feedback'), '');
    try {
      const result = await api('/api/invoices', { method: 'POST', body: JSON.stringify({
        supplier: invoiceForm.elements.namedItem('supplier').value.trim(),
        reference: invoiceForm.elements.namedItem('reference').value.trim(),
        date: invoiceForm.elements.namedItem('date').value,
        branch: invoiceForm.elements.namedItem('branch').value,
        amount,
        currency: invoiceForm.elements.namedItem('currency').value,
        items,
      }) });
      const refreshed = await loadData();
      invoiceForm.reset();
      $('#invoice-lines').replaceChildren();
      addInvoiceLine(false);
      $('#invoice-document').value = '';
      updateInvoiceTotal();
      setFeedback($('#invoice-feedback'), !refreshed
        ? 'La factura se registró, pero no se pudo actualizar la vista. Recarga los datos para verificarla.'
        : result.possibleDuplicate
          ? 'Posible coincidencia detectada. Requiere revisión de una persona; no se autorizó ningún pago.'
          : 'Registro agregado. La factura queda pendiente de revisión; no se realizó ningún pago.', !refreshed);
    } catch (error) {
      setFeedback($('#invoice-feedback'), error.message, true);
    } finally {
      requestPending = false;
      setLoading(invoiceForm, false);
      updateWriteControls();
    }
  });

  const chatForm = $('#chat-form');
  $('#new-chat').addEventListener('click', () => {
    stopChatRecognition(true);
    conversationId = null;
    chatHistory = [];
    sessionStorage.removeItem('rioclaro-chat-conversation');
    sessionStorage.removeItem('rioclaro-chat-history');
    $('#chat-messages').replaceChildren();
    addMessage('Nueva conversación lista.', 'assistant', 'RIOCLAROASSISTANT');
  });
  $$('.suggestion-chip').forEach((button) => button.addEventListener('click', () => {
    $('#chat-input').value = button.dataset.question;
    $('#chat-input').focus();
  }));
  chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const message = input.value.trim();
    if (requestPending || !message) return;
    if (chatListening) {
      setChatVoiceStatus('Detén o cancela la grabación antes de enviar el mensaje.');
      return;
    }
    requestPending = true;
    setLoading(chatForm, true);
    $('#chat-input').disabled = true;
    $('#chat-processing-status').lastChild.textContent = ' Procesando';
    addMessage(message, 'user');
    input.value = '';
    const loadingMessage = addMessage('Consultando al agente configurado…', 'assistant', 'CONSULTANDO');
    try {
      const result = await api('/api/chat', {
        method: 'POST',
        headers: { 'X-Chat-Session': chatSessionId },
        body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
      });
      if (result.conversationId) {
        conversationId = result.conversationId;
        sessionStorage.setItem('rioclaro-chat-conversation', conversationId);
      }
      const sourceDisclosure = result.sources?.length
        ? `\n\nFuentes reportadas por el agente (sin verificar): ${result.sources.join('; ')}`
        : '\n\nFuentes verificables: no disponibles.';
      loadingMessage.querySelector('.message-content > p').textContent = result.answer + sourceDisclosure;
      loadingMessage.querySelector('.message-meta').textContent = result.sources?.length
        ? 'RIOCLAROASSISTANT · FUENTES NO VERIFICADAS'
        : 'RIOCLAROASSISTANT · FUENTES NO DISPONIBLES';
      chatHistory.push({
        text: result.answer + sourceDisclosure,
        role: 'assistant',
        meta: loadingMessage.querySelector('.message-meta').textContent,
      });
      try {
        sessionStorage.setItem('rioclaro-chat-history', JSON.stringify(chatHistory));
      } catch {
        showToast('No fue posible conservar el historial en esta sesión.', 'error');
      }
    } catch (error) {
      if (error.status === 404) {
        conversationId = null;
        sessionStorage.removeItem('rioclaro-chat-conversation');
      }
      loadingMessage.remove();
      addMessage(error.message, 'assistant', 'RESPUESTA NO DISPONIBLE');
      if (!input.value) input.value = message;
      updateStatus($('#assistant-status'), 'Conexión no disponible', 'error');
      showToast('No se generó una respuesta de IA. Revisa la configuración y el acceso a Foundry.', 'error');
    } finally {
      requestPending = false;
      setLoading(chatForm, false);
      $('#chat-input').disabled = !chatEnabled;
      $('#chat-form button[type="submit"]').disabled = !chatEnabled || chatListening;
      $('#chat-processing-status').lastChild.textContent = ' Esperando consulta';
    }
  });
  loadData();
  void loadSalesReport();
  loadSecurityStatus();
  window.setInterval(loadSecurityStatus, 10_000);
  refreshIcons();
}

initialize();
