// Command native-specialists generates the native Markdown prompt sources.
// Original Go templates are evaluated with Go text/template before explicit,
// reviewable runtime adaptations. No rewriting takes place in the application.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"text/template"
)

const outputDir = "apps/control-plane/src/native/specialists"

const kaliRuntimeContract = "Linux tools use one shared on-demand Cloudflare Kali Container with the unchanged stock image and MCP schemas. The runtime waits for readiness and the complete stock catalog before a Kali-capable specialist calls its model, and keeps the running Container awake during active work. The native 30-minute inactivity timeout stops idle Kali; it is not an attempt deadline. Scratch files and live processes are not durable: persist needed findings and outputs through the existing Workspace/result and Artifacts publication paths. Retain operation/session IDs, inspect the same operation and reconcile unknown outcomes before any mutation retry; never assume a lost session or process can resume."

type roleSpec struct{ Role, Template, Result string }

var roles = []roleSpec{
	{"primary", "primary_agent", "done"},
	{"reporter", "reporter", "report_result"},
	{"adviser", "adviser", "advisory response as text"},
	{"coder", "coder", "code_result"},
	{"maintenance", "installer", "maintenance_result"},
	{"memorist", "memorist", "memorist_result"},
	{"pentester", "pentester", "hack_result"},
	{"searcher", "searcher", "search_result"},
}

type paragraph struct {
	Source       string   `json:"source"`
	SourceSHA256 string   `json:"sourceSha256"`
	Output       string   `json:"output"`
	OutputSHA256 string   `json:"outputSha256"`
	Destination  string   `json:"destination"`
	Adaptations  []string `json:"adaptations,omitempty"`
}
type section struct {
	Heading      string      `json:"heading"`
	SourceSHA256 string      `json:"sourceSha256"`
	Paragraphs   []paragraph `json:"paragraphs"`
}
type roleManifest struct {
	Role           string    `json:"role"`
	ResultTool     string    `json:"resultContract"`
	Source         string    `json:"source"`
	Upstream       string    `json:"upstream"`
	SourceSHA256   string    `json:"sourceSha256"`
	UpstreamSHA256 string    `json:"upstreamSha256"`
	RenderedSHA256 string    `json:"renderedSha256"`
	Sections       []section `json:"sections"`
}
type manifest struct {
	Version      int               `json:"version"`
	Generator    string            `json:"generator"`
	RenderData   map[string]any    `json:"renderData"`
	Adaptations  map[string]string `json:"adaptations"`
	Roles        []roleManifest    `json:"roles"`
	Statistics   statistics        `json:"statistics"`
	BranchPolicy map[string]string `json:"branchPolicy"`
}
type statistics struct {
	Roles              int `json:"roles"`
	Sections           int `json:"sections"`
	Paragraphs         int `json:"paragraphs"`
	RetainedParagraphs int `json:"retainedParagraphs"`
	AdaptedParagraphs  int `json:"adaptedParagraphs"`
	ParagraphsInSkill  int `json:"paragraphsInSkill"`
}
type generated struct {
	Files    map[string]string
	Manifest manifest
}
type replacement struct{ ID, Reason, Old, New string }

func digest(s []byte) string { sum := sha256.Sum256(s); return hex.EncodeToString(sum[:]) }

// Sentinels are build-time branch fixtures, never live task values. Enabling both
// optional policies retains all customer-input, knowledge and material guidance.
func renderData() map[string]any {
	return map[string]any{
		"AdviceToolName": "advice", "AskUserEnabled": true, "AskUserToolName": "ask",
		"CodeResultToolName": "code_result", "CoderToolName": "coder", "ContainerPorts": "__CONTAINER_PORTS__",
		"CurrentTime": "__CURRENT_TIME__", "Cwd": "__CWD__", "DockerImage": "__DOCKER_IMAGE__",
		"EnricherResultToolName": "enricher_result", "ExecutionContext": "__EXECUTION_CONTEXT__",
		"FileToolName": "file", "FinalyToolName": "done", "GraphitiEnabled": true,
		"GraphitiSearchToolName": "graphiti_search", "HackResultToolName": "hack_result", "IsDefaultDockerImage": false,
		"Lang": "engagement language", "MaintenanceResultToolName": "maintenance_result", "MaintenanceToolName": "maintenance",
		"MemoristResultToolName": "memorist_result", "MemoristToolName": "memorist", "N": 12000,
		"PentesterToolName": "pentester", "ReportResultToolName": "report_result", "SearchAnswerToolName": "search_answer",
		"SearchCodeToolName": "search_code", "SearchGuideToolName": "search_guide", "SearchResultToolName": "search_result",
		"SearchToolName": "search", "StoreAnswerToolName": "store_answer", "StoreCodeToolName": "store_code",
		"StoreGuideToolName": "store_guide", "SummarizationToolName": "summarize", "SummarizedContentPrefix": "[summary]",
		"TerminalToolName": "terminal", "ToolPlaceholder": "__TOOL_CATALOG__", "UserFiles": "__USER_FILES__", "WebSearchToolName": "web_search",
	}
}

