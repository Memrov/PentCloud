package launchprompt

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/Memrov/pentagi-artifacts/internal/contracts"
	"github.com/Memrov/pentagi-artifacts/internal/prompts"
)

const Version = 1

type Context struct {
	Now          time.Time
	Cwd          string
	DockerImage  string
	Lang         string
	UserFiles    string
	EnabledTools []string
}

type Launch struct {
	Role           contracts.Role
	Prompt         string
	PromptDigest   string
	MCPToolDigest  string
	TemplatePrompt []byte
}

var delegatedRoles = map[string]contracts.Role{
	"primary":     contracts.RolePrimary,
	"reporter":    contracts.RoleReporter,
	"advice":      contracts.RoleAdviser,
	"coder":       contracts.RoleCoder,
	"maintenance": contracts.RoleMaintenance,
	"memorist":    contracts.RoleMemorist,
	"pentester":   contracts.RolePentester,
	"search":      contracts.RoleSearcher,
}

func Build(tool string, arguments json.RawMessage, context Context) (Launch, error) {
	return build(tool, arguments, context, nil)
}

func BuildWithTemplate(tool string, arguments json.RawMessage, context Context, source []byte) (Launch, error) {
	if len(source) == 0 {
		return Launch{}, fmt.Errorf("prompt template override is empty")
	}
	return build(tool, arguments, context, source)
}

func build(tool string, arguments json.RawMessage, context Context, source []byte) (Launch, error) {
	role, ok := delegatedRoles[tool]
	if !ok {
		return Launch{}, fmt.Errorf("tool %q is not a specialist delegation", tool)
	}
	var decoded map[string]any
	if err := json.Unmarshal(arguments, &decoded); err != nil {
		return Launch{}, fmt.Errorf("decode %s arguments: %w", tool, err)
	}
	if decoded == nil {
		return Launch{}, fmt.Errorf("%s arguments must be an object", tool)
	}
	canonicalArguments, err := json.Marshal(decoded)
	if err != nil {
		return Launch{}, err
	}
	data := renderData(tool, canonicalArguments, context)
	var templatePrompt []byte
	var digest prompts.Digest
	if source == nil {
		templatePrompt, digest, err = prompts.Render(role, data)
	} else {
		templatePrompt, digest, err = prompts.RenderSource(role, source, data)
	}
	if err != nil {
		return Launch{}, err
	}
	catalog, err := contracts.Load()
	if err != nil {
		return Launch{}, err
	}
	tools, err := catalog.ToolsForRoleWithOptional(role, context.EnabledTools)
	if err != nil {
		return Launch{}, err
	}
	toolBytes, err := json.Marshal(tools)
	if err != nil {
		return Launch{}, err
	}
	toolDigest := sha256.Sum256(toolBytes)
	var launch bytes.Buffer
	fmt.Fprintf(&launch, "<PENTAGI_SPECIALIST_LAUNCH version=%q>\n", fmt.Sprint(Version))
	launch.WriteString("Run exactly one specialist job in /workspace/job. Use only the role-scoped PentAGI MCP tools. Finish by calling the role's terminal result tool once. Never wait for a human or another job. Delegation returns a dispatch receipt; after sending a batch, primary must call yield and stop. Review wave results only in the next fresh primary slice. Primary should fold planning and replanning into its own slice and call done only when no further work is needed. Every other specialist submits its result immediately even if it has delegated follow-up work. Do not start another model or conversation.\n")
	fmt.Fprintf(&launch, "<ORIGINAL_PENTAGI_SYSTEM_PROMPT sha256=%q>\n", digest)
	launch.Write(templatePrompt)
	if len(templatePrompt) == 0 || templatePrompt[len(templatePrompt)-1] != '\n' {
		launch.WriteByte('\n')
	}
	launch.WriteString("</ORIGINAL_PENTAGI_SYSTEM_PROMPT>\n")
	fmt.Fprintf(&launch, "<ORIGINAL_PENTAGI_TOOL_CALL name=%q>\n", tool)
	launch.Write(canonicalArguments)
	launch.WriteString("\n</ORIGINAL_PENTAGI_TOOL_CALL>\n</PENTAGI_SPECIALIST_LAUNCH>\n")
	return Launch{
		Role: role, Prompt: launch.String(), PromptDigest: string(digest),
		MCPToolDigest: hex.EncodeToString(toolDigest[:]), TemplatePrompt: templatePrompt,
	}, nil
}

func renderData(tool string, arguments []byte, context Context) prompts.RenderData {
	now := context.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	cwd := context.Cwd
	if cwd == "" {
		cwd = "/workspace/job"
	}
	dockerImage := context.DockerImage
	if dockerImage == "" {
		dockerImage = "pentagi-artifacts:boat-v1"
	}
	lang := context.Lang
	if lang == "" {
		lang = "English"
	}
	enabled := append([]string(nil), context.EnabledTools...)
	slices.Sort(enabled)
	has := func(name string) bool { return slices.Contains(enabled, name) }
	return prompts.RenderData{
		"AdviceToolName":            "advice",
		"AskUserEnabled":            false,
		"AskUserToolName":           "ask",
		"CodeResultToolName":        "code_result",
		"CoderToolName":             "coder",
		"ContainerPorts":            "",
		"CurrentTime":               now.UTC().Format(time.RFC3339),
		"Cwd":                       cwd,
		"DockerImage":               dockerImage,
		"EnricherResultToolName":    "enricher_result",
		"ExecutionContext":          fmt.Sprintf("Delegated %s tool call with original arguments: %s", tool, arguments),
		"FileToolName":              "file",
		"FinalyToolName":            "done",
		"GraphitiEnabled":           has("graphiti_search"),
		"GraphitiSearchToolName":    "graphiti_search",
		"HackResultToolName":        "hack_result",
		"IsDefaultDockerImage":      false,
		"Lang":                      lang,
		"MaintenanceResultToolName": "maintenance_result",
		"MaintenanceToolName":       "maintenance",
		"MemoristResultToolName":    "memorist_result",
		"MemoristToolName":          "memorist",
		"PentesterToolName":         "pentester",
		"SearchAnswerToolName":      "search_answer",
		"SearchCodeToolName":        "search_code",
		"SearchGuideToolName":       "search_guide",
		"SearchResultToolName":      "search_result",
		"ReportResultToolName":      "report_result",
		"N":                         12000,
		"SearchToolName":            "search",
		"StoreAnswerToolName":       "store_answer",
		"StoreCodeToolName":         "store_code",
		"StoreGuideToolName":        "store_guide",
		"SummarizationToolName":     "summarize",
		"SummarizedContentPrefix":   "[summary]",
		"TerminalToolName":          "terminal",
		"ToolPlaceholder":           "Tools are supplied by the role-scoped PentAGI MCP server.",
		"UserFiles":                 strings.TrimSpace(context.UserFiles),
		"WebSearchToolName":         "web_search",
	}
}
