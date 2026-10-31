const branches = ['Guadalajara', 'Zapopan', 'León', 'Querétaro', 'Aguascalientes'];
const catalog = [
  { name: 'Cloro 1 L', unitPriceCents: 2_450 },
  { name: 'Detergente líquido 2 L', unitPriceCents: 5_899 },
  { name: 'Jabón antibacterial 500 ml', unitPriceCents: 3_275 },
  { name: 'Limpiavidrios 750 ml', unitPriceCents: 2_190 },
  { name: 'Papel higiénico institucional', unitPriceCents: 6_450 },
];

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

const today = new Date();
const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

export const syntheticSalesRecords = Array.from({ length: 90 }, (_, dayOffset) => {
  const date = new Date(endDate);
  date.setUTCDate(date.getUTCDate() - (89 - dayOffset));
  const day = date.getUTCDate();
  return branches.flatMap((branch, branchIndex) =>
    [0, 1].map((saleIndex) => {
      const product = catalog[(day + branchIndex + saleIndex) % catalog.length];
      const quantity = 1 + ((day + branchIndex * 2 + saleIndex) % 8);
      return {
        id: `SYN-${dateKey(date)}-${branchIndex}-${saleIndex}`,
        date: dateKey(date),
        branch,
        product: product.name,
        quantity,
        unitPriceCents: product.unitPriceCents,
      };
    }),
  );
}).flat();

function sumCents(records) {
  return records.reduce((sum, record) => sum + record.quantity * record.unitPriceCents, 0);
}

export function getSalesReport({ from, to, branch } = {}) {
  const filtered = syntheticSalesRecords.filter((sale) =>
    sale.date >= from
    && sale.date <= to
    && (!branch || sale.branch === branch),
  );
  const branchNames = branch ? [branch] : branches;
  const branchStats = branchNames.map((name) => {
    const records = filtered.filter((sale) => sale.branch === name);
    const revenueCents = sumCents(records);
    return {
      branch: name,
      revenue: revenueCents / 100,
      orders: records.length,
      units: records.reduce((sum, sale) => sum + sale.quantity, 0),
      averageOrderValue: records.length ? revenueCents / records.length / 100 : 0,
    };
  });
  const products = [...new Set(filtered.map((sale) => sale.product))].map((name) => {
    const records = filtered.filter((sale) => sale.product === name);
    return {
      name,
      units: records.reduce((sum, sale) => sum + sale.quantity, 0),
      revenue: sumCents(records) / 100,
    };
  }).sort((left, right) => right.units - left.units || right.revenue - left.revenue);
  const trendByDate = new Map();
  for (const sale of filtered) {
    const trend = trendByDate.get(sale.date) ?? { date: sale.date, revenueCents: 0, orders: 0 };
    trend.revenueCents += sale.quantity * sale.unitPriceCents;
    trend.orders += 1;
    trendByDate.set(sale.date, trend);
  }
  const totalRevenueCents = sumCents(filtered);

  return {
    source: 'synthetic',
    synthetic: true,
    currency: 'MXN',
    from,
    to,
    branch: branch ?? null,
    dataAvailable: filtered.length > 0,
    totalRevenue: totalRevenueCents / 100,
    totalOrders: filtered.length,
    totalUnits: filtered.reduce((sum, sale) => sum + sale.quantity, 0),
    averageOrderValue: filtered.length ? totalRevenueCents / filtered.length / 100 : 0,
    branches: branchStats,
    topProducts: products.slice(0, 5),
    dailyTrend: [...trendByDate.values()].sort((left, right) => left.date.localeCompare(right.date))
      .map(({ date, revenueCents, orders }) => ({ date, revenue: revenueCents / 100, orders })),
    message: filtered.length
      ? 'Cifras calculadas exclusivamente con registros sintéticos de demostración.'
      : 'No hay registros sintéticos para el periodo y sucursal seleccionados.',
  };
}

export { branches as salesBranches };