var replacements = []replacement{
	{"structured-time", "Read the actual launch time from immutable structured task input; never freeze a timestamp into the static role.", "<current_time>\n__CURRENT_TIME__\n</current_time>", "Current time is supplied in the structured task input; use that value when evaluating freshness and chronology."},
	{"structured-context", "The current objective and original arguments arrive as structured launch context, not an embedded historical snapshot.", "<execution_context>\n__EXECUTION_CONTEXT__\n</execution_context>", "Read the original task/delegation arguments and current execution context from the structured task input."},
	{"structured-files", "Attachment metadata is dynamic and comes from structured task input.", "__USER_FILES__", "Use the attachment list in the structured task input; if no files are attached, this materials policy has no attached files to act on."},
	{"structured-catalog", "Actual enabled tools and schemas are authoritative; static prompts do not promise optional capabilities.", "__TOOL_CATALOG__", "The structured task input and native tool catalog identify the tools actually exposed to this role. Use only advertised tools and their actual schemas."},
	{"workspace-path", "Use the actual guarded workspace root; retain relative attachment-path semantics without freezing a path.", "__CWD__", "<task-workspace>"},
	{"materials-location", "Materials are in the guarded task filesystem, not a per-role Docker container.", "READ-ONLY inside the container", "READ-ONLY in the task workspace"},
	{"materials-location", "Materials are in the guarded task filesystem, not a per-role Docker container.", "READ-ONLY in the container", "READ-ONLY in the task workspace"},
	{"materials-location", "Materials are in the guarded task filesystem, not a per-role Docker container.", "READ-ONLY in the container during execution", "READ-ONLY in the task workspace during execution"},
	{"materials-location", "Materials are in the guarded task filesystem, not a per-role Docker container.", "available to other agents in the container", "available to other agents through their task workspace"},
	{"computer-runtime", "Cloudflare Computer owns guarded files, Worker shell and isolated JavaScript; stock Kali MCP owns Linux scanners. No implicit Docker/deadline/port claims.", "<runtime>Docker __DOCKER_IMAGE__ with working directory <task-workspace></runtime>", "<runtime>Cloudflare Computer task workspace; use the cwd supplied in structured task input. Worker shell handles text/files and read-only Git; isolated JavaScript runs through computer tools or workspace_javascript. Linux scanners run through advertised stock Kali MCP tools on the shared on-demand Cloudflare Kali Container.</runtime>"},
	{"computer-runtime", "Cloudflare Computer owns guarded files, Worker shell and isolated JavaScript; stock Kali MCP owns Linux scanners. No implicit Docker/deadline/port claims.", "<ports>\n__CONTAINER_PORTS__\n</ports>", "<ports>Use only callback/listener ports explicitly allocated in task context or returned by the stock Kali tool. Cloudflare Worker shell does not expose Linux sockets or forwarded ports.</ports>"},
	{"computer-runtime", "Cloudflare Computer owns guarded files, Worker shell and isolated JavaScript; stock Kali MCP owns Linux scanners. No implicit Docker/deadline/port claims.", "__CONTAINER_PORTS__", "Use only addresses, allocated ports and listener capabilities actually supplied by the task or stock Kali tool. Worker shell has no Linux sockets or forwarded ports."},
	{"computer-runtime", "Cloudflare Computer owns guarded files, Worker shell and isolated JavaScript; stock Kali MCP owns Linux scanners. No implicit Docker/deadline/port claims.", "<timeout>Default: 120 seconds (Hard limit: 20 minutes)</timeout>", "<timeout>There is no default attempt deadline. Respect the advertised tool's request limits; a request timeout does not prove a remote operation stopped. Inspect its returned operation/scan identifier before retrying.</timeout>"},
	{"computer-capabilities", "Browser is available separately; unsupported shell/Linux/container-host operations must not be promised or invented.", "- No GUI applications", "- Use cloudflare_browser for advertised persistent Chromium interactions; Worker shell is not a Linux desktop"},
	{"computer-capabilities", "Browser is available separately; unsupported shell/Linux/container-host operations must not be promised or invented.", "- No Docker host access", "- No Docker host access or per-agent container lifecycle"},
	{"computer-capabilities", "Browser is available separately; unsupported shell/Linux/container-host operations must not be promised or invented.", "- No software installation via Docker images", "- Do not replace or modify the stock Kali image; use available tools or report missing capabilities"},
	{"computer-capabilities", "Browser is available separately; unsupported shell/Linux/container-host operations must not be promised or invented.", "- No UDP port scanning", "- Use UDP scanning only if an advertised stock Kali MCP tool supports it within the engagement scope"},
	{"computer-capabilities", "Browser is available separately; unsupported shell/Linux/container-host operations must not be promised or invented.", "- Command-line operations only", "- Choose advertised Computer, JavaScript, browser or stock Kali MCP capabilities according to the task"},
	{"worker-directory", "Computer operations are scoped to the live task root; no cross-command cwd assumption.", "<directory>Change directory explicitly before each command (not persistent between calls)</directory>", "<directory>Set cwd explicitly to the structured task workspace (or use relative paths beneath it); do not assume a prior command changed the next command's directory.</directory>"},
	{"worker-paths", "Guarded native operations support relative paths and reject escaping the task root.", "Use absolute paths for all file operations", "Use relative paths beneath the task workspace, or absolute paths confined to that root"},
	{"worker-timeouts", "Bound requests and inspect remote asynchronous operations rather than imposing a fictional global deadline.", "<timeouts>Specify appropriate timeouts and redirect output for long-running processes</timeouts>", "<timeouts>Use documented request limits; redirect large output to task files. For long-running stock Kali operations inspect the operation/scan ID through its advertised result tool.</timeouts>"},
	{"worker-detachment", "Native terminal rejects detach; stock MCP owns remote process lifecycle.", "<detachment>Use `detach` for all commands except the final one in a sequence</detachment>", "<detachment>Worker shell does not support detached Linux processes. Use the stock Kali MCP operation lifecycle for long-running work; retain operation IDs, inspect completion, and reconcile unknown outcomes before any retry.</detachment>"},
	{"bounded-output", "Maintain the original bounded log-reading procedure with available shell utilities.", "Filter large log files using grep/tail/head instead of displaying entire contents", "Filter large log files using available text/search tools and tail/head instead of displaying entire contents"},
	{"runtime-payload-language", "Language policy applies to actual runtime payloads across Computer/Kali, not a fictional single container.", "runtime payloads inside the Docker container", "runtime payloads sent to Computer or stock Kali tools"},
	{"runtime-payload-language", "Language policy applies to actual runtime payloads across Computer/Kali, not a fictional single container.", "runtime payloads inside the Docker container for verifying findings", "runtime payloads sent to Computer or stock Kali tools for verifying findings"},
	{"runtime-payload-language", "Language policy applies to actual runtime payloads across Computer/Kali, not a fictional single container.", "runtime container", "task runtime"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "vector database", "Git-backed memory"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "Vector database", "Git-backed memory"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "vector-store", "Git-memory"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "vector store", "Git memory"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "temporal knowledge graph (Graphiti)", "recorded engagement history"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "temporal knowledge graph", "recorded engagement history"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "knowledge-graph searches", "recorded-history searches"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "knowledge-graph queries", "recorded-history queries"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "Memory/knowledge graph findings", "Memory and recorded-history findings"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "Graphiti", "recorded engagement history"},
	{"git-memory-terminology", "Memory is Git-backed text retrieval and reusable Markdown artifacts, not a vector or Graphiti backend.", "graphiti_search", "search_in_memory"},
	{"git-memory-capability", "Git memory covers only accepted stored artifacts and supplied history; it does not record every agent event or promise semantic search.", "stores ALL previous agent responses and tool execution records", "contains only the accepted Git-backed memory artifacts and execution records actually supplied in context; it does not automatically contain every response or tool execution"},
	{"git-memory-capability", "Git memory covers only accepted stored artifacts and supplied history; it does not record every agent event or promise semantic search.", "semantic queries", "literal text queries"},
	{"git-memory-capability", "Git memory covers only accepted stored artifacts and supplied history; it does not record every agent event or promise semantic search.", "semantic code search", "literal code search"},
	{"git-memory-capability", "Git memory covers only accepted stored artifacts and supplied history; it does not record every agent event or promise semantic search.", "semantic search", "literal text search"},
	{"git-memory-english", "Preserve English technical-channel discipline without claiming unsupported indexing behavior or cross-engagement access.", "are indexed in English and shared across all engagements regardless of their working language: any non-English query retrieves nothing, and any non-English stored code or explanation becomes unreachable to future searches.", "use English technical queries and reusable artifacts for consistent team retrieval; Git memory is limited to the accepted repository and supplied context, and retrieval is literal text matching."},
	{"git-memory-english", "Preserve English technical-channel discipline without claiming unsupported indexing behavior or cross-engagement access.", "are indexed in English and shared across all engagements regardless of their working language: any non-English query retrieves nothing, and any non-English stored guide becomes unreachable to future searches.", "use English technical queries and reusable artifacts for consistent team retrieval; Git memory is limited to the accepted repository and supplied context, and retrieval is literal text matching."},
	{"git-memory-english", "Preserve English technical-channel discipline without claiming unsupported indexing behavior or cross-engagement access.", "are indexed in English and shared across all engagements regardless of their working language: any non-English query retrieves nothing, and any non-English stored answer becomes unreachable to future searches.", "use English technical queries and reusable artifacts for consistent team retrieval; Git memory is limited to the accepted repository and supplied context, and retrieval is literal text matching."},
	{"git-memory-english", "Preserve English technical-channel discipline without claiming unsupported indexing behavior or cross-engagement access.", "are indexed in English and shared across all engagements regardless of their working language: any non-English query retrieves nothing.", "use English technical queries for consistent team retrieval; Git memory is limited to the accepted repository and supplied context, and retrieval is literal text matching."},
	{"native-planning", "Retain planning, tradeoff evaluation and verification while requesting concise rationales, not private chain-of-thought.", "For complex operations, use chain-of-thought reasoning:", "For complex operations, plan carefully and provide concise decision rationales:"},
	{"native-orchestration", "Coordinator owns serial dispatch and slice boundaries; advisers recommend changes without claiming obsolete Refiner authority.", "All work executes inside Docker container with __DOCKER_IMAGE__ image", "Work uses the guarded Cloudflare Computer workspace and advertised stock Kali MCP tools; no per-agent Docker container is created"},
	{"native-orchestration", "Coordinator owns serial dispatch and slice boundaries; advisers recommend changes without claiming obsolete Refiner authority.", "(dynamically refined by Refiner agent)", "(planning and replanning are handled by the primary with Coordinator-owned dispatch)"},
	{"native-orchestration", "Coordinator owns serial dispatch and slice boundaries; advisers recommend changes without claiming obsolete Refiner authority.", "When advising Refiner or when execution reveals plan issues, you can recommend:", "When advising the primary or when execution reveals plan issues, you can recommend:"},
	{"native-input-shape", "Accept original XML when supplied, but native structured input carries equivalent fields and does not guarantee legacy wrappers.", "The task report context is provided in XML format with the following structure:", "Read the structured task input for the report context. If legacy XML is supplied, its equivalent fields have the following structure:"},
	{"native-input-shape", "Accept original XML when supplied, but native structured input carries equivalent fields and does not guarantee legacy wrappers.", "Each agent has specific delegation capabilities and completion tools. The `<initiator_agent>` tag indicates which agent is requesting your advice.", "Each agent has specific delegation capabilities and completion tools. Use the initiator in structured task input (or a supplied legacy `<initiator_agent>` tag) to identify who is requesting advice. The live tool catalog determines which listed delegations are available."},
	{"native-input-shape", "Accept original XML when supplied, but native structured input carries equivalent fields and does not guarantee legacy wrappers.", "<input_templates>\n**Question Templates:**", "<input_templates>\nNative advice input supplies the question, code/output, initiator and context as structured fields. The following legacy wrappers may also occur; interpret their content when actually supplied.\n**Question Templates:**"},
	{"native-advice-modes", "All three substantive advice modes remain available when requested; no nonexistent automatic hook is promised.", "Trigger: Via question_task_planner.tmpl before specialist agent execution", "Trigger: The task input requests planning advice before specialist execution (legacy question_task_planner content may be supplied)"},
	{"native-advice-modes", "All three substantive advice modes remain available when requested; no nonexistent automatic hook is promised.", "Trigger: Via question_execution_monitor.tmpl when execution patterns indicate issues", "Trigger: The task input requests execution monitoring when execution patterns indicate issues (legacy question_execution_monitor content may be supplied)"},
	{"native-mentor", "Retain mentor interpretation and consultation without promising automatic periodic interventions.", "During task execution, a senior mentor reviews your progress periodically", "During task execution, supplied adviser/mentor feedback can review your progress"},
	{"native-mentor", "Retain mentor interpretation and consultation without promising automatic periodic interventions.", "Mentor may review progress periodically and help prevent loops and incorrect approaches", "When requested or supplied in task context, mentor advice can help prevent loops and incorrect approaches"},
	{"native-retrieval-provider", "Use the configured web_search implementation and actual schemas; no invented multi-provider failover or billing behavior.", "the unified `web_search` tool (it selects the underlying provider — Google, DuckDuckGo, Tavily, Firecrawl, Traversaal, Perplexity, Searxng, Sploitus — for you)", "the configured `web_search` tool when advertised (use the actual provider and modes reported by the tool catalog)"},
	{"native-retrieval-provider", "Use the configured web_search implementation and actual schemas; no invented multi-provider failover or billing behavior.", "The single `web_search` tool covers ALL external web search. You do NOT choose a\nprovider (Google, DuckDuckGo, Tavily, Firecrawl, Traversaal, Perplexity, Searxng,\nSploitus) — you choose an intent `mode`, and web_search selects the best available\nengine for that mode, retries transient failures, and falls back automatically:", "Use the advertised `web_search` tool for external search, with only the modes its actual schema supports. The configured provider and its returned evidence determine capability; do not assume provider switching, automatic fallback, retries, or synthesized answers. Preserve these intent distinctions when constructing queries and synthesizing returned sources:"},
	{"native-retrieval-provider", "Use the configured web_search implementation and actual schemas; no invented multi-provider failover or billing behavior.", "— the cheapest option for collecting public sources.", "— collect public sources using the configured provider."},
	{"native-retrieval-provider", "Use the configured web_search implementation and actual schemas; no invented multi-provider failover or billing behavior.", "A synthesized answer over live sources — the default for a concrete question.", "A concrete question over live sources; synthesize an answer from the evidence actually returned."},
	{"native-retrieval-provider", "Use the configured web_search implementation and actual schemas; no invented multi-provider failover or billing behavior.", "Deep, multi-source analysis with reasoning — for complex technical topics needing synthesis.", "Multi-source evidence gathering for complex technical topics needing synthesis."},
	{"native-file-tool", "Files and verification commands belong to the guarded native workspace, not a local Docker filesystem.", "Read files from the container's local filesystem", "Read files from the guarded task workspace"},
	{"native-file-tool", "Files and verification commands belong to the guarded native workspace, not a local Docker filesystem.", "Always use absolute paths for reliable file access", "Use paths confined to the task workspace for reliable file access"},
	{"native-file-tool", "Files and verification commands belong to the guarded native workspace, not a local Docker filesystem.", "Execute commands within the container environment", "Execute supported text/file and read-only Git commands in Worker shell; use advertised Computer JavaScript or stock Kali MCP for their respective capabilities"},
	{"native-file-tool", "Files and verification commands belong to the guarded native workspace, not a local Docker filesystem.", "Set appropriate timeouts and handle long-running processes", "Respect documented tool limits and inspect stock Kali operation IDs for long-running work"},
	{"native-file-tool", "Files and verification commands belong to the guarded native workspace, not a local Docker filesystem.", "Leverage the task runtime (terminal/file)", "Leverage the guarded workspace (Computer/terminal/file)"},
	{"native-kali-availability", "The stock Kali tool catalog is authoritative; never install Linux binaries through Worker shell or change stock image bytes.", "Verify tool availability before use. Install missing tools if needed in current image", "Verify availability in the advertised stock Kali MCP catalog before use. Use an available equivalent or report a missing capability; Worker shell cannot install or execute Linux scanner binaries"},
	{"native-kali-availability", "The stock Kali tool catalog is authoritative; never install Linux binaries through Worker shell or change stock image bytes.", "Check tool availability with 'which [tool]' before use. Install missing tools if required. Use -h/--help for arguments.", "Check tool availability and supported arguments in the advertised stock Kali MCP schema/help before use. Use equivalent available tools if missing; do not modify the stock Kali image."},
}

