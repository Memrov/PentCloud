package contracts

import (
	"slices"
	"strings"
	"testing"
)

func TestLoadReturnsRoleScopedPinnedTools(t *testing.T) {
	catalog, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := len(catalog.Tools); got != 43 {
		t.Fatalf("tool count = %d, want 43", got)
	}

	primary, err := catalog.ToolsForRole(RolePrimary)
	if err != nil {
		t.Fatalf("ToolsForRole(primary): %v", err)
	}
	names := toolNames(primary)
	for _, required := range []string{"advice", "clef_audit", "coder", "done", "maintenance", "memorist", "pentester", "search", "yield", "revise_attempt"} {
		if !slices.Contains(names, required) {
			t.Errorf("primary role missing %q", required)
		}
	}
	pentester, err := catalog.ToolsForRole(RolePentester)
	if err != nil {
		t.Fatalf("ToolsForRole(pentester): %v", err)
	}
	if slices.Contains(toolNames(pentester), "clef_audit") {
		t.Error("pentester role contains orchestrator-only clef_audit tool")
	}
	for _, tool := range primary {
		if len(tool.InputSchema) == 0 || tool.InputSchema[0] != '{' {
			t.Errorf("tool %s has invalid input schema %q", tool.Name, tool.InputSchema)
		}
	}
}

func TestToolsForRoleRejectsUnknownRole(t *testing.T) {
	catalog, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, err := catalog.ToolsForRole(Role("invented")); err == nil || !strings.Contains(err.Error(), "unknown role") {
		t.Fatalf("ToolsForRole(invented) error = %v, want unknown role", err)
	}
}

func TestToolsForRoleWithOptionalEnablesOnlyDeclaredRoleTools(t *testing.T) {
	catalog, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	tools, err := catalog.ToolsForRoleWithOptional(RolePentester, []string{"browser", "search_guide"})
	if err != nil {
		t.Fatalf("ToolsForRoleWithOptional: %v", err)
	}
	names := toolNames(tools)
	if !slices.Contains(names, "browser") || !slices.Contains(names, "search_guide") {
		t.Fatalf("optional tools missing from %v", names)
	}
	if _, err := catalog.ToolsForRoleWithOptional(RolePentester, []string{"report_result"}); err == nil {
		t.Fatal("pentester accepted reporter-only optional tool")
	}
}

func TestParseCatalogRejectsDuplicateToolAndUnknownReference(t *testing.T) {
	tools := []byte(`{"tools":[{"name":"same","description":"one","category":"none","input_schema":{"type":"object"}},{"name":"same","description":"two","category":"none","input_schema":{"type":"object"}}]}`)
	roles := []byte(`{"roles":{"primary":["missing"]},"optional":{}}`)
	_, err := parseCatalog(tools, roles)
	if err == nil || !strings.Contains(err.Error(), "duplicate tool") {
		t.Fatalf("parseCatalog duplicate error = %v", err)
	}

	tools = []byte(`{"tools":[{"name":"same","description":"one","category":"none","input_schema":{"type":"object"}}]}`)
	_, err = parseCatalog(tools, roles)
	if err == nil || !strings.Contains(err.Error(), "unknown tool") {
		t.Fatalf("parseCatalog unknown reference error = %v", err)
	}
}

func toolNames(tools []Tool) []string {
	names := make([]string, len(tools))
	for i, tool := range tools {
		names[i] = tool.Name
	}
	return names
}
