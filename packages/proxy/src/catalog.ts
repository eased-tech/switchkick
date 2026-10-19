/** Per-token prices in USD, as OpenRouter's model list gives them. */
export interface ModelPricing {
  prompt: number;
  completion: number;
  /** Price of a cached input token, where the model has prompt caching. */
  cacheRead?: number;
  /** Price of writing an input token to the cache. */
  cacheWrite?: number;
}

export interface CatalogModel {
  id: string;
  pricing: ModelPricing | null;
}

const price = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * OpenRouter's public model list (`GET /models`, no key needed), by id. Throws with a short
 * message if it can't be fetched.
 */
export async function fetchCatalog(
  fetcher: typeof fetch,
  baseUrl: string,
): Promise<Map<string, CatalogModel>> {
  const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/models`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter's model list answered HTTP ${response.status}`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter's model list had no data");
  const models = new Map<string, CatalogModel>();
  for (const entry of body.data as Record<string, unknown>[]) {
    if (typeof entry?.id !== "string") continue;
    const raw = entry.pricing as Record<string, unknown> | undefined;
    const prompt = price(raw?.prompt);
    const completion = price(raw?.completion);
    let pricing: ModelPricing | null = null;
    if (prompt !== undefined && completion !== undefined) {
      pricing = { prompt, completion };
      const cacheRead = price(raw?.input_cache_read);
      const cacheWrite = price(raw?.input_cache_write);
      if (cacheRead !== undefined) pricing.cacheRead = cacheRead;
      if (cacheWrite !== undefined) pricing.cacheWrite = cacheWrite;
    }
    models.set(entry.id, { id: entry.id, pricing });
  }
  return models;
}