// Exact paragraph replacements cover the few runtime blocks whose native
// execution model differs fundamentally. Unrelated paragraphs remain verbatim.
func adaptParagraph(role, heading, input string) (string, []string) {
	output := input
	ids := []string{}
	add := func(id string) {
		if !contains(ids, id) {
			ids = append(ids, id)
		}
	}
	for _, r := range replacements {
		if strings.Contains(output, r.Old) {
			output = strings.ReplaceAll(output, r.Old, r.New)
			add(r.ID)
		}
	}
	if strings.Contains(output, "<identification>") && heading == "SUMMARIZATION AWARENESS PROTOCOL" {
		output = "<summarized_content_handling>\n<identification>\n- OpenCode may compact or summarize historical interactions in context. Use only the summaries and history actually supplied; no specific marker prefix or summarization tool is promised.\n- These summaries are condensed records of previous actions and conversations, NOT templates for your own responses.\n</identification>"
		add("native-summary-identification")
	}
	if heading == "SUMMARIZATION AWARENESS PROTOCOL" && strings.Contains(output, "<prohibited_behavior>") {
		output = "<prohibited_behavior>\n- NEVER mimic or copy the format of historical summaries, fabricate their markers, or call a nonexistent summarization tool. OpenCode owns compaction.\n- NEVER produce plain text responses simulating tool calls or their outputs. ALL actions MUST use structured tool calls.\n</prohibited_behavior>"
		add("native-summary-markers")
	}
	if strings.Contains(output, "**Docker Container:**") {
		output = "<container_environment>\n**Native Task Runtime:**\n- Files/execution: guarded Cloudflare Computer task workspace, Worker shell and isolated JavaScript\n- Working Directory: use cwd from structured task input\n- Linux security tools: advertised stock Kali MCP on the shared on-demand Cloudflare Kali Container"
		add("native-adviser-environment")
	}
	if strings.Contains(output, "**OOB Exploitation Guidance:**") {
		output = "**OOB Exploitation Guidance:**\n- Receiving callbacks (reverse shells, DNS exfiltration, XXE OOB, SSRF verification) requires an advertised stock Kali listener capability and explicitly allocated reachable port\n- User may specify public IP in task description - extract and use it when advising on OOB techniques\n- If the address is unknown, recommend discovering it through an available network-capable tool (for example, retrieving https://api.ipify.org or https://ipinfo.io/ip when allowed by scope); Worker shell cannot run network curl\n- Always consider OOB port availability when recommending callback-based attacks\n- **CRITICAL:** Agents MUST use only allocated ports and returned reachability evidence; do not assume forwarding or shared localhost semantics\n</container_environment>"
		add("native-oob-capabilities")
	}
	if heading == "BACKEND TERMINAL EXECUTION MECHANICS" {
		if strings.Contains(output, "**Command Execution:**") {
			output = "<terminal_execution_model>\n**Command Execution:** Worker shell handles supported text/file operations and read-only Git in the guarded workspace. Linux commands and exploit frameworks run only through advertised stock Kali MCP tools."
			add("native-backend-execution")
		}
		if strings.Contains(output, "**Detach Modes:**") {
			output = "**Remote Operation Lifecycle:**\n- Worker shell does not implement detached Linux processes.\n- For long-running Kali work, retain the returned operation/scan ID and inspect it with the matching stock result tool.\n- A timeout or interrupted response does not prove the remote operation stopped; reconcile uncertain outcomes before retrying a mutation.\n- Tool request limits are distinct from attempt lifetime; no default attempt deadline is imposed."
			add("native-backend-detach")
		}
		if strings.Contains(output, "**Standalone (simple):**") {
			output = "**Standalone (simple):** If the advertised Kali tool supports a command sequence, preserve the noninteractive, explicit-exit pattern: `msfconsole -q -x \"use exploit/...; set LPORT [allocated]; exploit; sleep 20; sessions -l; exit\"`. Submit through the advertised stock tool and inspect its returned operation ID. Worker shell cannot execute msfconsole."
			add("native-msf-lifecycle")
		}
		if strings.Contains(output, "All in one command (detach=false") {
			output = "Keep related framework operations in the same supported Kali command/session. Follow the stock tool's actual request limits and result-inspection lifecycle."
			add("native-msf-lifecycle")
		}
		if strings.Contains(output, "**RPC Daemon (complex workflows):**") {
			output = "**RPC Daemon (complex workflows):**\n1. Check available ports and existing operation/session state through advertised stock Kali tools before starting any daemon.\n2. Use a live framework/RPC session only when a stock MCP tool explicitly exposes it; retain its returned identity and connection details.\n3. Reconnect/inspect the same returned session through its supported stock tool. Do not invent direct RPC connections, credentials, detached-process support or localhost reachability in Worker shell."
			add("native-msf-rpc")
		}
		if strings.Contains(output, "**Diagnostic Commands:**") {
			output = "**Diagnostics (on Kali, only through advertised tools):**\n- Inspect orphaned framework processes, operation/session identity and owned listener ports before launching another operation\n- Check the relevant port state (a stock tool may expose the equivalent of `netstat -tulnp`)\n- Clean up only processes/listeners owned by the current operation, using its supported stock lifecycle tool; do not kill unrelated shared-host work"
			add("native-owned-cleanup")
		}
		if strings.Contains(output, "**Host Network Mode:**") {
			output = strings.ReplaceAll(output, "**Host Network Mode:** Shared localhost - check port availability before any daemon.", "**Network Reachability:** Check allocated port availability and returned callback reachability before any daemon; do not assume Worker and Kali share localhost.")
			add("native-network-reachability")
		}
	}
	if strings.Contains(output, "LONG-RUNNING processes (daemons, servers, monitors)") {
		start := strings.Index(output, "LONG-RUNNING processes (daemons, servers, monitors)")
		output = output[:start] + "LONG-RUNNING operations (daemons, servers, monitors) require an advertised stock Kali MCP lifecycle.\nPurpose: Track independently running remote work using the stock tool's actual operation/session identity.\nExamples: framework RPC, listeners, HTTP servers, packet capture — only when supported by the advertised stock tool.\nBehavior: Worker shell cannot start detached Linux processes. Retain the returned operation/session ID and inspect or stop it through its stock lifecycle tool; do not assume a fixed return delay or survival after timeout."
		add("native-command-detach")
	}
	if strings.HasPrefix(output, "BATCH commands (scanners, exploits, clients)") {
		output = "BATCH commands (scanners, exploits, clients) use the advertised stock Kali tool's execution/result contract.\nPurpose: Obtain command output and positive completion evidence through its matching result tool.\nExamples: nmap, noninteractive msfconsole with explicit exit, gobuster, network retrieval — only when supported by advertised stock tools.\nBehavior: Retain and inspect the operation/scan ID until completion. A request timeout is an unknown outcome, not proof the remote process stopped; reconcile before any mutation retry."
		add("native-command-detach")
	}
	if strings.Contains(output, "<msf_workflow_protocol>") {
		output = "<msf_workflow_protocol>\nStandalone (recommended): Keep related operations in a single noninteractive command or supported stock Kali session. Example command shape (only if accepted by the advertised Kali tool): `msfconsole -q -x \"use exploit/...; set LPORT [allocated]; exploit; sleep 20; sessions -l; sessions -i 1 -c 'sysinfo'; exit\"`. Capture output through the stock tool's result contract; Worker shell cannot execute it."
		add("native-msf-lifecycle")
	}
	if strings.HasPrefix(output, "RPC Daemon (complex workflows):") {
		output = "RPC Daemon (complex workflows):\nCheck allocated ports and existing session state → use a stock Kali MCP tool that explicitly exposes live RPC/framework sessions → retain its returned session identity → reconnect/inspect the same session through supported tools → clean up only the owned operation. Do not invent detached-process flags, direct RPC transports or localhost connectivity."
		add("native-msf-rpc")
	}
	if strings.HasPrefix(output, "Recovery from mistakes:") {
		output = "Recovery from mistakes:\nIf a framework operation hangs or conflicts with a port, inspect its returned operation/session identity and port state through advertised stock tools. Stop only the owned operation through its supported lifecycle; reconcile unknown outcomes before retrying.\n</msf_workflow_protocol>"
		add("native-owned-cleanup")
	}
	if strings.Contains(output, "- Kill orphaned processes: `pkill -f msfconsole`") {
		output = strings.ReplaceAll(output, "- Kill orphaned processes: `pkill -f msfconsole`", "- Inspect and clean up only orphaned framework operations owned by this task through the stock Kali lifecycle tools")
		add("native-owned-cleanup")
	}
	if strings.Contains(output, "- Check port availability before launch: `netstat -tulnp | grep [PORT]`") {
		output = strings.ReplaceAll(output, "- Check port availability before launch: `netstat -tulnp | grep [PORT]`", "- Check allocated port availability before launch through an advertised Kali tool (the equivalent of `netstat -tulnp` when supported)")
		add("native-network-reachability")
	}
	if heading == "CUSTOMER INTERACTION PROTOCOL" {
		output = strings.ReplaceAll(output, "- You have access to the \"ask\" tool to request additional information from the customer", "- Primary may use the advertised native `question` tool when missing operator input prevents progress; if unavailable, report the missing context in the result instead of inventing a tool. OpenCode owns the pending question and model recovery; an interrupted question may be reissued after host reset. Do not poll or create another input queue")
		output = strings.ReplaceAll(output, "this tool", "the advertised native `question` tool")
		output = strings.ReplaceAll(output, "via \"ask\"", "via the advertised native `question` tool")
		add("native-customer-input")
	}
	if heading == "HISTORICAL CONTEXT RETRIEVAL" {
		// Keep all original query purposes, WHEN/USE distinctions, vocabulary,
		// examples and evidence distinctions; adapt only unsupported graph APIs.
		output = strings.ReplaceAll(output, "<search_in_memory_protocol>", "<history_search_protocol>")
		output = strings.ReplaceAll(output, "</search_in_memory_protocol>", "</history_search_protocol>")
		output = strings.ReplaceAll(output, "Choose the appropriate search type", "Choose the appropriate retrieval intent (these names describe question styles, not supported API selectors)")
		output = strings.ReplaceAll(output, "requires center_node_uuid copied verbatim from a 'UUID:' field in a prior search result — never invent one; node_labels/edge_types are optional filters from the taxonomy reference above", "use only entity identifiers actually present in supplied evidence; never invent IDs or relationships; the taxonomy below is a vocabulary for interpreting evidence, not a supported graph filter API")
		output = strings.ReplaceAll(output, "node_labels (PascalCase singular, use verbatim):", "Entity vocabulary (PascalCase singular, use verbatim when classifying evidence):")
		output = strings.ReplaceAll(output, "edge_types (UPPER_SNAKE_CASE, use verbatim):", "Relationship vocabulary (UPPER_SNAKE_CASE, use verbatim when supported by evidence):")
		output = strings.ReplaceAll(output, "Never invent a label/edge outside this list; if unsure, omit node_labels/edge_types and rely on the free-text query instead.", "Never invent labels, relationships or backend graph facts. Use this vocabulary to interpret supplied records; Git memory supports literal text queries, not node_labels/edge_types filters.")
		output = strings.ReplaceAll(output, "using node_labels from the taxonomy reference above", "using entity names recorded in evidence and the vocabulary above")
		output = strings.ReplaceAll(output, "— never a generic \"Entity\" label", "— distinguish actual entity types when interpreting records")
		// The original examples are graph request objects. Preserve their exact
		// query text; turn selectors into human intent without promising APIs.
		example := regexp.MustCompile("(?m)^   - Example: `search_type: \"([^\"]+)\", query: \"([^\"]+)\"([^`]*)`$")
		output = example.ReplaceAllStringFunc(output, func(line string) string {
			parts := example.FindStringSubmatch(line)
			criteria := strings.TrimSpace(strings.TrimPrefix(parts[3], ","))
			// Original example dates are not a live task snapshot. Retain the
			// explicit time-window criterion using dynamic task timestamps.
			criteria = strings.ReplaceAll(criteria, "2024-01-01T00:00:00Z", "[requested start timestamp]")
			criteria = strings.ReplaceAll(criteria, "2024-01-01T23:59:59Z", "[requested end timestamp]")
			text := "   - Example information need (intent: " + parts[1] + "): `" + parts[2] + "`. Translate into exact recorded terms for literal memory queries."
			if criteria != "" {
				text += " Original example evidence criteria (apply manually to supplied/returned records; these are not tool arguments): `" + criteria + "`."
			}
			return text + " Assess chronology, counts, entity identity and diversity in the evidence; no graph selectors are available."
		})
		if output != input {
			add("native-history-query-intents")
		}
	}
	historyTool := "search_in_memory"
	if role == "coder" {
		historyTool = "search_code"
	}
	if role == "pentester" {
		historyTool = "search_guide"
	}
	if strings.Contains(output, "search_in_memory") {
		output = strings.ReplaceAll(output, "<search_in_memory>", "<history_lookup>")
		output = strings.ReplaceAll(output, "</search_in_memory>", "</history_lookup>")
		output = strings.ReplaceAll(output, "search_in_memory.query", historyTool+".questions")
		output = strings.ReplaceAll(output, "<tool_name>search_in_memory</tool_name>", "<tool_name>"+historyTool+" (when advertised; otherwise inspect supplied history and task files)</tool_name>")
		output = strings.ReplaceAll(output, "`"+historyTool+".questions`, `"+historyTool+".questions`", "`"+historyTool+".questions` (reusable knowledge and any history actually recorded in Git memory)")
		add("native-role-memory-tool")
	}
	if role == "maintenance" && heading == "SOFTWARE INSTALLATION PROTOCOL" && strings.Contains(output, "<installation_verification>") {
		output += "\n\nNative capability boundary: perform installation/configuration only through an advertised capability that supports it. Worker shell cannot run package managers, and the stock Kali image/tools must remain unchanged. If a required tool is missing, report the evidence and propose an available equivalent; preserve the verification, two-attempt limit and outcome reporting above for environments where installation is explicitly supported."
		add("native-installation-boundary")
	}
	if heading == "PENETRATION TESTING TOOLS" && strings.Contains(output, "<tool_management_protocol>") {
		output += "\n\nNative capability boundary: the tool names above are a methodology/reference inventory, not an availability guarantee. Only advertised stock Kali MCP tools can perform Linux operations. Preserve installation verification and fallback reasoning without changing the stock image or trying Linux package installation in Worker shell."
		add("native-installation-boundary")
	}
	if output == "" {
		panic("adaptation removed paragraph")
	}
	return output, ids
}

