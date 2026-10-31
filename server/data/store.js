import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalProductDisplayName,
  conflictingProductAttributes,
  equivalenceDefinitionForName,
  normalizeProductName,
  productEquivalenceDefinitions,
} from './product-normalization.js';

const dataFile = process.env.RIOCLARO_DATA_FILE === ':memory:'
  ? null
  : process.env.RIOCLARO_DATA_FILE?.trim()
    || path.join(path.dirname(fileURLToPath(import.meta.url)), 'rioclaro-data.json');
const branches = ['Guadalajara', 'Zapopan', 'León', 'Querétaro', 'Aguascalientes'];
const complaintStatuses = new Set(['pending', 'in_progress', 'resolved', 'closed']);

const initialProducts = [
  { id: 1, name: 'Cloro 1L', category: 'Desinfectantes', branch: 'Guadalajara', stock: 48, origin: 'practice' },
  { id: 2, name: 'CLORO LITRO', category: 'Desinfectantes', branch: 'Zapopan', stock: 32, origin: 'practice' },
  { id: 3, name: 'Blanqueador 1000ml', category: 'Desinfectantes', branch: 'León', stock: 26, origin: 'practice' },
  { id: 4, name: 'Detergente líquido 2L', category: 'Detergentes', branch: 'Querétaro', stock: 19, origin: 'practice' },
  { id: 5, name: 'Jabón antibacterial 500ml', category: 'Higiene', branch: 'Aguascalientes', stock: 41, origin: 'practice' },
  { id: 6, name: 'Limpiavidrios 750ml', category: 'Limpieza de superficies', branch: 'Guadalajara', stock: 8, origin: 'practice' },
  { id: 7, name: 'Desengrasante industrial 5L', category: 'Limpieza de superficies', branch: 'Zapopan', stock: 12, origin: 'practice' },
  { id: 8, name: 'Papel higiénico institucional', category: 'Papel e higiene', branch: 'León', stock: 0, origin: 'practice' },
  { id: 9, name: 'Suavizante concentrado 1L', category: 'Detergentes', branch: 'Querétaro', stock: 23, origin: 'practice' },
  { id: 10, name: 'Gel antibacterial 1L', category: 'Higiene', branch: 'Aguascalientes', stock: 16, origin: 'practice' },
];

const initialInvoices = [
  { id: 1, supplier: 'Suministros del Centro', reference: 'RC-1042', date: '2026-03-12', amount: 4280.5, possibleDuplicate: false, origin: 'practice', status: 'pending_review', items: [], history: [] },
  { id: 2, supplier: 'Higiene y Limpieza', reference: 'HL-2088', date: '2026-03-15', amount: 7960, possibleDuplicate: false, origin: 'practice', status: 'pending_review', items: [], history: [] },
  { id: 3, supplier: 'Suministros del Centro', reference: 'RC-1051', date: '2026-03-18', amount: 2150.75, possibleDuplicate: false, origin: 'practice', status: 'pending_review', items: [], history: [] },
  { id: 4, supplier: 'Suministros del Centro', reference: 'RC-1051', date: '2026-03-18', amount: 2150.75, possibleDuplicate: true, origin: 'practice', status: 'possible_duplicate', items: [], history: [] },
];

function readDataFile() {
  if (!dataFile || !fs.existsSync(dataFile)) return null;
  const contents = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  if (
    ![1, 2, 3].includes(contents?.schemaVersion)
    || !Array.isArray(contents.products)
    || !Array.isArray(contents.invoices)
    || !Array.isArray(contents.equivalenceGroups)
    || (contents.schemaVersion === 2 && !Array.isArray(contents.inventoryMovements))
  ) {
    throw new Error('El archivo de datos de Río Claro no tiene un formato compatible; no se modificó.');
  }
  if (contents.schemaVersion === 1) {
    contents.products = contents.products.map((item) => ({ origin: 'practice', ...item }));
    contents.invoices = contents.invoices.map((item) => ({ origin: 'practice', ...item }));
    contents.equivalenceGroups = contents.equivalenceGroups.map(([key, group]) => [
      `practice:${key}`,
      group,
    ]);
  }
  contents.inventoryMovements ??= [];
  contents.complaints ??= [];
  contents.canonicalProducts ??= [];
  contents.normalizationReviews ??= [];
  return contents;
}

const persistedData = readDataFile();
const migrationFromSchema = persistedData?.schemaVersion ?? 0;
const migrationRequired = Boolean(persistedData && migrationFromSchema < 3);
let products = persistedData?.products ?? initialProducts;
let invoices = persistedData?.invoices ?? initialInvoices;
let complaints = persistedData?.complaints ?? [];
let inventoryMovements = persistedData?.inventoryMovements ?? [];
let nextId = persistedData?.nextId
  ?? Math.max(0, ...products.map((item) => item.id), ...invoices.map((item) => item.id)) + 1;

