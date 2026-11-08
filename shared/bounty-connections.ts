export const BOUNTY_PLATFORMS = [
  {
    id: "hackerone",
    name: "HackerOne",
    token: "PENTCLOUD_HACKERONE_API_TOKEN",
    username: "PENTCLOUD_HACKERONE_USERNAME"
  },
  {
    id: "intigriti",
    name: "Intigriti",
    token: "PENTCLOUD_INTIGRITI_API_TOKEN"
  },
  { id: "bugcrowd", name: "Bugcrowd", development: true },
  { id: "yeswehack", name: "YesWeHack", development: true }
] as const;
export type BountyPlatform = (typeof BOUNTY_PLATFORMS)[number]["id"];
export interface BountyConnection {
  platform: BountyPlatform;
  status: "missing" | "unchecked" | "ready" | "development";
  checkedAt?: number;
  expiresAt?: number;
}
export interface EmailReceiver {
  configured: boolean;
  address?: string;
}
export interface BountyStatus {
  connections: BountyConnection[];
  email: { cloudflare: EmailReceiver; agentmail: EmailReceiver };
}
export type MailSetup = {
  configured: boolean;
  provider: "cloudflare" | "agentmail";
  address?: string;
  status?: "idle" | "waiting" | "received" | "expired";
  expiresAt?: number;
  code?: string;
  excerpt?: string;
  links?: string[];
};
