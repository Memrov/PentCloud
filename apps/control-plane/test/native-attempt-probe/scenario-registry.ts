import type { Role } from "../../src/native/types";
import { probeFindingContract } from "./scenarios-preparation";
import type { ProbeScenarioContext } from "./worker";
import {
  probeSdkLiveTransport,
  probeSdkTerminalCold,
  probeBrowserLiveView,
  probeToolboxEviction,
  probeSdkToolboxCold,
  probeToolboxActivity,
  probeToolboxGenerationLoss,
  probeToolboxCleanupLost,
  probePlatformBackoff,
  probePlatformRecovery,
  probeSdkManagedSpecialist,
  probeSdkManagedSession,
  probeSdkRole
} from "./scenarios-sessions";
import {
  probeEvidenceFinalization,
  probeEvidenceGatewayCompat,
  probeEvidenceCancelCommit,
  probeEvidenceCancelPush,
  probeEvidenceTransfer,
  probeEvidencePackScratch,
  probeEvidencePackLarge,
  probeEvidenceReadPages,
  probeEvidenceCheckpoints,
  probeEvidenceIncompleteImage
} from "./scenarios-evidence";
import {
  probeNativePinnedModel,
  probeNativeDiscovery,
  probePurgeFailure,
  probePurge,
  probeHeaderRedaction,
  probeComputerCoder,
  probeComputer,
  probeShell,
  probeJavascript,
  probeJavascriptRoleTools,
  probePublish,
  probeMemoryContract,
  probeMemory,
  probeResearchPolicy
} from "./scenarios-workspace";
import {
  probeSession,
  probeMetasploit,
  probeMcpSchema,
  probeRemoteMutation,
  probeDrain,
  probeCancel
} from "./scenarios-remote";
type Scenario = (
  context: ProbeScenarioContext
) => Promise<Record<string, unknown>>;
const exact = new Map<string, Scenario>([
  ["finding-contract", probeFindingContract],
  ["sdk-live-transport", probeSdkLiveTransport],
  ["sdk-terminal-cold", probeSdkTerminalCold],
  ["evidence-finalization", probeEvidenceFinalization],
  ["evidence-gateway-compat", probeEvidenceGatewayCompat],
  ["evidence-cancel-commit", probeEvidenceCancelCommit],
  ["evidence-failed-push", probeEvidenceCancelCommit],
  ["evidence-cancel-push", probeEvidenceCancelPush],
  ["evidence-transfer", probeEvidenceTransfer],
  ["evidence-pack-scratch", probeEvidencePackScratch],
  ["evidence-pack-large", probeEvidencePackLarge],
  ["evidence-read-pages", probeEvidenceReadPages],
  ["evidence-read-preparation", probeEvidenceReadPages],
  ["evidence-read-pending", probeEvidenceReadPages],
  ["evidence-checkpoints", probeEvidenceCheckpoints],
  ["evidence-incomplete-image", probeEvidenceIncompleteImage],
  ["native-pinned-model", probeNativePinnedModel],
  ["native-pinned-model-max", probeNativePinnedModel],
  ["purge-failure", probePurgeFailure],
  ["purge", probePurge],
  ["browser-live-view", probeBrowserLiveView],
  ["toolbox-eviction", probeToolboxEviction],
  ["sdk-toolbox-cold", probeSdkToolboxCold],
  ["toolbox-activity", probeToolboxActivity],
  ["toolbox-generation-loss", probeToolboxGenerationLoss],
  ["toolbox-cleanup-lost", probeToolboxCleanupLost],
  ["toolbox-upstream-conflict", probeToolboxCleanupLost],
  ["toolbox-legacy-session", probeToolboxCleanupLost],
  ["platform-backoff", probePlatformBackoff],
  ["platform-recovery", probePlatformRecovery],
  ["platform-recovery-held", probePlatformRecovery],
  ["sdk-managed-session", probeSdkManagedSession],
  ["sdk-startup", probeSdkRole],
  ["sdk-searcher-tools", probeSdkRole],
  ["sdk-memorist-tools", probeSdkRole],
  ["sdk-pentester-tools", probeSdkRole],
  ["header-redaction", probeHeaderRedaction],
  ["computer-coder", probeComputerCoder],
  ["computer", probeComputer],
  ["shell", probeShell],
  ["javascript", probeJavascript],
  ["javascript-role-tools", probeJavascriptRoleTools],
  ["publish", probePublish],
  ["replay", probePublish],
  ["session", probeSession],
  ["session-cleanup-failure", probeSession],
  ["session-stateless", probeSession],
  ["mcp-schema", probeMcpSchema],
  ["memory-contract", probeMemoryContract],
  ["memory", probeMemory],
  ["research-policy", probeResearchPolicy],
  ["unknown", probeRemoteMutation],
  ["known-running", probeRemoteMutation],
  ["drain", probeDrain],
  ["cancel", probeCancel]
]);
const prefixes: readonly (readonly [string, Scenario])[] = [
  ["native-discovery", probeNativeDiscovery],
  ["sdk-managed-specialist", probeSdkManagedSpecialist],
  ["sdk-role-", probeSdkRole],
  ["metasploit-", probeMetasploit],
  ["metasploit", probeRemoteMutation],
  ["session", probeRemoteMutation]
];
export function attemptScenario(kind: string): Scenario | undefined {
  return (
    exact.get(kind) ?? prefixes.find(([prefix]) => kind.startsWith(prefix))?.[1]
  );
}

const roles = new Map<string, Role>([
  ["finding-contract", "reporter"],
  ["sdk-toolbox-cold", "coder"],
  ["toolbox-eviction", "coder"],
  ["toolbox-generation-loss", "pentester"],
  ["sdk-searcher-tools", "searcher"],
  ["sdk-memorist-tools", "memorist"],
  ["sdk-pentester-tools", "pentester"],
  ["sdk-managed-specialist", "coder"],
  ["sdk-managed-specialist-primary", "primary"],
  ["unknown", "pentester"],
  ["known-running", "pentester"],
  ["computer-coder", "coder"],
  ["javascript", "coder"],
  ["javascript-role-tools", "memorist"],
  ["research-policy", "searcher"]
]);
export function scenarioRole(kind: string): Role {
  if (kind.startsWith("codex-role-")) return kind.slice(11) as Role;
  if (kind.startsWith("sdk-role-")) return kind.slice(9) as Role;
  if (
    ["package-only", "evidence", "memory"].some((prefix) =>
      kind.startsWith(prefix)
    )
  )
    return "coder";
  if (
    ["native-discovery", "metasploit", "session"].some((prefix) =>
      kind.startsWith(prefix)
    )
  )
    return "pentester";
  return roles.get(kind) ?? "primary";
}
