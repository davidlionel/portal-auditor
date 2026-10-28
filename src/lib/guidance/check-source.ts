import { missingPhrases, pageText } from "./page-text";

// One HubSpot docs page: does it still load without a redirect and still
// contain the key phrases the guidance relies on? Null when it does.
export type SourcePhrase = { id: string; phrase: string };

const USER_AGENT = "portal-auditor-docs-check (+https://github.com/davidlionel/portal-auditor)";
const TIMEOUT_MS = 30_000;

// One fetch, retried once for network errors, rate limits and server errors.
async function load(url: string, fetchImpl: typeof fetch): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchImpl(url, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if ((response.status >= 500 || response.status === 429) && attempt === 1) continue;
      return response;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

export async function checkSource(
  url: string,
  phrases: SourcePhrase[],
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let response: Response;
  try {
    response = await load(url, fetchImpl);
  } catch (error) {
    return `Couldn't reach the page (${error instanceof Error ? error.message : String(error)}). This may be temporary.`;
  }
  if (response.status >= 300 && response.status < 400) {
    return `Redirects (${response.status}) to ${response.headers.get("location") ?? "an unknown location"}. The page has moved; re-read it and update the source.`;
  }
  if (response.status !== 200) return `Returned ${response.status}.`;

  const missing = missingPhrases(pageText(await response.text()), phrases.map((p) => p.phrase));
  if (!missing.length) return null;
  const detail = phrases
    .filter((p) => missing.includes(p.phrase))
    .map((p) => `  - \`${p.id}\`: "${p.phrase}"`)
    .join("\n");
  return `Key phrases no longer on the page:\n${detail}`;
}
