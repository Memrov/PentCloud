package launchprompt

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestBuildPreservesRenderedTemplateInsideVersionedWrapper(t *testing.T) {
	arguments := json.RawMessage(`{"question":"inspect the fixture","message":"delegate"}`)
	launch, err := Build("pentester", arguments, Context{
		Now: time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC), Cwd: "/workspace/job", Lang: "English",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains([]byte(launch.Prompt), launch.TemplatePrompt) {
		t.Fatal("launch wrapper does not contain the exact rendered template bytes")
	}
	if strings.Contains(string(launch.TemplatePrompt), "<no value>") {
		t.Fatal("rendered template contains an unset upstream field")
	}
	sum := sha256.Sum256(launch.TemplatePrompt)
	if got := hex.EncodeToString(sum[:]); got != launch.PromptDigest {
		t.Fatalf("prompt digest = %s, want %s", launch.PromptDigest, got)
	}
	if len(launch.MCPToolDigest) != 64 {
		t.Fatalf("MCP tool digest = %q", launch.MCPToolDigest)
	}
	if !strings.Contains(launch.Prompt, `<ORIGINAL_PENTAGI_TOOL_CALL name="pentester">`+"\n"+`{"message":"delegate","question":"inspect the fixture"}`) {
		t.Fatal("launch wrapper does not preserve canonical original tool arguments")
	}
}

func TestBuildSupportsEveryDelegatedSpecialist(t *testing.T) {
	for _, tool := range []string{"primary", "reporter", "advice", "coder", "maintenance", "memorist", "pentester", "search"} {
		t.Run(tool, func(t *testing.T) {
			launch, err := Build(tool, json.RawMessage(`{"question":"work","code":"","output":"","message":"delegate"}`), Context{
				Now: time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC),
			})
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(launch.TemplatePrompt), "<no value>") {
				t.Fatalf("%s prompt has an unset field", tool)
			}
		})
	}
}

func TestBuildWithTemplateWrapsTheRenderedOverride(t *testing.T) {
	launch, err := BuildWithTemplate("coder", json.RawMessage(`{"question":"work"}`), Context{
		Now: time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC), Lang: "English",
	}, []byte("custom role={{.Lang}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if string(launch.TemplatePrompt) != "custom role=English\n" {
		t.Fatalf("template prompt = %q", launch.TemplatePrompt)
	}
	if !strings.Contains(launch.Prompt, "custom role=English") {
		t.Fatal("launch wrapper omitted override")
	}
}
