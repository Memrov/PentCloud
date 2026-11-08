import type { NativeEnv } from "./types";
import type { BountyConnections, ProgramAccess } from "./bounty-platform";
import type { SourceLibrary } from "./source-context";
export interface OnboardingServices {
  env: NativeEnv;
  onboarding: OnboardingStore;
  bountyConnections: BountyConnections;
  scopeCatalog: ScopeCatalog;
  sources: SourceLibrary;
  loginChallenges: LoginChallenges;
  programAccess(target: SavedTarget): Promise<ProgramAccess | undefined>;
  assertAdmissionOpen(): void;
  scheduleVerificationExpiry(): Promise<void>;
  pollAgentMail(key: string, owner: string): Promise<void>;
  assertDefinitionIdle(): void;
  removeTargetDefinition(id: string): Promise<void>;
  clearTargetLogin(id: string): void;
}
export interface OnboardingRequest {
  action: string;
  value: Record<string, unknown>;
  revision: number | null;
  actor: string;
}
type Action = (
  services: OnboardingServices,
  request: OnboardingRequest
) => Promise<unknown>;
import { OnboardingStore, type SavedTarget } from "./onboarding";
import { ScopeCatalog } from "./scope-catalog";
import { LoginChallenges } from "./login-challenge";
import { agentMailAddress, readAgentMail } from "./agentmail-verification";
import { verificationAddress } from "./target-verification";
import type { BountyPlatform } from "../../../../shared/bounty-connections";
import { canonical, identifier } from "./domain";
const actions = new Map<string, Action>([
  ["bounty.status", bountyStatus],
  ["bounty.check", bountyCheck],
  ["bounty.email.check", bountyEmailCheck],
  ["scope.names", scopeNames],
  ["scope.search", scopeSearch],
  ["scope.preview", scopePreview],
  ["scope.import", scopeImport],
  ["scope.detach", scopeDetach],
  ["access.save", accessSave],
  ["access.check", accessCheck],
  ["scope.check", scopeCheck],
  ["access.email.address", accessEmailAddress],
  ["access.email.setup", accessEmailAddress],
  ["access.email.status", accessEmailAddress],
  ["access.clearlogin", accessClearlogin],
  ["source.list", sourceList],
  ["source.attach", sourceAttach],
  ["source.refresh", sourceRefresh],
  ["source.detach", sourceDetach],
  ["source.import", sourceImport],
  ["target.save", targetSave],
  ["target.archive", targetArchive],
  ["target.restore", targetArchive],
  ["target.delete", targetArchive],
  ["target.check", targetCheck],
  ["model.test", modelTest]
]);
export const onboardingLibraryAction = (action: string): Action | undefined =>
  actions.get(action);