func contains(items []string, s string) bool {
	for _, item := range items {
		if item == s {
			return true
		}
	}
	return false
}

var descriptions = map[string]string{
	"native-summary-identification": "Replace legacy summarize/[summary] recognition with OpenCode-supplied history/compaction; preserve all historical interpretation policies.",
	"native-summary-markers":        "OpenCode owns compaction; retain prohibition on summary imitation and simulated tools without inventing marker tools.",
	"native-adviser-environment":    "Replace Docker environment metadata with actual Computer/Kali ownership and dynamic workspace input.",
	"native-oob-capabilities":       "Keep callback/address discovery/allocated-port reasoning; require actual advertised Kali listener and reachability evidence.",
	"native-backend-execution":      "Replace Docker exec sessions with actual Computer Worker shell versus stock Kali tool capabilities.",
	"native-backend-detach":         "Replace detach/timeouts with returned stock operation identity, inspection and unknown-outcome reconciliation.",
	"native-msf-lifecycle":          "Retain noninteractive/exit/session-consolidation MSF procedures as Kali-only examples through actual stock tools.",
	"native-msf-rpc":                "Preserve session continuity and port checks through advertised stock lifecycle; remove direct RPC, detached flags and invented credentials.",
	"native-owned-cleanup":          "Preserve orphan/conflict diagnosis while cleaning up only the task's owned stock operation on the shared host.",
	"native-network-reachability":   "Retain port checks; do not assume Worker/Kali localhost or forwarding equivalence.",
	"native-command-detach":         "Preserve batch/daemon distinction and output minimization with actual stock Kali inspection instead of unsupported detach flags.",
	"native-customer-input":         "Retain all customer-context preservation requirements using advertised native input tools; report missing context when unavailable. OpenCode owns pending questions and model recovery; interrupted questions may be reissued after host reset.",
	"native-history-query-intents":  "Preserve every retrieval intent, query, taxonomy and WHEN/USE distinction; convert unsupported graph selectors to literal-query/evidence interpretation.",
	"native-installation-boundary":  "Preserve original installation verification/retry/fallback/reporting while respecting immutable stock Kali and Worker capabilities.",
	"native-role-memory-tool":       "Use the actually advertised role-specific Git memory search schema, not a renamed unsupported graph API.",
}

