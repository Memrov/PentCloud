import { Combobox } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";

import { filterModels, type UISettingsModel } from "./model";

interface ModelPickerProps {
  models: UISettingsModel[];
  selectedId: string;
  stale: boolean;
  disabled: boolean;
  onSelect: (model: UISettingsModel) => void;
}

export function ModelPicker(props: ModelPickerProps) {
  const connected = props.models.find((model) => model.id === props.selectedId);
  const selected: UISettingsModel = connected ?? {
    id: props.selectedId,
    name: props.selectedId,
    provider: props.selectedId.split("/", 1)[0]!,
    inputModalities: [],
    outputModalities: [],
    supportedParameters: [],
    reasoningEfforts: [],
  };
  return (
    <section className="settings-model-picker">
      <Combobox<UISettingsModel>
        items={props.models}
        value={selected}
        disabled={props.disabled}
        itemToStringLabel={(model) => model.name}
        itemToStringValue={(model) => model.id}
        isItemEqualToValue={(model, value) => model.id === value.id}
        filter={(model, query) => filterModels([model], query).length > 0}
        // Every role needs a model; clearing resets the search while keeping its saved selection.
        onValueChange={(model) => { if (model) props.onSelect(model); }}
      >
        <Combobox.TriggerInput aria-label="Search connected models" clearLabel="Clear model search" placeholder="Search OpenCode Go models…" />
        <Combobox.Content className="settings-model-popup">
          <Combobox.List>
            {(model: UISettingsModel) => (
              <Combobox.Item key={model.id} value={model} className="settings-model-option">
                <ModelSummary model={model} />
              </Combobox.Item>
            )}
          </Combobox.List>
          <Combobox.Empty>No connected models match this search.</Combobox.Empty>
        </Combobox.Content>
      </Combobox>
      <div className="settings-model-selection" role="group" aria-label="Selected model">
        <ModelSummary model={selected} />
      </div>
      {(!connected || props.stale) && <span className="settings-stale"><WarningCircleIcon size={13} />
        {connected ? "Cached catalog" : "Saved selection is not in the connected catalog"}
      </span>}
    </section>
  );
}

function ModelSummary({ model }: { model: UISettingsModel }) {
  return <>
    <span className="settings-model-main"><strong>{model.name}</strong><small>{model.id}</small></span>
    <span className="settings-model-meta">
      <span>{model.provider}</span>
      {model.contextLength && <span>{formatContext(model.contextLength)} context</span>}
      {model.supportedParameters.includes("tools") && <span>Tools</span>}
    </span>
  </>;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
