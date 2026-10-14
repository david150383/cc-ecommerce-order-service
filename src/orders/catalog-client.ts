import { HttpProblem } from "../lib/problem.js";
import type { ServiceTokenProvider } from "../security/service-token-provider.js";

export interface CatalogItem {
  sku: string;
  productId: string;
  variantId: string;
  name: string;
  unitPrice: { amountMinor: number; currency: string };
}

export interface PriceLookupResult {
  items: CatalogItem[];
  unavailable: string[];
}

/** The authoritative source of current prices. Tests substitute a fake. */
export interface Catalog {
  lookup(skus: string[]): Promise<PriceLookupResult>;
}

const PRODUCT_AUDIENCE = "ecommerce-product-service";

export class HttpCatalog implements Catalog {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: ServiceTokenProvider,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async lookup(skus: string[]): Promise<PriceLookupResult> {
    let res = await this.call(skus);
    if (res.status === 401) {
      // Our cached token may have been minted with a key the callee no longer trusts: retry once.
      this.tokens.invalidate(PRODUCT_AUDIENCE);
      res = await this.call(skus);
    }
    if (!res.ok) {
      throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", `Product Service responded ${res.status}`);
    }
    return (await res.json()) as PriceLookupResult;
  }

  private async call(skus: string[]): Promise<Response> {
    const token = await this.tokens.token(PRODUCT_AUDIENCE);
    try {
      return await this.fetchImpl(`${this.baseUrl}/internal/v1/products/price-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ skus }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", "Product Service unreachable", undefined, undefined, {
        cause: err,
      });
    }
  }
}
