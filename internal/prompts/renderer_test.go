package prompts

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Memrov/pentagi-artifacts/internal/contracts"
)

func TestRenderMatchesPinnedUpstreamGoldenBytes(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "render-cases.json"))
	if err != nil {
		t.Fatalf("read render cases: %v", err)
	}
	var cases map[string]RenderData
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("decode render cases: %v", err)
	}

	for _, tc := range []struct {
		name   string
		role   contracts.Role
		golden string
	}{
		{name: "primary", role: contracts.RolePrimary, golden: "primary_agent.golden"},
		{name: "pentester", role: contracts.RolePentester, golden: "pentester.golden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			want, err := os.ReadFile(filepath.Join("testdata", tc.golden))
			if err != nil {
				t.Fatalf("read upstream golden: %v", err)
			}
			got, digest, err := Render(tc.role, cases[tc.name])
			if err != nil {
				t.Fatalf("Render: %v", err)
			}
			if string(got) != string(want) {
				t.Fatalf("rendered bytes differ from pinned upstream golden")
			}
			sum := sha256.Sum256(want)
			if got, want := string(digest), hex.EncodeToString(sum[:]); got != want {
				t.Fatalf("digest = %s, want %s", got, want)
			}
		})
	}
}

func TestRenderRejectsRoleWithoutSystemPrompt(t *testing.T) {
	if _, _, err := Render(contracts.Role("invented"), RenderData{}); err == nil {
		t.Fatal("Render(invented) succeeded, want error")
	}
}

func TestRenderSourceUsesOverrideBytesAndDigest(t *testing.T) {
	got, digest, err := RenderSource(contracts.RoleCoder, []byte("role={{.Lang}}\n"), RenderData{"Lang": "English"})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "role=English\n" {
		t.Fatalf("rendered source = %q", got)
	}
	sum := sha256.Sum256([]byte("role=English\n"))
	if string(digest) != hex.EncodeToString(sum[:]) {
		t.Fatalf("digest = %s", digest)
	}
}

func TestRenderSourceRejectsInvalidGoTemplate(t *testing.T) {
	_, _, err := RenderSource(contracts.RoleCoder, []byte("{{if .Lang}}missing end"), RenderData{"Lang": "English"})
	if err == nil || !strings.Contains(err.Error(), "parse prompt") {
		t.Fatalf("RenderSource error = %v", err)
	}
}
