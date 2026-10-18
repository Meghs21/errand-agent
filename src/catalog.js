// Product search. Uses the Channel3 API (100M+ real products across 25k+
// retailers) when CHANNEL3_API_KEY is set; otherwise a small built-in catalog
// so the app runs with zero setup.
import { DEMO_PRODUCTS } from "./demo-products.js";

const CHANNEL3_URL = "https://api.trychannel3.com/v1/search";

export const usingChannel3 = Boolean(process.env.CHANNEL3_API_KEY);

export async function searchProducts({ query, maxPrice, minPrice, limit = 6 }) {
  limit = Math.max(1, Math.min(Number(limit) || 6, 10));
  if (usingChannel3) return searchChannel3({ query, maxPrice, minPrice, limit });
  return searchDemo({ query, maxPrice, minPrice, limit });
}

async function searchChannel3({ query, maxPrice, minPrice, limit }) {
  const filters = { availability: "InStock" };
  if (maxPrice != null || minPrice != null) {
    filters.price = {};
    if (minPrice != null) filters.price.min_price = Number(minPrice);
    if (maxPrice != null) filters.price.max_price = Number(maxPrice);
  }
  const res = await fetch(CHANNEL3_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.CHANNEL3_API_KEY,
      "x-user-id": "errand-demo",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, filters, limit }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Channel3 search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return (body.products || []).map(normalizeChannel3).filter((p) => p && p.price > 0);
}

function normalizeChannel3(p) {
  const offer = (p.offers || []).find((o) => o.availability === "InStock") || p.offers?.[0];
  if (!offer?.price) return null;
  const image = (p.images || []).find((i) => i.is_main_image) || p.images?.[0];
  return {
    id: `c3_${p.id}`,
    title: p.title,
    brand: p.brands?.[0]?.name ?? null,
    price: Number(offer.price.price),
    compareAt: offer.price.compare_at_price ?? null,
    currency: offer.price.currency || "USD",
    merchant: offer.domain,
    url: offer.url,
    image: image ? image.cleaned_url ?? image.url : null,
    category: p.category?.title ?? null,
    description: (p.description || "").slice(0, 400),
    features: (p.key_features || []).slice(0, 4),
    source: "channel3",
  };
}

function searchDemo({ query, maxPrice, minPrice, limit }) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  return DEMO_PRODUCTS.filter((p) => (maxPrice == null || p.price <= maxPrice) && (minPrice == null || p.price >= minPrice))
    .map((p) => {
      const text = `${p.title} ${p.brand} ${p.category} ${p.description} ${p.tags.join(" ")}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (text.includes(t) ? (p.tags.includes(t) ? 3 : 1) : 0), 0);
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ p }) => ({ ...p, source: "demo" }));
}
