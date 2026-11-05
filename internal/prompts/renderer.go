package prompts

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"path"
	"text/template"

	"github.com/Memrov/pentagi-artifacts/internal/contracts"
)

type RenderData map[string]any
type Digest string

var rolePrompt = map[contracts.Role]string{
	contracts.RolePrimary:         "primary_agent",
	contracts.RoleGenerator:       "generator",
	contracts.RoleRefiner:         "refiner",
	contracts.RoleMaintenance:     "installer",
	contracts.RoleCoder:           "coder",
	contracts.RolePentester:       "pentester",
	contracts.RoleSearcher:        "searcher",
	contracts.RoleMemorist:        "memorist",
	contracts.RoleEnricher:        "enricher",
	contracts.RoleReporter:        "reporter",
	contracts.RoleAdviser:         "adviser",
	contracts.RoleReflector:       "reflector",
	contracts.RoleAssistantAgent:  "assistant",
	contracts.RoleAssistantDirect: "assistant",
}

//go:embed assets/*.tmpl
var promptFiles embed.FS

func Render(role contracts.Role, data RenderData) ([]byte, Digest, error) {
	name, ok := rolePrompt[role]
	if !ok {
		return nil, "", fmt.Errorf("role %q has no system prompt", role)
	}
	prompt, err := promptFiles.ReadFile(path.Join("assets", name+".tmpl"))
	if err != nil {
		return nil, "", fmt.Errorf("read prompt %q: %w", name, err)
	}
	return RenderSource(role, prompt, data)
}

func RenderSource(role contracts.Role, source []byte, data RenderData) ([]byte, Digest, error) {
	name, ok := rolePrompt[role]
	if !ok {
		return nil, "", fmt.Errorf("role %q has no system prompt", role)
	}
	tmpl, err := template.New(name).Parse(string(source))
	if err != nil {
		return nil, "", fmt.Errorf("parse prompt %q: %w", name, err)
	}
	var rendered bytes.Buffer
	if err := tmpl.Execute(&rendered, data); err != nil {
		return nil, "", fmt.Errorf("render prompt %q: %w", name, err)
	}
	result := rendered.Bytes()
	sum := sha256.Sum256(result)
	return result, Digest(hex.EncodeToString(sum[:])), nil
}