async function bountyStatus(
  services: OnboardingServices,
  _request: OnboardingRequest
): Promise<unknown> {
  return {
    connections: await services.bountyConnections.list(),
    email: {
      cloudflare: {
        configured: !!services.env.PENTCLOUD_VERIFICATION_EMAIL,
        address: services.env.PENTCLOUD_VERIFICATION_EMAIL
      },
      agentmail: {
        configured: !!agentMailAddress(services.env),
        address: agentMailAddress(services.env)
      }
    }
  };
}
async function bountyCheck(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value } = request;
  return services.bountyConnections.check(
    String(value.platform) as BountyPlatform
  );
}
async function bountyEmailCheck(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value } = request;

  if (value.provider !== "agentmail")
    throw Error(
      "400: Verify Cloudflare delivery with a forwarding confirmation"
    );
  const now = Date.now();
  await readAgentMail(services.env, {
    createdAt: now,
    expiresAt: now + 10000,
    sender: ""
  });
  return { connected: true };
}
async function scopeNames(
  services: OnboardingServices,
  _request: OnboardingRequest
): Promise<unknown> {
  const ready = (await services.bountyConnections.list())
    .filter((c) => c.status === "ready")
    .map((c) => c.platform);
  if (!ready.length)
    throw Error("409: Connect a platform in Dashboard → Bug bounty first");
  const result = await services.scopeCatalog.names();
  return {
    ...result,
    programs: result.programs.filter((p) =>
      ready.includes(p.platform as BountyPlatform)
    )
  };
}
async function scopeSearch(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value } = request;

  const ready = (await services.bountyConnections.list())
    .filter((c) => c.status === "ready")
    .map((c) => c.platform);
  if (!ready.length)
    throw Error("409: Connect a platform in Dashboard → Bug bounty first");
  if (value.platform)
    await services.bountyConnections.require(String(value.platform));
  return services.scopeCatalog.search(
    String(value.query ?? ""),
    typeof value.platform === "string" && value.platform
      ? value.platform
      : undefined,
    ready
  );
}
async function scopePreview(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value } = request;
  await services.bountyConnections.require(
    String(value.programId).split(":")[0]!
  );
  return await services.scopeCatalog.preview(String(value.programId));
}
async function scopeImport(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, revision, actor } = request;

  const id = identifier(value.id),
    target = services.onboarding.target(id);
  if (target.revision !== revision || target.archived)
    throw new Error("409: Target changed or archived; reload");
  await services.bountyConnections.require(
    String(value.programId).split(":")[0]!
  );
  const program = await services.scopeCatalog.import(
    String(value.programId),
    target.url
  );
  services.assertAdmissionOpen();
  await services.bountyConnections.require(program.platform);
  return services.onboarding.saveTargetAccess(
    id,
    revision!,
    target.access ?? { headers: [] },
    actor,
    program
  );
}
async function scopeDetach(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;
  return services.onboarding.saveTargetAccess(
    identifier(value.id),
    Number(value.revision),
    services.onboarding.target(identifier(value.id)).access ?? {
      headers: []
    },
    actor,
    null
  );
}
async function accessSave(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;
  return services.onboarding.saveTargetAccess(
    identifier(value.id),
    Number(value.revision),
    value.access,
    actor
  );
}
async function accessCheck(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;
  return services.onboarding.checkTargetSecret(
    identifier(value.id),
    Number(value.revision),
    String(value.kind),
    actor
  );
}
async function scopeCheck(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, revision } = request;

  const target = services.onboarding.target(identifier(value.id));
  if (target.revision !== revision || target.archived)
    throw Error("409: Target changed; reload");
  const checked = await services.programAccess(target);
  const current = services.onboarding.target(target.id);
  if (current.revision !== revision)
    throw Error("409: Target changed during program check");
  return {
    connected: true,
    platform: checked?.platform,
    checkedAt: checked?.checkedAt,
    authenticated: !!checked
  };
}
async function accessEmailAddress(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, revision, action } = request;

  const target = services.onboarding.target(identifier(value.id));
  if (target.revision !== revision || target.archived)
    throw Error("409: Target changed; reload");
  const saved = target.access?.login?.verification,
    provider =
      action === "access.email.address"
        ? (value.provider ??
          (saved?.kind === "email" ? saved.provider : undefined) ??
          "cloudflare")
        : saved?.kind === "email"
          ? (saved.provider ?? "cloudflare")
          : "cloudflare";
  if (provider !== "cloudflare" && provider !== "agentmail")
    throw Error("400: Invalid email verification provider");
  const available = {
    cloudflare: !!services.env.PENTCLOUD_VERIFICATION_EMAIL,
    agentmail: !!agentMailAddress(services.env)
  };
  if (!available[provider]) return { configured: false, provider, available };
  const address =
      provider === "agentmail"
        ? agentMailAddress(services.env)!
        : await verificationAddress(
            services.env.PENTCLOUD_VERIFICATION_EMAIL!,
            target.id
          ),
    key = "setup:" + target.id,
    owner = canonical([target.id, target.revision, provider, address]);
  if (action === "access.email.setup") {
    if (target.access?.login?.verification?.kind !== "email")
      throw Error("409: Save email verification settings first");
    services.loginChallenges.begin(
      {
        key,
        owner,
        recipient: address,
        sender: "",
        targetURL: target.url,
        purpose: "setup",
        provider
      },
      crypto.randomUUID()
    );
    await services.scheduleVerificationExpiry();
  }
  if (provider === "agentmail" && action !== "access.email.address")
    await services.pollAgentMail(key, owner);
  const current = services.onboarding.target(target.id);
  if (current.revision !== target.revision || current.archived)
    throw Error("409: Target changed; reload");
  const pending = services.loginChallenges.pending(key, owner),
    delivery =
      action === "access.email.status"
        ? services.loginChallenges.peek(key, owner)
        : undefined;
  // Setup confirmation is visible only to the authenticated owner, never an agent tool.
  return {
    configured: true,
    provider,
    available,
    address,
    status: delivery
      ? "received"
      : pending
        ? "waiting"
        : action === "access.email.status"
          ? "expired"
          : "idle",
    ...(pending ? { expiresAt: pending.expiresAt } : {}),
    ...(action === "access.email.setup" ? { ready: true } : {}),
    ...(delivery
      ? {
          received: true,
          from: delivery.from,
          code: delivery.code,
          excerpt: delivery.excerpt,
          links: delivery.links.filter((url) => {
            const h = new URL(url).hostname;
            return (
              h === "mail.google.com" ||
              h === "accounts.google.com" ||
              h === "outlook.live.com" ||
              h === "account.microsoft.com"
            );
          })
        }
      : { received: false })
  };
}
async function accessClearlogin(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, revision } = request;
  const target = services.onboarding.target(identifier(value.id));
  if (target.revision !== revision)
    throw new Error("409: Target changed; reload");
  services.clearTargetLogin(target.id);
  return { cleared: true };
}
async function sourceList(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value } = request;
  return await services.sources.list(
    typeof value.cursor === "string" ? value.cursor : undefined
  );
}
async function sourceAttach(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;
  return await services.sources.attach(
    identifier(value.id),
    Number(value.revision),
    value.repo,
    value.branch,
    actor
  );
}
async function sourceRefresh(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;
  return await services.sources.refresh(
    identifier(value.id),
    Number(value.revision),
    identifier(value.sourceId),
    actor
  );
}
async function sourceDetach(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;
  return services.sources.detach(
    identifier(value.id),
    Number(value.revision),
    identifier(value.sourceId),
    actor
  );
}
async function sourceImport(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;
  return await services.sources.importPublic(
    identifier(value.id),
    Number(value.revision),
    value.url,
    value.branch,
    identifier(value.requestId),
    actor,
    typeof value.replaceId === "string" ? value.replaceId : undefined
  );
}
async function targetSave(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, revision, actor } = request;
  return services.onboarding.saveTarget(
    value as unknown as Parameters<OnboardingStore["saveTarget"]>[0],
    revision,
    actor
  );
}
async function targetArchive(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, revision, actor, action } = request;
  const id = identifier(value.id);
  if (action === "target.delete") services.assertDefinitionIdle();
  const result = services.onboarding.lifecycleTarget(
    id,
    revision!,
    action.split(".")[1] as "archive" | "restore" | "delete",
    actor
  );
  if (action === "target.delete") {
    await services.removeTargetDefinition(id);
    services.clearTargetLogin(id);
  }
  return result;
}
async function targetCheck(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;

  await services.programAccess(
    services.onboarding.target(identifier(value.id))
  );
  return await services.onboarding.checkTarget(
    identifier(value.id),
    Number(value.revision),
    identifier(value.requestId),
    actor
  );
}
async function modelTest(
  services: OnboardingServices,
  request: OnboardingRequest
): Promise<unknown> {
  const { value, actor } = request;
  return await services.onboarding.testModel(
    value.choice as Parameters<OnboardingStore["testModel"]>[0],
    identifier(value.requestId),
    actor
  );
}
