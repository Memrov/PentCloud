export const SEARCH_PROVIDERS = [
  { id: "tinyfish", label: "TinyFish", binding: "TINYFISH_API_KEY" },
  { id: "exa", label: "Exa", binding: "EXA_API_KEY" },
  { id: "firecrawl", label: "Firecrawl", binding: "FIRECRAWL_API_KEY" },
  { id: "parallel", label: "Parallel", binding: "PARALLEL_API_KEY" },
  { id: "tavily", label: "Tavily", binding: "TAVILY_API_KEY" }
] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number]["id"];
export const DEFAULT_SEARCH_PROVIDER: SearchProvider = "tinyfish";
export function isSearchProvider(value: unknown): value is SearchProvider {
  return SEARCH_PROVIDERS.some((provider) => provider.id === value);
}
