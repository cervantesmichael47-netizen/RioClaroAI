function canonicalNumber(value) {
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed)) return value;
  return String(Number(parsed.toFixed(6))).replace('.', 'p');
}

function litersFromMilliliters(value) {
  const parsed = Number(value.replace(',', '.')) / 1000;
  if (!Number.isFinite(parsed)) return value;
  return String(Number(parsed.toFixed(6))).replace('.', 'p');
}

export function normalizeProductName(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLocaleLowerCase('es-MX')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:mililitros?|milliliters?|millilitres?|ml)\b/gu,
      (_match, quantity) => `${litersFromMilliliters(quantity)} l`)
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:litros?|liters?|litres?|lt|l)\b/gu,
      (_match, quantity) => `${canonicalNumber(quantity)} l`)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function canonicalProductDisplayName(value) {
  const key = normalizeProductName(value);
  return key.replace(/(^| )(\p{L})/gu, (_match, separator, letter) =>
    `${separator}${letter.toLocaleUpperCase('es-MX')}`,
  ).replace(/(\d+)p(\d+) l\b/giu, '$1.$2 L')
    .replace(/(\d+) l\b/giu, '$1 L');
}

export const productEquivalenceDefinitions = [{
  id: 'chlorine-1l',
  canonicalName: 'Cloro 1 L',
  aliases: ['Cloro 1L', 'CLORO LITRO', 'Blanqueador 1000ml'],
}];

export function equivalenceDefinitionForName(name) {
  const normalizedName = normalizeProductName(name);
  return productEquivalenceDefinitions.find((definition) =>
    [definition.canonicalName, ...definition.aliases]
      .some((alias) => normalizeProductName(alias) === normalizedName),
  ) ?? null;
}

export function conflictingProductAttributes(left, right) {
  const attributes = ['description', 'composition', 'presentation', 'manufacturer', 'brand', 'sku', 'barcode'];
  return attributes.some((attribute) => {
    const leftValue = left[attribute];
    const rightValue = right[attribute];
    return typeof leftValue === 'string'
      && leftValue.trim()
      && typeof rightValue === 'string'
      && rightValue.trim()
      && normalizeProductName(leftValue) !== normalizeProductName(rightValue);
  });
}