function persistData() {
  if (!dataFile) return;
  const directory = path.dirname(dataFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryFile = `${dataFile}.${process.pid}.tmp`;
  const contents = JSON.stringify({
    schemaVersion: 3,
    nextId,
    products,
    invoices,
    complaints,
    inventoryMovements,
    canonicalProducts,
    normalizationReviews,
    normalizationMigrationReport,
    equivalenceGroups: [...equivalenceGroups.entries()].map(([key, group]) => [key, {
      confirmedProductIds: [...group.confirmedProductIds],
      confirmedAt: group.confirmedAt,
      reviewEvidenceProvided: group.reviewEvidenceProvided,
    }]),
  });
  fs.writeFileSync(temporaryFile, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporaryFile, dataFile);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
}

const origins = [...new Set([...products.map((item) => item.origin ?? 'practice'), 'practice', 'operational'])];
for (const item of products) item.origin ??= 'practice';
for (const item of invoices) item.origin ??= 'practice';

const equivalenceGroups = new Map();
for (const origin of origins) {
  for (const definition of productEquivalenceDefinitions) {
    const candidateNames = new Set([definition.canonicalName, ...definition.aliases].map(normalizeProductName));
    const candidateProductIds = products
      .filter((product) => product.origin === origin && candidateNames.has(normalizeProductName(product.name)))
      .map((product) => product.id);
    const persistedGroup = persistedData?.equivalenceGroups?.find(([key]) => key === `${origin}:${definition.id}`)?.[1];
    equivalenceGroups.set(`${origin}:${definition.id}`, {
      ...definition,
      origin,
      candidateProductIds,
      confirmedProductIds: new Set(persistedGroup?.confirmedProductIds ?? []),
      confirmedAt: persistedGroup?.confirmedAt ?? null,
      reviewEvidenceProvided: persistedGroup?.reviewEvidenceProvided ?? false,
    });
  }
}

let canonicalProducts = persistedData?.canonicalProducts ?? [];
let normalizationReviews = persistedData?.normalizationReviews ?? [];
let normalizationMigrationReport = persistedData?.normalizationMigrationReport ?? null;

function groupForProduct(product) {
  const definition = equivalenceDefinitionForName(product.name);
  return definition ? equivalenceGroups.get(`${product.origin}:${definition.id}`) : null;
}

function groupIsFullyConfirmed(group) {
  return group.candidateProductIds.length > 0
    && group.candidateProductIds.every((id) => group.confirmedProductIds.has(id));
}

function productAliases(group) {
  return [...new Set([group.canonicalName, ...group.aliases])];
}

function sameCategory(left, right) {
  return normalizeProductName(left.category) === normalizeProductName(right.category);
}

function uniqueProductNames(items) {
  return [...new Set(items.flatMap((item) => [item.name, ...(item.aliases ?? [])])
    .filter((name) => typeof name === 'string' && name.trim()))];
}

function addNormalizationReview({ id, origin, productIds, suggestedCanonicalName, reason }) {
  const existing = normalizationReviews.find((review) => review.id === id);
  if (existing) {
    existing.productIds = [...productIds];
    existing.suggestedCanonicalName = suggestedCanonicalName;
    existing.reason = reason;
    existing.status = 'pending_review';
    return existing;
  }
  const review = {
    id,
    origin,
    productIds: [...productIds],
    suggestedCanonicalName,
    reason,
    status: 'pending_review',
    createdAt: new Date().toISOString(),
  };
  normalizationReviews.push(review);
  return review;
}

function rebuildCanonicalCatalog() {
  for (const product of products) {
    product.origin ??= 'practice';
    product.normalizedName = normalizeProductName(product.name);
    product.canonicalProductId = product.id;
    product.normalizationStatus = 'normalized';
  }

  const assigned = new Set();
  const candidateProductIds = new Set();
  const canonicalRecords = [];
  const reviewedIds = new Set();
  const productById = (id) => products.find((product) => product.id === id);

  for (const group of equivalenceGroups.values()) {
    const candidates = group.candidateProductIds
      .map(productById)
      .filter((product) => product && product.origin === group.origin);
    if (!candidates.length) continue;
    if (groupIsFullyConfirmed(group)) {
      const canonical = candidates.find((product) => product.id === Math.min(...candidates.map((item) => item.id)));
      const valid = candidates.every((product) => sameCategory(canonical, product))
        && new Set(candidates.map((product) => product.branch)).size === candidates.length
        && candidates.every((product) => !conflictingProductAttributes(canonical, product));
      if (valid) {
        const memberIds = candidates.map((product) => product.id);
        const aliases = productAliases(group);
        for (const product of candidates) {
          product.canonicalProductId = canonical.id;
          product.normalizationStatus = 'confirmed';
          assigned.add(product.id);
        }
        canonicalRecords.push({
          id: canonical.id,
          origin: group.origin,
          canonicalName: group.canonicalName,
          normalizedName: normalizeProductName(group.canonicalName),
          category: canonical.category,
          aliases: [...new Set([...aliases, ...uniqueProductNames(candidates)])],
          memberIds,
          normalizationStatus: 'confirmed',
          reviewRequired: false,
          stockIndependenceConfirmed: false,
        });
        const review = normalizationReviews.find((item) => item.id === `legacy:${group.origin}:${group.id}`);
        if (review) review.status = 'confirmed_identity_stock_separate';
      }
    } else {
      const memberIds = candidates.map((product) => product.id);
      for (const product of candidates) {
        product.normalizationStatus = 'review_required';
        product.reviewCandidateIds = memberIds;
        candidateProductIds.add(product.id);
        reviewedIds.add(product.id);
      }
        const exactNameMembers = new Set();
        for (const candidate of candidates) {
          if (exactNameMembers.has(candidate.id)) continue;
          const sameName = products.filter((product) =>
            product.origin === group.origin
            && product.normalizedName === candidate.normalizedName
            && sameCategory(candidate, product)
            && !conflictingProductAttributes(candidate, product),
          );
          const canonical = sameName.reduce((selected, product) =>
            product.id < selected.id ? product : selected,
          );
          const memberIdsForName = sameName.map((product) => product.id);
          const independentBranches = new Set(sameName.map((product) => product.branch)).size === sameName.length;
          if (sameName.length > 1 && independentBranches) {
            for (const product of sameName) {
              product.canonicalProductId = canonical.id;
              product.normalizationStatus = 'review_required';
              product.reviewCandidateIds = memberIds;
              exactNameMembers.add(product.id);
              assigned.add(product.id);
            }
          } else {
            exactNameMembers.add(candidate.id);
            assigned.add(candidate.id);
          }
          canonicalRecords.push({
            id: canonical.id,
            origin: group.origin,
            canonicalName: canonicalProductDisplayName(canonical.name),
            normalizedName: canonical.normalizedName,
            category: canonical.category,
            aliases: uniqueProductNames(sameName),
            memberIds: sameName.length > 1 && independentBranches ? memberIdsForName : [candidate.id],
            normalizationStatus: 'review_required',
            reviewRequired: true,
            reviewCandidateIds: memberIds,
            stockIndependenceConfirmed: false,
          });
        }
        addNormalizationReview({
        id: `legacy:${group.origin}:${group.id}`,
        origin: group.origin,
        productIds: memberIds,
        suggestedCanonicalName: group.canonicalName,
        reason: 'La equivalencia semántica está propuesta, pero no hay evidencia verificada de presentación, composición o marca.',
      });
    }
  }

  const byExactIdentity = new Map();
  for (const product of products) {
    if (assigned.has(product.id) || candidateProductIds.has(product.id)) continue;
    const key = `${product.origin}:${product.normalizedName}`;
    const group = byExactIdentity.get(key) ?? [];
    group.push(product);
    byExactIdentity.set(key, group);
  }

  for (const [key, candidates] of byExactIdentity) {
    if (candidates.length === 1) continue;
    const canonical = candidates.reduce((selected, product) =>
      product.id < selected.id ? product : selected,
    );
    const compatible = candidates.every((product) =>
      sameCategory(canonical, product) && !conflictingProductAttributes(canonical, product),
    );
    const independentBranches = new Set(candidates.map((product) => product.branch)).size === candidates.length;
    if (compatible && independentBranches) {
      const memberIds = candidates.map((product) => product.id);
      const aliases = uniqueProductNames(candidates);
      for (const product of candidates) {
        product.canonicalProductId = canonical.id;
        product.normalizationStatus = 'confirmed';
        assigned.add(product.id);
      }
      canonicalRecords.push({
        id: canonical.id,
        origin: canonical.origin,
        canonicalName: canonicalProductDisplayName(canonical.name),
        normalizedName: canonical.normalizedName,
        category: canonical.category,
        aliases,
        memberIds,
        normalizationStatus: 'confirmed',
        reviewRequired: false,
        stockIndependenceConfirmed: false,
      });
      continue;
    }

    const origin = candidates[0].origin;
    const reviewId = `exact:${key}`;
    const suggestedCanonicalName = canonicalProductDisplayName(canonical.name);
    for (const product of candidates) {
      product.normalizationStatus = 'review_required';
      product.reviewCandidateIds = candidates.map((candidate) => candidate.id);
      reviewedIds.add(product.id);
    }
    addNormalizationReview({
      id: reviewId,
      origin,
      productIds: candidates.map((product) => product.id),
      suggestedCanonicalName,
      reason: !compatible
        ? 'Los productos con la misma clave tienen categorías o atributos incompatibles.'
        : 'Hay varias fichas para la misma sucursal; no se consolidaron existencias.',
    });
  }

  const canonicalIds = new Set(canonicalRecords.map((record) => record.id));
  for (const product of products) {
    if (canonicalIds.has(product.canonicalProductId)) continue;
    canonicalRecords.push({
      id: product.id,
      origin: product.origin,
      canonicalName: canonicalProductDisplayName(product.name),
      normalizedName: product.normalizedName,
      category: product.category,
      aliases: uniqueProductNames([product]),
      memberIds: [product.id],
      normalizationStatus: product.normalizationStatus,
      reviewRequired: product.normalizationStatus === 'review_required',
      reviewCandidateIds: product.reviewCandidateIds ?? [],
      stockIndependenceConfirmed: false,
    });
  }

  canonicalProducts = canonicalRecords.sort((left, right) =>
    left.origin.localeCompare(right.origin)
      || left.canonicalName.localeCompare(right.canonicalName, 'es-MX')
      || left.id - right.id,
  );
  return reviewedIds;
}

function branchStocksFor(record, allowed, selectedBranch) {
  return record.memberIds
    .map((id) => products.find((product) => product.id === id))
    .filter((product) =>
      product
      && product.origin === record.origin
      && (!allowed || allowed.has(product.branch))
      && (!selectedBranch || product.branch === selectedBranch),
    )
    .map((product) => ({ name: product.branch, stock: product.stock, productId: product.id }))
    .sort((left, right) => left.name.localeCompare(right.name, 'es-MX'));
}

export function listProducts({
  allowedBranches,
  origin = 'practice',
  search = '',
  category = '',
  branch = '',
} = {}) {
  rebuildCanonicalCatalog();
  const allowed = allowedBranches ? new Set(allowedBranches) : null;
  const query = normalizeProductName(search);
  return canonicalProducts.flatMap((record) => {
    if (record.origin !== origin) return [];
    const branchStocks = branchStocksFor(record, allowed, branch);
    if (!branchStocks.length) return [];
    if (category && normalizeProductName(category) !== normalizeProductName(record.category)) return [];
    const memberNames = record.memberIds.flatMap((id) => {
      const product = products.find((candidate) => candidate.id === id);
      return product ? [product.name, ...(product.aliases ?? [])] : [];
    });
    if (query && ![record.canonicalName, record.normalizedName, ...record.aliases, ...memberNames]
      .some((value) => normalizeProductName(value).includes(query))) return [];
    const candidateIds = record.reviewCandidateIds ?? [];
    const unresolvedLegacyGroup = candidateIds.length
      ? [...equivalenceGroups.values()].find((group) =>
        group.origin === origin
        && !groupIsFullyConfirmed(group)
        && candidateIds.some((id) => group.candidateProductIds.includes(id)),
      )
      : null;
    return [{
      id: record.id,
      canonicalProductId: record.id,
      name: record.canonicalName,
      category: record.category,
      origin,
      branch: branchStocks.length === 1 ? branchStocks[0].name : 'Varias sucursales',
      branches: branchStocks,
      ...(branchStocks.length === 1 ? { stock: branchStocks[0].stock } : {}),
      aliases: record.aliases,
      sourceIds: branchStocks.map((item) => item.productId),
      normalizedName: record.normalizedName,
      normalizationStatus: record.normalizationStatus,
      reviewRequired: record.reviewRequired,
      ...(record.reviewRequired
        ? {
          suggestedCanonicalName: unresolvedLegacyGroup?.canonicalName ?? record.canonicalName,
          reviewCandidateIds: candidateIds,
        }
        : {}),
    }];
  });
}

export function inspectProductRegistration({ name, category, branch, origin = 'practice' }) {
  rebuildCanonicalCatalog();
  const normalizedName = normalizeProductName(name);
  const exactCandidates = products.filter((product) =>
    product.origin === origin && product.normalizedName === normalizedName,
  );
  const definition = equivalenceDefinitionForName(name);
  const group = definition ? equivalenceGroups.get(`${origin}:${definition.id}`) : null;
  if (group?.candidateProductIds.length && !groupIsFullyConfirmed(group)) {
    return {
      reviewRequired: true,
      canonicalName: group.canonicalName,
      candidateIds: [...group.candidateProductIds],
      reason: 'equivalence_pending_human_review',
    };
  }

  const candidates = group?.candidateProductIds.length
    ? group.candidateProductIds.map((id) => products.find((product) => product.id === id)).filter(Boolean)
    : exactCandidates;
  if (candidates.length) {
    const incompatible = candidates.some((product) =>
      !sameCategory(product, { category })
      || conflictingProductAttributes(product, { manufacturer: '', composition: '', presentation: '' }),
    );
    if (incompatible) {
      return {
        reviewRequired: true,
        canonicalName: group?.canonicalName ?? canonicalProductDisplayName(name),
        candidateIds: candidates.map((product) => product.id),
        reason: 'name_match_attribute_review',
      };
    }
    if (candidates.filter((product) => product.branch === branch).length > 1) {
      return {
        reviewRequired: true,
        canonicalName: group?.canonicalName ?? canonicalProductDisplayName(name),
        candidateIds: candidates.filter((product) => product.branch === branch).map((product) => product.id),
        reason: 'multiple_same_branch_records',
      };
    }
    const existing = candidates.find((product) => product.branch === branch);
    if (existing) {
      return {
        duplicate: true,
        canonicalName: group?.canonicalName ?? canonicalProductDisplayName(existing.name),
        existingId: existing.id,
        canonicalProductId: existing.canonicalProductId ?? existing.id,
      };
    }
    const canonicalProductId = Math.min(...candidates.map((product) =>
      product.canonicalProductId ?? product.id,
    ));
    return {
      canonicalName: group?.canonicalName ?? canonicalProductDisplayName(candidates[0].name),
      canonicalProductId,
      ...(group ? { equivalenceGroupId: `${origin}:${group.id}` } : {}),
    };
  }
  return {};
}

export function confirmProductEquivalence({ productIds, evidence, origin = 'practice' }) {
  const definition = productEquivalenceDefinitions.find((candidate) => {
    const group = equivalenceGroups.get(`${origin}:${candidate.id}`);
    if (!group) return false;
    return productIds.length === group.candidateProductIds.length
      && group.candidateProductIds.every((id) => productIds.includes(id));
  });
  if (!definition) {
    return { error: 'Los registros seleccionados no coinciden con un conjunto completo de candidatos.' };
  }

  const group = equivalenceGroups.get(`${origin}:${definition.id}`);
  const candidates = group.candidateProductIds.map((id) => products.find((product) => product.id === id));
  const canonical = candidates[0];
  if (
    candidates.some((candidate) => candidate.category !== canonical.category)
    || new Set(candidates.map((candidate) => candidate.branch)).size !== candidates.length
    || candidates.some((candidate) => conflictingProductAttributes(canonical, candidate))
  ) {
    return { error: 'Los registros tienen atributos incompatibles o existencias en la misma sucursal.' };
  }

  group.confirmedProductIds = new Set(group.candidateProductIds);
  group.confirmedAt = new Date().toISOString();
  group.reviewEvidenceProvided = Boolean(evidence);
  rebuildCanonicalCatalog();
  persistData();
  const item = listProducts({ origin }).find((product) => product.id === Math.min(...productIds));
  return { item, confirmedAt: group.confirmedAt };
}

export function matchInvoiceProduct(detectedName, attributes = {}, origin = 'practice') {
  rebuildCanonicalCatalog();
  const definition = equivalenceDefinitionForName(detectedName);
  if (definition) {
    const group = equivalenceGroups.get(`${origin}:${definition.id}`);
    if (!group) {
      return { detectedName, product: null, candidates: [], requiresHumanReview: true };
    }
    if (!groupIsFullyConfirmed(group)) {
      return {
        detectedName,
        product: null,
        candidates: group.candidateProductIds.map((id) => {
          const product = products.find((candidate) => candidate.id === id);
          return { id: product.id, name: product.name };
        }),
        suggestedCanonicalName: group.canonicalName,
        requiresHumanReview: true,
      };
    }

    const product = products.find((candidate) => candidate.id === group.candidateProductIds[0]);
    if (conflictingProductAttributes(product, attributes)) {
      return {
        detectedName,
        product: null,
        candidates: [{ id: product.id, name: group.canonicalName }],
        requiresHumanReview: true,
      };
    }
    return {
      detectedName,
      product: {
        id: product.canonicalProductId ?? product.id,
        name: group.canonicalName,
      },
      matchedBy: 'confirmed_alias',
      requiresHumanReview: false,
    };
  }

  const matches = listProducts({ origin, search: detectedName })
    .filter((product) => product.normalizedName === normalizeProductName(detectedName));
  if (matches.length === 1) {
    const matched = matches[0];
    const source = products.find((product) => product.id === matched.id);
    if (source && conflictingProductAttributes(source, attributes)) {
      return {
        detectedName,
        product: null,
        candidates: [{ id: matched.id, name: matched.name }],
        requiresHumanReview: true,
      };
    }
    return {
      detectedName,
      product: { id: matched.id, name: matched.name },
      matchedBy: 'normalized_name',
      requiresHumanReview: false,
    };
  }
  return {
    detectedName,
    product: null,
    candidates: matches.map((product) => ({ id: product.id, name: product.name })),
    requiresHumanReview: true,
  };
}

export function addProduct(product) {
  const registration = inspectProductRegistration(product);
  if (registration.reviewRequired) {
    return { duplicate: false, requiresHumanReview: true, ...registration };
  }
  if (registration.duplicate) {
    return { duplicate: true, item: products.find((candidate) => candidate.id === registration.existingId) };
  }
  const item = {
    id: nextId++,
    ...product,
    normalizedName: normalizeProductName(product.name),
    canonicalProductId: registration.canonicalProductId ?? nextId - 1,
  };
  products = [item, ...products];
  if (registration.equivalenceGroupId) {
    const group = equivalenceGroups.get(registration.equivalenceGroupId);
    group.candidateProductIds.push(item.id);
    group.confirmedProductIds.add(item.id);
  }
  rebuildCanonicalCatalog();
  persistData();
  return { ...item, duplicate: false, requiresHumanReview: false };
}

export function getProductDetails({
  productId,
  allowedBranches,
  origin = 'practice',
  includeInvoiceReferences = false,
} = {}) {
  rebuildCanonicalCatalog();
  const record = canonicalProducts.find((candidate) =>
    candidate.id === productId && candidate.origin === origin,
  );
  if (!record) return null;
  const allowed = allowedBranches ? new Set(allowedBranches) : null;
  const memberProducts = record.memberIds
    .map((id) => products.find((product) => product.id === id))
    .filter((product) => product && (!allowed || allowed.has(product.branch)));
  if (!memberProducts.length) return null;
  const memberIds = new Set(memberProducts.map((product) => product.id));
  const movements = inventoryMovements.filter((movement) =>
    movement.origin === origin
    && memberIds.has(movement.productId)
    && (!allowed || allowed.has(movement.branch)),
  );
  return {
    item: {
      id: record.id,
      canonicalProductId: record.id,
      name: record.canonicalName,
      normalizedName: record.normalizedName,
      category: record.category,
      aliases: record.aliases,
      normalizationStatus: record.normalizationStatus,
      reviewRequired: record.reviewRequired,
      branches: memberProducts
        .map((product) => ({ productId: product.id, name: product.branch, stock: product.stock }))
        .sort((left, right) => left.name.localeCompare(right.name, 'es-MX')),
    },
    movements: structuredClone(movements),
    invoiceReferences: includeInvoiceReferences
      ? invoices.filter((invoice) => invoice.origin === origin
        && (!allowed || allowed.has(invoice.branch))
        && invoice.items.some((line) =>
          memberIds.has(line.productId)
          || memberProducts.some((product) => (product.canonicalProductId ?? product.id) === line.productId),
        ))
      .map((invoice) => ({
        invoiceId: invoice.id,
        supplier: invoice.supplier,
        reference: invoice.reference,
        date: invoice.date,
        status: invoice.status,
      }))
      : [],
  };
}

export function listInvoices(origin = 'practice') {
  return invoices
    .filter((invoice) => invoice.origin === origin)
    .map((invoice) => structuredClone(invoice));
}

export function getInvoice(invoiceId, origin = 'practice') {
  const invoice = invoices.find((item) => item.id === invoiceId && item.origin === origin);
  return invoice ? structuredClone(invoice) : null;
}

export function assignInvoiceProduct({ invoiceId, itemIndex, productId, evidence, origin = 'practice' }) {
  const invoice = invoices.find((item) => item.id === invoiceId && item.origin === origin);
  if (!invoice || !Array.isArray(invoice.items) || !invoice.items[itemIndex]) {
    return { error: 'No se encontró la factura o la línea seleccionada.' };
  }
  if (['confirmed', 'rejected'].includes(invoice.status)) {
    return { error: 'La factura ya tiene un estado final y no admite cambios.' };
  }
  const product = products.find((item) =>
    item.origin === origin
    && (item.id === productId || (item.canonicalProductId ?? item.id) === productId),
  );
  if (!product) return { error: 'El producto seleccionado no está disponible en este conjunto de datos.' };
  const canonicalProductId = product.canonicalProductId ?? product.id;
  const canonicalRecord = canonicalProducts.find((item) =>
    item.id === canonicalProductId && item.origin === origin,
  );
  invoice.items[itemIndex] = {
    ...invoice.items[itemIndex],
    productId: canonicalProductId,
    matchedProductName: canonicalRecord?.canonicalName ?? canonicalProductDisplayName(product.name),
    requiresHumanReview: false,
    matchEvidence: evidence,
  };
  invoice.history.push({
    status: 'product_match_confirmed',
    at: new Date().toISOString(),
    evidence,
  });
  persistData();
  return { item: structuredClone(invoice) };
}

export function reviewInvoice({ invoiceId, decision, evidence, userId, origin = 'practice' }) {
  const invoice = invoices.find((item) => item.id === invoiceId && item.origin === origin);
  if (!invoice) return { error: 'No se encontró la factura.' };
  if (['confirmed', 'rejected'].includes(invoice.status)) {
    return { error: 'La factura ya tiene un estado final.' };
  }
  if (!['confirm', 'confirm_distinct', 'reject'].includes(decision)) {
    return { error: 'La decisión de revisión no es válida.' };
  }
  if (invoice.possibleDuplicate && decision === 'confirm') {
    return { error: 'La factura requiere una confirmación humana de que es distinta de la coincidencia detectada.' };
  }
  if (!invoice.possibleDuplicate && decision === 'confirm_distinct') {
    return { error: 'Esta factura no tiene una coincidencia que requiera confirmación de distinción.' };
  }
  if (
    decision !== 'reject'
    && invoice.items.some((item) => !Number.isInteger(item.productId) || item.requiresHumanReview)
  ) {
    return { error: 'Relaciona cada artículo con el inventario antes de confirmar la factura.' };
  }

  const status = decision === 'reject' ? 'rejected' : 'confirmed';
  if (status === 'confirmed' && !invoice.inventoryPostedAt) {
    const postingPlan = [];
    const newTargets = new Map();
    const projectedStock = new Map();
    for (const [index, line] of invoice.items.entries()) {
      const source = products.find((product) =>
        product.origin === origin
        && (product.id === line.productId || (product.canonicalProductId ?? product.id) === line.productId),
      );
      if (!source) return { error: 'Un producto relacionado ya no está disponible; revisa la factura nuevamente.' };
      const candidateGroup = groupForProduct(source);
      const group = candidateGroup && groupIsFullyConfirmed(candidateGroup) ? candidateGroup : null;
      const canonicalProductId = source.canonicalProductId ?? source.id;
      const branchProduct = products.find((product) =>
        product.origin === origin
        && product.branch === invoice.branch
        && (product.canonicalProductId ?? product.id) === canonicalProductId,
      );
      const targetKey = branchProduct?.id ?? `${canonicalProductId}:${invoice.branch}`;
      let target = branchProduct ?? newTargets.get(targetKey);
      if (!target) {
        target = {
          name: group?.canonicalName ?? source.name,
          category: source.category,
          branch: invoice.branch,
          stock: 0,
          origin,
          canonicalProductId,
        };
        newTargets.set(targetKey, target);
      }
      const projected = projectedStock.get(targetKey) ?? target.stock;
      if (projected + line.quantity > 1_000_000) {
        return { error: 'La existencia resultante supera el máximo permitido; revisa las cantidades.' };
      }
      projectedStock.set(targetKey, projected + line.quantity);
      postingPlan.push({ index, line, target, targetKey, group });
    }

    for (const [targetKey, target] of newTargets) {
      target.id = nextId++;
      products.unshift(target);
      const planEntry = postingPlan.find((entry) => entry.targetKey === targetKey);
      if (planEntry?.group) {
        planEntry.group.candidateProductIds.push(target.id);
        planEntry.group.confirmedProductIds.add(target.id);
      }
    }
    for (const { index, line, target } of postingPlan) {
      target.stock += line.quantity;
      line.postedProductId = target.id;
      inventoryMovements.push({
        id: nextId++,
        invoiceId: invoice.id,
        invoiceItemIndex: index,
        productId: target.id,
        quantity: line.quantity,
        branch: invoice.branch,
        type: 'invoice_receipt',
        origin,
        createdAt: new Date().toISOString(),
      });
    }
    invoice.inventoryPostedAt = new Date().toISOString();
    rebuildCanonicalCatalog();
  }
  invoice.status = status;
  invoice.history.push({
    status,
    at: new Date().toISOString(),
    userId,
    evidence,
  });
  persistData();
  return { item: structuredClone(invoice) };
}

export function listInventoryMovements(origin = 'practice', allowedBranches) {
  const allowed = Array.isArray(allowedBranches) ? new Set(allowedBranches) : null;
  return inventoryMovements
    .filter((movement) => movement.origin === origin && (!allowed || allowed.has(movement.branch)))
    .map((movement) => ({ ...movement }));
}

export function getNormalizationReport(origin = 'practice') {
  const pendingReviews = normalizationReviews
    .filter((review) => review.origin === origin && review.status === 'pending_review')
    .map((review) => structuredClone(review));
  return {
    ...(normalizationMigrationReport ? structuredClone(normalizationMigrationReport) : {
      completedAt: null,
      sourceSchemaVersion: 3,
      targetSchemaVersion: 3,
    }),
    origin,
    productRecordCount: products.filter((product) => product.origin === origin).length,
    canonicalProductCount: canonicalProducts.filter((product) => product.origin === origin).length,
    pendingReviewCount: pendingReviews.length,
    pendingReviews,
    stockWasConsolidated: false,
    movementRecordsChanged: 0,
    invoiceReferencesRewritten: 0,
  };
}

export function resetPracticeData() {
  products = products.filter((product) => product.origin !== 'practice');
  invoices = invoices.filter((invoice) => invoice.origin !== 'practice');
  for (const group of equivalenceGroups.values()) {
    if (group.origin !== 'practice') continue;
    group.candidateProductIds = [];
    group.confirmedProductIds.clear();
    group.confirmedAt = null;
    group.reviewEvidenceProvided = false;
  }
  normalizationReviews = normalizationReviews.filter((review) => review.origin !== 'practice');
  rebuildCanonicalCatalog();
  persistData();
}

export function addInvoice(invoice) {
  const normalize = (value) => normalizeProductName(value);
  const sameSupplierAndFolio = (existing) =>
    existing.origin === (invoice.origin ?? 'practice')
    && normalize(existing.supplier) === normalize(invoice.supplier)
    && normalize(existing.reference) === normalize(invoice.reference);
  const exactDuplicate = invoices.find((existing) =>
    sameSupplierAndFolio(existing)
    && existing.date === invoice.date
    && (existing.currency ?? 'MXN') === (invoice.currency ?? 'MXN')
    && existing.amount === invoice.amount,
  );
  if (exactDuplicate) {
    return {
      item: { ...exactDuplicate },
      possibleDuplicate: true,
      requiresHumanReview: true,
      created: false,
    };
  }
  const possibleDuplicate = invoices.some(sameSupplierAndFolio);
  const item = {
    id: nextId++,
    ...invoice,
    origin: invoice.origin ?? 'practice',
    possibleDuplicate,
    status: possibleDuplicate ? 'possible_duplicate' : 'pending_review',
    items: invoice.items ?? [],
    history: [{ status: possibleDuplicate ? 'possible_duplicate' : 'pending_review', at: new Date().toISOString() }],
  };
  invoices = [item, ...invoices];
  persistData();
  return { item, possibleDuplicate, requiresHumanReview: possibleDuplicate, created: true };
}

export function getDashboard({ origin = 'practice' } = {}) {
  const visibleProducts = listProducts({ origin });
  const visibleInvoices = invoices.filter((invoice) => invoice.origin === origin);
  const visibleRawProducts = products.filter((product) => product.origin === origin);
  const pendingGroups = [...equivalenceGroups.values()].filter((group) =>
    group.origin === origin && !groupIsFullyConfirmed(group),
  );
  return {
    productCount: visibleProducts.length,
    invoiceCount: visibleInvoices.filter((invoice) => !invoice.possibleDuplicate).length,
    pendingAlerts: visibleInvoices.filter((invoice) => invoice.possibleDuplicate).length
      + visibleRawProducts.filter((product) => product.stock === 0).length
      + pendingGroups.length,
    branches: branches.map((name) => ({
      name,
      products: visibleProducts.filter((product) => product.branches.some((branch) => branch.name === name)).length,
    })),
    recentActivity: [
      ...(visibleInvoices.some((invoice) => invoice.possibleDuplicate)
        ? [{ title: 'Factura con posible coincidencia', detail: 'Pendiente de revisión humana' }]
        : []),
      ...(pendingGroups.length ? [{ title: 'Productos por conciliar', detail: 'Revisión de equivalencias pendiente' }] : []),
      { title: `${visibleProducts.length} productos disponibles`, detail: 'Catálogo de la sucursal de datos seleccionada' },
    ],
  };
}

function addComplaintHistoryEntry(complaint, status, actor, note) {
  complaint.history.push({
    status,
    at: new Date().toISOString(),
    actor: actor ?? 'system',
    note: typeof note === 'string' ? note.trim() : '',
  });
}

export function listComplaints({ origin = 'practice', branch = null, status = null } = {}) {
  return complaints
    .filter((complaint) => complaint.origin === origin)
    .filter((complaint) => !branch || complaint.branch === branch)
    .filter((complaint) => !status || complaint.status === status)
    .map((complaint) => ({
      ...structuredClone(complaint),
      slaMinutes: complaint.firstResponseAt
        ? Math.max(0, (new Date(complaint.firstResponseAt).getTime() - new Date(complaint.receivedAt).getTime()) / 60000)
        : null,
      slaBreached: complaint.firstResponseAt
        ? (new Date(complaint.firstResponseAt).getTime() - new Date(complaint.receivedAt).getTime()) > 15 * 60 * 1000
        : true,
    }));
}

export function getComplaint(complaintId, origin = 'practice') {
  const complaint = complaints.find((item) => item.id === complaintId && item.origin === origin);
  if (!complaint) return null;
  return {
    ...structuredClone(complaint),
    slaMinutes: complaint.firstResponseAt
      ? Math.max(0, (new Date(complaint.firstResponseAt).getTime() - new Date(complaint.receivedAt).getTime()) / 60000)
      : null,
    slaBreached: complaint.firstResponseAt
      ? (new Date(complaint.firstResponseAt).getTime() - new Date(complaint.receivedAt).getTime()) > 15 * 60 * 1000
      : true,
  };
}

export function createComplaint(payload) {
  const { branch, customerName, description, category, origin = 'practice', actor = 'system', contactChannel, contactValue } = payload ?? {};
  if (!branch || !branch.trim()) {
    return { error: 'La sucursal es obligatoria.' };
  }
  if (!customerName || !String(customerName).trim()) {
    return { error: 'El nombre del cliente es obligatorio.' };
  }
  if (!description || !String(description).trim()) {
    return { error: 'La descripción de la reclamación es obligatoria.' };
  }
  if (!category || !String(category).trim()) {
    return { error: 'La categoría es obligatoria.' };
  }
  if (!branches.includes(branch.trim())) {
    return { error: 'La sucursal seleccionada no existe.' };
  }
  const item = {
    id: nextId++,
    origin,
    branch: branch.trim(),
    customerName: String(customerName).trim(),
    contactChannel: typeof contactChannel === 'string' && contactChannel.trim() ? contactChannel.trim() : null,
    contactValue: typeof contactValue === 'string' && contactValue.trim() ? contactValue.trim() : null,
    description: String(description).trim(),
    category: String(category).trim(),
    status: 'pending',
    assignedTo: null,
    receivedAt: new Date().toISOString(),
    firstResponseAt: null,
    history: [{
      status: 'pending',
      at: new Date().toISOString(),
      actor: actor || 'system',
      note: 'Reclamación registrada en el sistema.',
    }],
  };
  complaints = [item, ...complaints];
  persistData();
  return { item: structuredClone(item), created: true };
}

export function updateComplaintStatus({ complaintId, status, note, actor, origin = 'practice' }) {
  if (!complaintStatuses.has(status)) {
    return { error: 'El estado indicado no es válido.' };
  }
  const complaint = complaints.find((item) => item.id === complaintId && item.origin === origin);
  if (!complaint) return { error: 'No se encontró la reclamación.' };
  complaint.status = status;
  addComplaintHistoryEntry(complaint, status, actor, note || 'Cambio de estado del caso en el sistema.');
  if (status === 'in_progress' && !complaint.assignedTo && actor) complaint.assignedTo = actor;
  persistData();
  return { item: structuredClone(complaint) };
}

export function addComplaintResponse({ complaintId, responder, message, origin = 'practice' }) {
  if (typeof message !== 'string' || !message.trim()) {
    return { error: 'La respuesta inicial es obligatoria.' };
  }
  const complaint = complaints.find((item) => item.id === complaintId && item.origin === origin);
  if (!complaint) return { error: 'No se encontró la reclamación.' };
  const timestamp = new Date().toISOString();
  complaint.firstResponseAt ??= timestamp;
  complaint.status = complaint.status === 'pending' ? 'in_progress' : complaint.status;
  complaint.history.push({
    status: complaint.status,
    at: timestamp,
    actor: responder || 'system',
    note: message.trim(),
    event: 'first_response',
  });
  if (responder) complaint.assignedTo = responder;
  persistData();
  return { item: structuredClone(complaint) };
}

export function getComplaintSlaSummary(origin = 'practice') {
  const items = listComplaints({ origin });
  const total = items.length;
  const unresolved = items.filter((item) => !item.firstResponseAt).length;
  const breached = items.filter((item) => item.firstResponseAt && item.slaBreached).length;
  const onTime = items.filter((item) => item.firstResponseAt && !item.slaBreached).length;
  return {
    origin,
    total,
    unresolved,
    onTime,
    breached,
    byBranch: branches.map((branch) => {
      const branchItems = items.filter((item) => item.branch === branch);
      return {
        branch,
        total: branchItems.length,
        unresolved: branchItems.filter((item) => !item.firstResponseAt).length,
        onTime: branchItems.filter((item) => item.firstResponseAt && !item.slaBreached).length,
        breached: branchItems.filter((item) => item.firstResponseAt && item.slaBreached).length,
      };
    }),
  };
}

rebuildCanonicalCatalog();
if (migrationRequired) {
  if (dataFile) {
    const backupFile = `${dataFile}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(dataFile, backupFile, fs.constants.COPYFILE_EXCL);
  }
  normalizationMigrationReport = {
    completedAt: new Date().toISOString(),
    sourceSchemaVersion: migrationFromSchema,
    targetSchemaVersion: 3,
    productsReviewed: products.length,
    confirmedExactIdentityGroups: canonicalProducts.filter((record) =>
      record.memberIds.length > 1 && record.normalizationStatus === 'confirmed',
    ).length,
    pendingReviewGroups: normalizationReviews.filter((review) =>
      review.status === 'pending_review',
    ).length,
    inventoryStocksConsolidated: false,
    inventoryMovementsChanged: 0,
    invoiceReferencesChanged: 0,
    decisions: normalizationReviews.map(({ id, origin, productIds, suggestedCanonicalName, reason, status }) => ({
      id,
      origin,
      productIds,
      suggestedCanonicalName,
      reason,
      status,
    })),
  };
  persistData();
} else if (!persistedData) {
  normalizationMigrationReport = {
    completedAt: new Date().toISOString(),
    sourceSchemaVersion: 0,
    targetSchemaVersion: 3,
    productsReviewed: products.length,
    confirmedExactIdentityGroups: 0,
    pendingReviewGroups: normalizationReviews.filter((review) =>
      review.status === 'pending_review',
    ).length,
    inventoryStocksConsolidated: false,
    inventoryMovementsChanged: 0,
    invoiceReferencesChanged: 0,
    decisions: normalizationReviews.map(({ id, origin, productIds, suggestedCanonicalName, reason, status }) => ({
      id,
      origin,
      productIds,
      suggestedCanonicalName,
      reason,
      status,
    })),
  };
  persistData();
}
