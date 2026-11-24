/** Everything the plugin knows about specific omp providers; any other provider gets generic handling. */
interface ProviderTraits {
  name: string;
  /** `scope.tier` names a model family's own quota pool. Other providers put the plan there. */
  modelPools?: true;
  /** `orgName` holds the plan chosen at login, not a workspace. */
  orgNameIsPlan?: true;
  /** The Paseo provider whose own usage source reports the same vendor's logins. */
  paseoProvider?: string;
}

export const PROVIDERS: Record<string, ProviderTraits> = {
  anthropic: { name: "Claude", modelPools: true, paseoProvider: "claude" },
  "openai-codex": { name: "Codex", modelPools: true, orgNameIsPlan: true, paseoProvider: "codex" },
  "xai-oauth": { name: "Grok", paseoProvider: "grok" },
  "github-copilot": { name: "Copilot", paseoProvider: "copilot" },
  "google-gemini-cli": { name: "Gemini" },
  "google-antigravity": { name: "Antigravity" },
};

/** Unknown ids are title-cased the way `omp usage` prints them. */
export function providerName(provider: string): string {
  return (
    PROVIDERS[provider]?.name ??
    provider
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}
