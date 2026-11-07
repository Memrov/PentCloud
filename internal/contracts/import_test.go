package contracts_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

const (
	pinnedCommit = "cffed9485aa1cca70762cd08a57ac62a80406258"
	promptDigest = "fe64d11a7a9ad76f9c9664ad7066b059dbfa51e4950999688470680d3801720a"
)

type promptManifest struct {
	Repository      string         `json:"repository"`
	Commit          string         `json:"commit"`
	AggregateSHA256 string         `json:"aggregate_sha256"`
	Files           []manifestFile `json:"files"`
}

type manifestFile struct {
	SourcePath   string `json:"source_path"`
	VendoredPath string `json:"vendored_path"`
	SHA256       string `json:"sha256"`
}

type toolSnapshot struct {
	Tools []struct {
		Name string `json:"name"`
	} `json:"tools"`
}

type roleSnapshot struct {
	Roles map[string][]string `json:"roles"`
}

func TestPinnedImport(t *testing.T) {
	root := repoRoot(t)
	manifest := readJSON[promptManifest](t, filepath.Join(root, "upstream/pentagi/manifest.json"))
	if manifest.Commit != pinnedCommit {
		t.Fatalf("manifest commit = %q, want %q", manifest.Commit, pinnedCommit)
	}
	if manifest.AggregateSHA256 != promptDigest {
		t.Fatalf("manifest aggregate = %q, want %q", manifest.AggregateSHA256, promptDigest)
	}

	promptRoot := filepath.Join(root, "upstream/pentagi/prompts")
	entries, err := os.ReadDir(promptRoot)
	if err != nil {
		t.Fatalf("read imported prompts: %v", err)
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".tmpl") {
			names = append(names, entry.Name())
		}
	}
	slices.Sort(names)
	if got := len(names); got != 39 {
		t.Fatalf("prompt count = %d, want 39", got)
	}
	if got := len(manifest.Files); got != 39 {
		t.Fatalf("manifest file count = %d, want 39", got)
	}

	filesByPath := make(map[string]string, len(manifest.Files))
	var aggregate strings.Builder
	for _, file := range manifest.Files {
		filesByPath[file.VendoredPath] = file.SHA256
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(file.VendoredPath)))
		if err != nil {
			t.Fatalf("read %s: %v", file.VendoredPath, err)
		}
		sum := sha256.Sum256(data)
		got := hex.EncodeToString(sum[:])
		if got != file.SHA256 {
			t.Errorf("%s digest = %s, want %s", file.VendoredPath, got, file.SHA256)
		}
		fmt.Fprintf(&aggregate, "%s  %s\n", got, file.SourcePath)
	}
	for _, name := range names {
		path := "upstream/pentagi/prompts/" + name
		if _, ok := filesByPath[path]; !ok {
			t.Errorf("prompt %s absent from manifest", path)
		}
		canonical, err := os.ReadFile(filepath.Join(promptRoot, name))
		if err != nil {
			t.Fatalf("read canonical prompt %s: %v", name, err)
		}
		embedded, err := os.ReadFile(filepath.Join(root, "internal/prompts/assets", name))
		if err != nil {
			t.Fatalf("read embedded prompt %s: %v", name, err)
		}
		if string(embedded) != string(canonical) {
			t.Errorf("embedded prompt %s differs from canonical import", name)
		}
	}
	gotAggregate := sha256.Sum256([]byte(aggregate.String()))
	if got := hex.EncodeToString(gotAggregate[:]); got != promptDigest {
		t.Fatalf("computed aggregate = %s, want %s", got, promptDigest)
	}

	tools := readJSON[toolSnapshot](t, filepath.Join(root, "contracts/pentagi-tools.json"))
	if got := len(tools.Tools); got != 40 {
		t.Fatalf("tool schema count = %d, want 40", got)
	}

	roles := readJSON[roleSnapshot](t, filepath.Join(root, "contracts/pentagi-roles.json"))
	primary := roles.Roles["primary"]
	for _, required := range []string{"done", "advice", "coder", "maintenance", "memorist", "pentester", "search"} {
		if !slices.Contains(primary, required) {
			t.Errorf("primary role missing %q", required)
		}
	}
	if slices.Contains(primary, "terminal") {
		t.Error("primary role must not include terminal")
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate test source")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../.."))
}

func readJSON[T any](t *testing.T, path string) T {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return value
}
