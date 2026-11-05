package contracts

import (
	"embed"
	"encoding/json"
	"fmt"
	"slices"
)

type Role string

const (
	RolePrimary         Role = "primary"
	RoleGenerator       Role = "generator"
	RoleRefiner         Role = "refiner"
	RoleMaintenance     Role = "maintenance"
	RoleCoder           Role = "coder"
	RolePentester       Role = "pentester"
	RoleSearcher        Role = "searcher"
	RoleMemorist        Role = "memorist"
	RoleEnricher        Role = "enricher"
	RoleReporter        Role = "reporter"
	RoleAdviser         Role = "adviser"
	RoleReflector       Role = "reflector"
	RoleAssistantAgent  Role = "assistant_agent"
	RoleAssistantDirect Role = "assistant_direct"
)

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Category    string          `json:"category"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type Catalog struct {
	Tools    map[string]Tool
	Roles    map[Role][]string
	Optional map[Role][]string
}

type toolFile struct {
	Tools []Tool `json:"tools"`
}

type roleFile struct {
	Roles    map[Role][]string `json:"roles"`
	Optional map[Role][]string `json:"optional"`
}

//go:embed assets/pentagi-tools.json assets/pentagi-roles.json assets/cloudflare-tools.json
var snapshots embed.FS

func Load() (Catalog, error) {
	toolsJSON, err := snapshots.ReadFile("assets/pentagi-tools.json")
	if err != nil {
		return Catalog{}, fmt.Errorf("read embedded tool catalog: %w", err)
	}
	rolesJSON, err := snapshots.ReadFile("assets/pentagi-roles.json")
	if err != nil {
		return Catalog{}, fmt.Errorf("read embedded role catalog: %w", err)
	}
	catalog, err := parseCatalog(toolsJSON, rolesJSON)
	if err != nil {
		return Catalog{}, err
	}
	extensionJSON, err := snapshots.ReadFile("assets/cloudflare-tools.json")
	if err != nil {
		return Catalog{}, fmt.Errorf("read embedded Cloudflare tool catalog: %w", err)
	}
	return mergeExtension(catalog, extensionJSON)
}

type extensionFile struct {
	Tools []Tool            `json:"tools"`
	Roles map[Role][]string `json:"roles"`
}

func mergeExtension(catalog Catalog, data []byte) (Catalog, error) {
	var extension extensionFile
	if err := json.Unmarshal(data, &extension); err != nil {
		return Catalog{}, fmt.Errorf("decode Cloudflare tool catalog: %w", err)
	}
	for _, tool := range extension.Tools {
		if tool.Name == "" || !json.Valid(tool.InputSchema) {
			return Catalog{}, fmt.Errorf("Cloudflare tool catalog contains an invalid tool")
		}
		if _, exists := catalog.Tools[tool.Name]; exists {
			return Catalog{}, fmt.Errorf("duplicate tool %q", tool.Name)
		}
		catalog.Tools[tool.Name] = tool
	}
	for role, names := range extension.Roles {
		if _, ok := catalog.Roles[role]; !ok {
			return Catalog{}, fmt.Errorf("Cloudflare tools reference unknown role %q", role)
		}
		catalog.Roles[role] = append(catalog.Roles[role], names...)
		if err := catalog.validateRole(role, catalog.Roles[role]); err != nil {
			return Catalog{}, err
		}
	}
	return catalog, nil
}

func parseCatalog(toolsJSON, rolesJSON []byte) (Catalog, error) {
	var toolsDoc toolFile
	if err := json.Unmarshal(toolsJSON, &toolsDoc); err != nil {
		return Catalog{}, fmt.Errorf("decode tool catalog: %w", err)
	}
	var rolesDoc roleFile
	if err := json.Unmarshal(rolesJSON, &rolesDoc); err != nil {
		return Catalog{}, fmt.Errorf("decode role catalog: %w", err)
	}

	catalog := Catalog{
		Tools:    make(map[string]Tool, len(toolsDoc.Tools)),
		Roles:    rolesDoc.Roles,
		Optional: rolesDoc.Optional,
	}
	for _, tool := range toolsDoc.Tools {
		if tool.Name == "" {
			return Catalog{}, fmt.Errorf("tool name is empty")
		}
		if _, exists := catalog.Tools[tool.Name]; exists {
			return Catalog{}, fmt.Errorf("duplicate tool %q", tool.Name)
		}
		if !json.Valid(tool.InputSchema) {
			return Catalog{}, fmt.Errorf("tool %q has invalid input schema", tool.Name)
		}
		catalog.Tools[tool.Name] = tool
	}
	for role, names := range catalog.Roles {
		if err := catalog.validateRole(role, names); err != nil {
			return Catalog{}, err
		}
	}
	for role, names := range catalog.Optional {
		if _, ok := catalog.Roles[role]; !ok {
			return Catalog{}, fmt.Errorf("optional tools reference unknown role %q", role)
		}
		if err := catalog.validateRole(role, names); err != nil {
			return Catalog{}, err
		}
	}
	return catalog, nil
}

func (c Catalog) validateRole(role Role, names []string) error {
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if _, ok := c.Tools[name]; !ok {
			return fmt.Errorf("role %q references unknown tool %q", role, name)
		}
		if _, ok := seen[name]; ok {
			return fmt.Errorf("role %q repeats tool %q", role, name)
		}
		seen[name] = struct{}{}
	}
	return nil
}

func (c Catalog) ToolsForRole(role Role) ([]Tool, error) {
	return c.ToolsForRoleWithOptional(role, nil)
}

func (c Catalog) ToolsForRoleWithOptional(role Role, enabled []string) ([]Tool, error) {
	names, ok := c.Roles[role]
	if !ok {
		return nil, fmt.Errorf("unknown role %q", role)
	}
	optional := make(map[string]struct{}, len(c.Optional[role]))
	for _, name := range c.Optional[role] {
		optional[name] = struct{}{}
	}
	allNames := append([]string(nil), names...)
	for _, name := range enabled {
		if _, ok := optional[name]; !ok {
			return nil, fmt.Errorf("tool %q is not optional for role %q", name, role)
		}
		allNames = append(allNames, name)
	}
	slices.Sort(allNames)
	allNames = slices.Compact(allNames)
	result := make([]Tool, 0, len(allNames))
	for _, name := range allNames {
		result = append(result, c.Tools[name])
	}
	slices.SortFunc(result, func(a, b Tool) int {
		if a.Name < b.Name {
			return -1
		}
		if a.Name > b.Name {
			return 1
		}
		return 0
	})
	return result, nil
}