func contract(role roleSpec) string {
	completion := "Finish this specialist job by calling `" + role.Result + "` once with the role-specific result and message fields required below."
	if role.Role == "adviser" {
		completion = "Finish by returning the advisory response as text in English. This role has no terminal result tool; the native runtime publishes its completed advisory answer."
	}
	inputPolicy := "Do not poll another job, start another conversation or wait for a human."
	if role.Role == "primary" {
		inputPolicy = "Do not poll another job or start another conversation. Primary may use an advertised native `question` only when missing operator input prevents work. OpenCode owns the pending question and model recovery; an interrupted question may be reissued after host reset. This is not a routine confirmation requirement."
	}
	return "## NATIVE EXECUTION CONTRACT\n\n" +
		"The structured task input supplies the current time, cwd, engagement language (English if absent), attachments, original arguments, execution context and actual tool catalog. `<task-workspace>` below means that supplied cwd, not a literal directory name.\n\n" +
		"Keep this role's identity, substantive methodology, knowledge policies, language policy and result requirements active throughout the job. Use only advertised tools and actual tool schemas. Optional knowledge/search/input tools apply only when present; use supplied context and guarded task files or report a capability gap when they are absent.\n\n" +
		"Cloudflare Computer owns guarded files, Worker shell and isolated JavaScript; cloudflare_browser provides persistent Chromium when advertised. Worker shell has no Linux binaries, package manager, sockets or detached processes.\n\n" +
		kaliRuntimeContract + "\n\n" +
		"Memory tools search accepted Git-backed Markdown by literal text and store candidate memory artifacts that become durable only through accepted publication. Decompose information needs into exact known technical strings for literal matching; do not expect semantic matching. Inspect supplied execution history separately from reusable guides/code/answers; there is no configured temporal graph or global vector index. Never fabricate missing history, graph facts or tool outcomes.\n\n" +
		"Use structured tool calls for actions, verify returned evidence, and respect engagement scope, guarded paths, cancellation and immutable result ownership. Limit an identical tool call or approach to three attempts, then pivot; the original installation-capable-environment procedure allows only two installation attempts before an alternative. No default attempt deadline applies. A remote timeout or interrupted mutation may have an unknown outcome: retain returned operation IDs, inspect through the matching stock result tool, and require reconciliation before retrying.\n\n" +
		"Delegation returns a dispatch receipt, not a completed peer response. Primary sends a batch, calls `yield` and stops; it reviews results in the next fresh slice and calls `done` only when no further work remains. Other specialists return their own result immediately even if follow-up work was delegated. " + inputPolicy + "\n\n" +
		completion + " Required completion, language, planning, evidence and safety policies are always present in this role; they do not depend on loading a skill. Load the bundled `pentcloud-tools` skill when detailed command/lifecycle or Kali tool-reference procedures are useful. Its reference inventory does not grant tool availability.\n\n"
}

