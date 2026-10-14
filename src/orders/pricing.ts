/**
 * Order pricing in integer minor units. All arithmetic uses BigInt so that no intermediate
 * product (e.g. amount × basis points) can lose precision, however large the order.
 *
 * Rules (documented in docs/api.md):
 *  - line subtotal = unit price × quantity
 *  - a coupon discount is a percentage of the subtotal (floored, optionally capped) and is
 *    ALLOCATED across lines in proportion to their subtotals (largest-remainder method),
 *    so per-line amounts always sum exactly to the order discount
 *  - tax is computed PER LINE on (line subtotal − line discount), rounded half-up
 *  - shipping is free when (subtotal − discount) reaches the threshold
 *  - grand total = subtotal − discount + tax + shipping
 */

export interface PricingLine {
  sku: string;
  quantity: number;
  unitPriceMinor: bigint;
}

export interface Coupon {
  code: string;
  percentBps: number;
  maxDiscountMinor?: number | undefined;
  minSubtotalMinor?: number | undefined;
}

export interface PricingPolicy {
  taxRateBps: number;
  shippingFeeMinor: bigint;
  freeShippingThresholdMinor: bigint;
}

export interface PricedLine extends PricingLine {
  lineSubtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  lineTotalMinor: bigint;
}

export interface PricedOrder {
  lines: PricedLine[];
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  shippingMinor: bigint;
  grandTotalMinor: bigint;
}

const BPS = 10_000n;

/** Half-up rounding of a non-negative fraction numerator / denominator. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function couponDiscount(subtotal: bigint, coupon: Coupon | null): bigint {
  if (!coupon || subtotal === 0n) return 0n;
  if (coupon.minSubtotalMinor !== undefined && subtotal < BigInt(coupon.minSubtotalMinor)) return 0n;
  let discount = (subtotal * BigInt(coupon.percentBps)) / BPS; // floor: never over-discount
  if (coupon.maxDiscountMinor !== undefined && discount > BigInt(coupon.maxDiscountMinor)) {
    discount = BigInt(coupon.maxDiscountMinor);
  }
  return discount;
}

/**
 * Largest-remainder allocation: each line first gets floor(total × weight / Σweights); the
 * few leftover units go to the lines with the largest remainders (earlier line wins ties).
 * Result: integers, proportional, and the sum is exactly `total`.
 */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n || sum === 0n) return weights.map(() => 0n);
  const shares = weights.map((w) => (total * w) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % sum }));
  let leftover = total - shares.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    shares[i]! += 1n;
    leftover -= 1n;
  }
  return shares;
}

export function priceOrder(lines: PricingLine[], policy: PricingPolicy, coupon: Coupon | null): PricedOrder {
  const subtotals = lines.map((l) => l.unitPriceMinor * BigInt(l.quantity));
  const subtotalMinor = subtotals.reduce((a, b) => a + b, 0n);
  const discountMinor = couponDiscount(subtotalMinor, coupon);
  const lineDiscounts = allocate(discountMinor, subtotals);

  const priced = lines.map((line, i) => {
    const lineSubtotalMinor = subtotals[i]!;
    const discount = lineDiscounts[i]!;
    const taxable = lineSubtotalMinor - discount;
    const taxMinor = divideHalfUp(taxable * BigInt(policy.taxRateBps), BPS);
    return { ...line, lineSubtotalMinor, discountMinor: discount, taxMinor, lineTotalMinor: taxable + taxMinor };
  });

  const taxMinor = priced.reduce((a, l) => a + l.taxMinor, 0n);
  const afterDiscount = subtotalMinor - discountMinor;
  const shippingMinor = afterDiscount >= policy.freeShippingThresholdMinor ? 0n : policy.shippingFeeMinor;
  return {
    lines: priced,
    subtotalMinor,
    discountMinor,
    taxMinor,
    shippingMinor,
    grandTotalMinor: afterDiscount + taxMinor + shippingMinor,
  };
}

/** API representation; refuses values JSON numbers cannot represent exactly. */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`amount ${value} exceeds the safe integer range`);
  }
  return Number(value);
}