func generate(root string) (generated, error) {
	r := generated{Files: map[string]string{}, Manifest: manifest{Version: 1, Generator: "scripts/native-specialists (Go text/template; deterministic build-time adaptations)", RenderData: renderData(), Adaptations: map[string]string{}}}
	r.Manifest.BranchPolicy = map[string]string{
		"AskUserEnabled=true":        "Retain all substantive customer-context preservation policies; adapt original ask calls to the primary's advertised native question capability. OpenCode owns the pending question and model recovery; an interrupted question may be reissued after host reset.",
		"GraphitiEnabled=true":       "Retain every optional historical-query intent, taxonomy, query example and reusable/episodic distinction; adapt graph claims and selectors to actual role-specific Git memory and supplied history.",
		"UserFiles=sentinel":         "Retain every optional role-specific materials policy; take actual attachment metadata from structured task input.",
		"IsDefaultDockerImage=false": "Original alternate branch claims all tools are preinstalled/current in vxcontrol/kali-linux and need no updates. Those environment-only claims are intentionally replaced by actual stock Kali catalog verification, not treated as substantive specialist guidance.",
		"Dynamic fields":             "Render sentinels with Go semantics only at build time, then replace every dynamic time/path/context/files/catalog value with instructions to read structured task input. N remains the original 12000-character reporting limit.",
		"Native Kali lifetime":       "The common native execution contract and bundled tool skill describe one shared on-demand Cloudflare Kali Container, pre-model readiness, active-work activity, native 30-minute inactivity, ephemeral scratch/processes, Workspace/Artifacts publication and unknown-outcome reconciliation. This runtime-only addition does not alter imported specialist guidance or stock MCP schemas.",
	}
	for _, repl := range replacements {
		r.Manifest.Adaptations[repl.ID] = repl.Reason
	}
	for id, reason := range descriptions {
		r.Manifest.Adaptations[id] = reason
	}
	var skill strings.Builder
	skill.WriteString("---\nname: pentcloud-tools\ndescription: Detailed native Computer and stock Kali tool procedures, output handling, framework lifecycle and reference inventory for PentCloud specialists.\n---\n\n# PentCloud tool procedures\n\nThis bundled OpenCode skill contains supplementary detailed procedures retained from PentAGI. Role identity, substantive methodology, language, completion and essential safety remain always loaded in each role. This reference inventory does not promise that every named Linux tool or arbitrary command execution is exposed. Use only the live advertised tools and schemas. Worker shell handles text/files/read-only Git and HTTP(S) curl through Cloudflare fetch, and has no Linux binaries, package manager, sockets or detached processes; isolated JavaScript and persistent Chromium use their own advertised tools. Linux operations use stock Kali MCP, which owns remote scan/session lifecycle. Inspect returned IDs; never retry a mutation with an unknown remote outcome before reconciliation. Preserve the shared stock Kali image and clean up only owned operations.\n\n")
	skill.WriteString(kaliRuntimeContract + "\n\n")
	skill.WriteString("## Native delegation and operator inputs\n\nDelegation returns a dispatch receipt. Primary dispatches a batch, calls yield and stops; fresh primary slices receive completed wave results. Other specialists immediately submit their own result, even after delegating follow-up work. Only primary may use an advertised native question tool when missing operator input prevents work. OpenCode owns the pending question and model recovery; an interrupted question may be reissued after host reset. Use the authenticated operator reply for the current pending question; do not poll, use legacy ask, build another input queue or request routine per-tool confirmation. Cancellation and the attempt's immutable publication fence remain authoritative.\n\n")
	skill.WriteString("## Native HTTP and scanner checks\n\nUse Worker shell curl for ordinary HTTP(S), including request methods, headers, bodies and guarded workspace output. It is Cloudflare Computer's fetch-backed curl subset, not Linux libcurl: check curl --help before using extra flags. --dump-header / -D is unavailable; curl --include URL > response.txt retains headers and body, while -o stores the body only. Set cwd to the supplied task workspace, use explicit request timeouts and honor the engagement limits. Worker localhost is not Kali localhost.\n\nFor stock WhatWeb, choose aggression stealthy for baseline discovery; it produced an observed HTTP response and technology results in native acceptance. The advertised polite preset returned completed with no HTTP status or technologies on the same reachable target. A completed label alone is not proof of coverage: inspect http_status and error, retain the scan_id, and report empty output as incomplete. Do not retry unknown operations.\n\nFor FFUF, start with a small task-owned wordlist imported with pentcloud_kali_import. Set threads and rate explicitly within the engagement budget; timeout is a request timeout, not a whole-scan deadline. Compare a known path with a unique missing path and filter the SPA catch-all by response size before broader discovery. Bound total work and retain the existing scan ID for result inspection and evidence export. Use only options in the live tool schema.\n\n")
	move := map[string]bool{"COMMAND EXECUTION RULES": true, "BACKEND TERMINAL EXECUTION MECHANICS": true, "PENETRATION TESTING TOOLS": true, "TOOL UTILIZATION": true}
	for _, role := range roles {
		sourcePath := "internal/prompts/assets/" + role.Template + ".tmpl"
		upstreamPath := "upstream/pentagi/prompts/" + role.Template + ".tmpl"
		original, err := os.ReadFile(filepath.Join(root, sourcePath))
		if err != nil {
			return r, err
		}
		upstream, err := os.ReadFile(filepath.Join(root, upstreamPath))
		if err != nil {
			return r, err
		}
		if !bytes.Equal(original, upstream) {
			return r, fmt.Errorf("imported original differs from upstream: %s", sourcePath)
		}
		tmpl, err := template.New(role.Template).Option("missingkey=error").Parse(string(original))
		if err != nil {
			return r, err
		}
		var rendered bytes.Buffer
		if err = tmpl.Execute(&rendered, r.Manifest.RenderData); err != nil {
			return r, err
		}
		entry := roleManifest{Role: role.Role, ResultTool: role.Result, Source: sourcePath, Upstream: upstreamPath, SourceSHA256: digest(original), UpstreamSHA256: digest(upstream), RenderedSHA256: digest(rendered.Bytes())}
		blocks := strings.Split(strings.TrimSpace(rendered.String()), "\n## ")
		var body strings.Builder
		for i, block := range blocks {
			lines := strings.SplitN(block, "\n", 2)
			heading := lines[0]
			if i == 0 {
				heading = strings.TrimPrefix(heading, "# ")
			}
			text := ""
			if len(lines) == 2 {
				text = strings.TrimSpace(lines[1])
			}
			sec := section{Heading: heading, SourceSHA256: digest([]byte(block))}
			dest := role.Role + ".md"
			if move[heading] {
				dest = "tools.md"
				fmt.Fprintf(&skill, "## %s — %s\n\n", strings.ToUpper(role.Role), heading)
			} else {
				if i == 0 {
					fmt.Fprintf(&body, "# %s\n\n%s", heading, contract(role))
				} else {
					fmt.Fprintf(&body, "## %s\n\n", heading)
				}
			}
			for _, p := range strings.Split(text, "\n\n") {
				if strings.TrimSpace(p) == "" {
					continue
				}
				out, ids := adaptParagraph(role.Role, heading, p)
				sec.Paragraphs = append(sec.Paragraphs, paragraph{Source: p, SourceSHA256: digest([]byte(p)), Output: out, OutputSHA256: digest([]byte(out)), Destination: dest, Adaptations: ids})
				if dest == "tools.md" {
					skill.WriteString(out + "\n\n")
				} else {
					body.WriteString(out + "\n\n")
				}
			}
			entry.Sections = append(entry.Sections, sec)
		}
		if role.Role == "adviser" {
			body.WriteString("## LANGUAGE POLICY\n\nReturn technical advice, code, commands, source excerpts and the final advisory response in English. Any available tool `message` field is an engagement-log entry in the engagement language from structured task input. Preserve technical identifiers literally.\n")
		}
		r.Files[role.Role+".md"] = strings.TrimSpace(body.String()) + "\n"
		r.Manifest.Roles = append(r.Manifest.Roles, entry)
	}
	r.Files["tools.md"] = strings.TrimSpace(skill.String()) + "\n"
	used := map[string]bool{}
	r.Manifest.Statistics.Roles = len(r.Manifest.Roles)
	for _, role := range r.Manifest.Roles {
		for _, sec := range role.Sections {
			r.Manifest.Statistics.Sections++
			for _, p := range sec.Paragraphs {
				r.Manifest.Statistics.Paragraphs++
				if p.Source == p.Output {
					r.Manifest.Statistics.RetainedParagraphs++
				} else {
					r.Manifest.Statistics.AdaptedParagraphs++
				}
				if p.Destination == "tools.md" {
					r.Manifest.Statistics.ParagraphsInSkill++
				}
				for _, id := range p.Adaptations {
					used[id] = true
				}
			}
		}
	}
	for id := range r.Manifest.Adaptations {
		if !used[id] {
			delete(r.Manifest.Adaptations, id)
		}
	}
	r.Files["README.md"] = readme(r.Manifest)
	data, err := json.MarshalIndent(r.Manifest, "", "  ")
	if err != nil {
		return r, err
	}
	r.Files["provenance.json"] = string(data) + "\n"
	return r, nil
}

func readme(_ manifest) string {
	return `# Agent prompt sources

These runtime defaults adapt PentAGI's specialist guidance to Cloudflare Computer,
OpenCode and the shared Kali toolbox. Eight role files supply the always-loaded
role guidance; tools.md supplies the bundled pentcloud-tools skill.
The original upstream/internal Go templates remain unchanged.

Regenerate from the repository root with Go 1.26.5:

    go run ./scripts/native-specialists
    go run ./scripts/native-specialists -check
    go test ./scripts/native-specialists ./internal/contracts

provenance.json records original paragraphs, explicit runtime adaptations and
source/output hashes. Tests verify the original template hashes, deterministic
output and retained role/procedure obligations. Go templates are build-time
provenance only; new settings and launches require explicit Markdown instructions.
`
}

func main() {
	check := flag.Bool("check", false, "check generated files without writing")
	flag.Parse()
	root, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	result, err := generate(root)
	if err != nil {
		panic(err)
	}
	if err = os.MkdirAll(filepath.Join(root, outputDir), 0755); err != nil {
		panic(err)
	}
	names := make([]string, 0, len(result.Files))
	for name := range result.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		path := filepath.Join(root, outputDir, name)
		if *check {
			b, err := os.ReadFile(path)
			if err != nil || string(b) != result.Files[name] {
				fmt.Fprintln(os.Stderr, "stale generated specialist source:", name)
				os.Exit(1)
			}
		} else if err := os.WriteFile(path, []byte(result.Files[name]), 0644); err != nil {
			panic(err)
		}
	}
	fmt.Printf("verified %d roles and %d source paragraphs\n", len(result.Manifest.Roles), paragraphCount(result.Manifest))
}

func paragraphCount(m manifest) int {
	n := 0
	for _, r := range m.Roles {
		for _, s := range r.Sections {
			n += len(s.Paragraphs)
		}
	}
	return n
}
