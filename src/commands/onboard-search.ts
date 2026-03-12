import {
  BUILTIN_WEB_SEARCH_PROVIDER_OPTIONS,
  type BuiltinWebSearchProviderEntry,
  type BuiltinWebSearchProviderId,
  isBuiltinWebSearchProviderId,
} from "../agents/tools/web-search-provider-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretInput,
  type SecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
import {
  applyCapabilitySlotSelection,
  resolveCapabilitySlotSelection,
} from "../plugins/capability-slots.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type { PluginConfigUiHint, PluginOrigin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./onboard-types.js";
import {
  ensureOnboardingPluginInstalled,
  reloadOnboardingPluginRegistry,
} from "./onboarding/plugin-install.js";
import {
  buildProviderSelectionOptions,
  promptProviderManagementIntent,
  type ProviderManagementIntent,
} from "./provider-management.js";
import {
  SEARCH_PROVIDER_PLUGIN_INSTALL_CATALOG,
  type InstallableSearchProviderPluginCatalogEntry,
} from "./search-provider-plugin-catalog.js";

export type SearchProvider = BuiltinWebSearchProviderId;
type SearchProviderEntry = BuiltinWebSearchProviderEntry;
export const SEARCH_PROVIDER_OPTIONS = BUILTIN_WEB_SEARCH_PROVIDER_OPTIONS;

const SEARCH_PROVIDER_INSTALL_SENTINEL = "__install_plugin__" as const;
const SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL = "__keep_current__" as const;
const SEARCH_PROVIDER_SKIP_SENTINEL = "__skip__" as const;
const SEARCH_PROVIDER_SWITCH_ACTIVE_SENTINEL = "__switch_active__" as const;
const SEARCH_PROVIDER_CONFIGURE_SENTINEL = "__configure_provider__" as const;

type PluginSearchProviderEntry = {
  kind: "plugin";
  value: string;
  label: string;
  hint: string;
  configured: boolean;
  pluginId: string;
  origin: PluginOrigin;
  description: string | undefined;
  docsUrl: string | undefined;
  configFieldOrder?: string[];
  configJsonSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
};

export type SearchProviderPickerEntry =
  | (SearchProviderEntry & { kind: "builtin"; configured: boolean })
  | PluginSearchProviderEntry;

type SearchProviderPickerChoice = string;
type SearchProviderFlowIntent = ProviderManagementIntent;

type PluginPromptableField =
  | {
      key: string;
      label: string;
      kind: "string";
      placeholder?: string;
      help?: string;
      sensitive?: boolean;
      existingValue?: string;
    }
  | {
      key: string;
      label: string;
      kind: "enum";
      options: string[];
      help?: string;
      existingValue?: string;
    }
  | {
      key: string;
      label: string;
      kind: "boolean";
      help?: string;
      existingValue?: boolean;
    };

type SearchProviderHookDetails = {
  providerId: string;
  providerLabel: string;
  providerSource: "builtin" | "plugin";
  pluginId?: string;
  configured: boolean;
};

const HOOK_RUNNER_LOGGER = {
  warn: () => {},
  error: () => {},
} as const;

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function humanizeConfigKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

function formatPluginSourceHint(origin: PluginOrigin): string {
  return origin === "bundled" ? "Bundled plugin" : "External plugin";
}

export function resolveInstallableSearchProviderPlugins(
  providerEntries: SearchProviderPickerEntry[],
): InstallableSearchProviderPluginCatalogEntry[] {
  const loadedPluginProviderIds = new Set(
    providerEntries.filter((entry) => entry.kind === "plugin").map((entry) => entry.value),
  );
  return SEARCH_PROVIDER_PLUGIN_INSTALL_CATALOG.filter((entry) => {
    const providerEntry = providerEntries.find(
      (providerEntry) =>
        providerEntry.kind === "plugin" && providerEntry.value === entry.providerId,
    );
    return providerEntry?.kind !== "plugin" || providerEntry.origin !== "bundled";
  }).map((entry) => ({
    ...entry,
    description: loadedPluginProviderIds.has(entry.providerId)
      ? `${entry.description} Already installed.`
      : entry.description,
  }));
}

function normalizePluginConfigObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ({ ...(value as Record<string, unknown>) } as Record<string, unknown>)
    : {};
}

function getPluginConfig(config: OpenClawConfig, pluginId: string): Record<string, unknown> {
  return normalizePluginConfigObject(config.plugins?.entries?.[pluginId]?.config);
}

function setPluginConfig(
  config: OpenClawConfig,
  pluginId: string,
  pluginConfig: Record<string, unknown>,
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [pluginId]: {
          ...(config.plugins?.entries?.[pluginId] as Record<string, unknown> | undefined),
          config: pluginConfig,
        },
      },
    },
  };
}

function setWebSearchProvider(config: OpenClawConfig, provider: string): OpenClawConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: {
          ...config.tools?.web?.search,
          provider,
          enabled: true,
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePromptablePluginFields(
  entry: PluginSearchProviderEntry,
  pluginConfig: Record<string, unknown>,
): PluginPromptableField[] {
  const jsonSchema = entry.configJsonSchema;
  if (!isRecord(jsonSchema)) {
    return [];
  }
  const properties = jsonSchema.properties;
  if (!isRecord(properties)) {
    return [];
  }

  const keys =
    entry.configFieldOrder?.filter((key) => key in properties) ?? Object.keys(properties);

  const fields: PluginPromptableField[] = [];
  for (const key of keys) {
    const propertySchema = properties[key];
    if (!isRecord(propertySchema)) {
      continue;
    }
    const uiHint = entry.configUiHints?.[key];
    if (uiHint?.advanced) {
      continue;
    }
    const label = uiHint?.label?.trim() || humanizeConfigKey(key);
    const help = uiHint?.help?.trim() || undefined;
    const existingValue = pluginConfig[key];

    const enumValues = Array.isArray(propertySchema.enum)
      ? propertySchema.enum.filter((value): value is string => typeof value === "string")
      : [];
    if (enumValues.length > 0) {
      fields.push({
        key,
        label,
        kind: "enum",
        options: enumValues,
        help,
        existingValue: hasNonEmptyString(existingValue) ? existingValue : undefined,
      });
      continue;
    }

    if (propertySchema.type === "boolean") {
      fields.push({
        key,
        label,
        kind: "boolean",
        help,
        existingValue: typeof existingValue === "boolean" ? existingValue : undefined,
      });
      continue;
    }

    if (propertySchema.type === "string") {
      fields.push({
        key,
        label,
        kind: "string",
        help,
        placeholder: uiHint?.placeholder,
        sensitive: uiHint?.sensitive,
        existingValue: hasNonEmptyString(existingValue) ? existingValue : undefined,
      });
    }
  }

  return fields;
}

function validatePluginSearchProviderConfig(
  entry: PluginSearchProviderEntry,
  pluginConfig: Record<string, unknown>,
): { ok: true } | { ok: false; fieldKey?: string; message: string } {
  if (!entry.configJsonSchema) {
    return { ok: true };
  }

  const result = validateJsonSchemaValue({
    schema: entry.configJsonSchema,
    cacheKey: `search-provider:${entry.pluginId}`,
    value: pluginConfig,
  });
  if (result.ok) {
    return { ok: true };
  }

  const promptableKeys = new Set(
    resolvePromptablePluginFields(entry, pluginConfig).map((field) => field.key),
  );
  const fieldError = result.errors.find((error) => {
    const fieldKey = error.path.split(".")[0];
    return fieldKey && promptableKeys.has(fieldKey);
  });
  if (fieldError) {
    return {
      ok: false,
      fieldKey: fieldError.path.split(".")[0],
      message: fieldError.message,
    };
  }

  return {
    ok: false,
    message: result.errors[0]?.message ?? "invalid config",
  };
}

function createSearchProviderHookRunner(
  config: OpenClawConfig,
  workspaceDir?: string,
): HookRunner | null {
  try {
    const registry = loadOpenClawPlugins({
      config,
      cache: false,
      workspaceDir,
      suppressOpenAllowlistWarning: true,
    });
    if (registry.typedHooks.length === 0) {
      return null;
    }
    return createHookRunner(registry, {
      logger: HOOK_RUNNER_LOGGER,
      catchErrors: true,
    });
  } catch {
    return null;
  }
}

async function maybeNoteBeforeSearchProviderConfigure(params: {
  hookRunner: HookRunner | null;
  config: OpenClawConfig;
  provider: SearchProviderHookDetails;
  intent: SearchProviderFlowIntent;
  prompter: WizardPrompter;
  workspaceDir?: string;
}): Promise<void> {
  if (!params.hookRunner?.hasProviderConfigureHooks("search")) {
    return;
  }
  const activeProviderId =
    resolveCapabilitySlotSelection(params.config, "providers.search") ?? null;
  const ctx = { workspaceDir: params.workspaceDir };
  const result = await params.hookRunner.runBeforeProviderConfigure(
    {
      providerKind: "search",
      slot: "providers.search",
      providerId: params.provider.providerId,
      providerLabel: params.provider.providerLabel,
      providerSource: params.provider.providerSource,
      pluginId: params.provider.pluginId,
      intent: params.intent,
      activeProviderId,
      configured: params.provider.configured,
    },
    ctx,
  );
  const note = result?.note;
  if (note.trim()) {
    await params.prompter.note(note, "Provider setup");
  }
}

async function runAfterSearchProviderHooks(params: {
  hookRunner: HookRunner | null;
  originalConfig: OpenClawConfig;
  resultConfig: OpenClawConfig;
  provider: SearchProviderHookDetails;
  intent: SearchProviderFlowIntent;
  workspaceDir?: string;
}): Promise<void> {
  if (!params.hookRunner) {
    return;
  }
  const activeProviderBefore =
    resolveCapabilitySlotSelection(params.originalConfig, "providers.search") ?? null;
  const activeProviderAfter =
    resolveCapabilitySlotSelection(params.resultConfig, "providers.search") ?? null;

  const ctx = { workspaceDir: params.workspaceDir };
  const genericConfigureEvent = {
    providerKind: "search" as const,
    slot: "providers.search",
    providerId: params.provider.providerId,
    providerLabel: params.provider.providerLabel,
    providerSource: params.provider.providerSource,
    pluginId: params.provider.pluginId,
    intent: params.intent,
    activeProviderId: activeProviderAfter,
    configured: params.provider.configured,
  };

  if (params.hookRunner.hasProviderConfigureHooks("search")) {
    await params.hookRunner.runAfterProviderConfigure(genericConfigureEvent, ctx);
  }

  if (
    activeProviderAfter === params.provider.providerId &&
    activeProviderBefore !== activeProviderAfter &&
    params.hookRunner.hasProviderActivationHooks("search")
  ) {
    const genericActivateEvent = {
      providerKind: "search" as const,
      slot: "providers.search",
      providerId: params.provider.providerId,
      providerLabel: params.provider.providerLabel,
      providerSource: params.provider.providerSource,
      pluginId: params.provider.pluginId,
      previousProviderId: activeProviderBefore,
      intent: params.intent,
    };
    await params.hookRunner.runAfterProviderActivate(genericActivateEvent, ctx);
  }
}

async function promptPluginSearchProviderConfig(
  config: OpenClawConfig,
  entry: PluginSearchProviderEntry,
  prompter: WizardPrompter,
): Promise<{ config: OpenClawConfig; valid: boolean }> {
  let nextConfig = config;
  let nextPluginConfig = getPluginConfig(nextConfig, entry.pluginId);
  const fields = resolvePromptablePluginFields(entry, nextPluginConfig);
  if (fields.length === 0) {
    const validation = validatePluginSearchProviderConfig(entry, nextPluginConfig);
    if (!validation.ok) {
      await prompter.note(
        validation.fieldKey
          ? `${humanizeConfigKey(validation.fieldKey)}: ${validation.message}`
          : [
              "This provider needs configuration that this prompt cannot collect yet.",
              validation.message,
            ].join("\n"),
        "Invalid plugin config",
      );
      return { config, valid: false };
    }
    return { config, valid: true };
  }

  let fieldIndex = 0;
  while (fieldIndex < fields.length) {
    const field = resolvePromptablePluginFields(entry, nextPluginConfig)[fieldIndex];
    if (!field) {
      break;
    }

    if (field.kind === "enum") {
      const value = await prompter.select<string>({
        message: field.help ? `${field.label} (${field.help})` : field.label,
        options: field.options.map((option) => ({
          value: option,
          label: humanizeConfigKey(option),
        })),
        initialValue: field.existingValue ?? field.options[0],
      });
      nextPluginConfig[field.key] = value;
    } else if (field.kind === "boolean") {
      const value = await prompter.confirm({
        message: field.help ? `${field.label} (${field.help})` : field.label,
        initialValue: field.existingValue ?? false,
      });
      nextPluginConfig[field.key] = value;
    } else {
      const value = (
        await prompter.text({
          message: field.help ? `${field.label} (${field.help})` : field.label,
          initialValue: field.sensitive || !field.existingValue ? undefined : field.existingValue,
          placeholder:
            field.existingValue && field.sensitive
              ? "Leave blank to keep current"
              : field.placeholder,
        })
      )?.trim();

      if (value) {
        nextPluginConfig[field.key] = value;
      } else if (field.existingValue) {
        nextPluginConfig[field.key] = field.existingValue;
      } else {
        delete nextPluginConfig[field.key];
      }
    }

    fieldIndex += 1;

    if (fieldIndex >= fields.length) {
      const validation = validatePluginSearchProviderConfig(entry, nextPluginConfig);
      if (!validation.ok) {
        await prompter.note(
          validation.fieldKey
            ? `${humanizeConfigKey(validation.fieldKey)}: ${validation.message}`
            : validation.message,
          "Invalid plugin config",
        );
        if (validation.fieldKey) {
          const nextFieldIndex = fields.findIndex(
            (candidate) => candidate.key === validation.fieldKey,
          );
          fieldIndex = nextFieldIndex >= 0 ? nextFieldIndex : 0;
        } else {
          fieldIndex = 0;
        }
      }
    }
  }

  nextConfig = setPluginConfig(nextConfig, entry.pluginId, nextPluginConfig);
  return { config: nextConfig, valid: true };
}

export async function resolveSearchProviderPickerEntries(
  config: OpenClawConfig,
  workspaceDir?: string,
): Promise<SearchProviderPickerEntry[]> {
  const builtins: SearchProviderPickerEntry[] = SEARCH_PROVIDER_OPTIONS.map((entry) => ({
    ...entry,
    kind: "builtin",
    configured: hasExistingKey(config, entry.value) || hasKeyInEnv(entry),
  }));

  let pluginEntries: PluginSearchProviderEntry[] = [];
  try {
    const registry = loadOpenClawPlugins({
      config,
      cache: false,
      workspaceDir,
      suppressOpenAllowlistWarning: true,
    });
    const resolvedPluginEntries = registry.searchProviders
      .map((registration) => {
        const pluginRecord = registry.plugins.find((plugin) => plugin.id === registration.pluginId);
        if (!pluginRecord) {
          return undefined;
        }
        let configured = false;
        try {
          configured = Boolean(registration.provider.isAvailable?.(config));
        } catch {
          configured = false;
        }

        const sourceHint = formatPluginSourceHint(pluginRecord.origin);
        const baseHint =
          registration.provider.description?.trim() ||
          pluginRecord.description?.trim() ||
          "Plugin-provided web search";
        const hint = configured
          ? `${baseHint} · ${sourceHint} · configured`
          : `${baseHint} · ${sourceHint}`;

        return {
          kind: "plugin" as const,
          value: registration.provider.id,
          label: registration.provider.name || registration.provider.id,
          hint,
          configured,
          pluginId: registration.pluginId,
          origin: pluginRecord.origin,
          description: registration.provider.description,
          docsUrl: registration.provider.docsUrl,
          configFieldOrder: registration.provider.configFieldOrder,
          configJsonSchema: pluginRecord.configJsonSchema,
          configUiHints: pluginRecord.configUiHints,
        };
      })
      .filter(Boolean) as PluginSearchProviderEntry[];
    pluginEntries = resolvedPluginEntries.toSorted((left, right) =>
      left.label.localeCompare(right.label),
    );
  } catch {
    pluginEntries = [];
  }

  try {
    loadPluginManifestRegistry({
      config,
      workspaceDir,
      cache: false,
    });
    const loadedPluginProviderIds = new Set(pluginEntries.map((entry) => entry.value));
    const bundledManifestEntries = SEARCH_PROVIDER_PLUGIN_INSTALL_CATALOG.map((installEntry) =>
      buildPluginSearchProviderEntryFromManifest({
        config,
        installEntry,
        workspaceDir,
      }),
    )
      .filter(
        (entry): entry is PluginSearchProviderEntry =>
          Boolean(entry) && entry.origin === "bundled" && !loadedPluginProviderIds.has(entry.value),
      )
      .map((entry) => {
        const pluginConfig = getPluginConfig(config, entry.pluginId);
        const validation = validatePluginSearchProviderConfig(entry, pluginConfig);
        return {
          ...entry,
          configured: validation.ok,
        };
      });
    pluginEntries = [...pluginEntries, ...bundledManifestEntries].toSorted((left, right) =>
      left.label.localeCompare(right.label),
    );
  } catch {
    // Ignore manifest lookup failures and fall back to loaded entries only.
  }

  return [...builtins, ...pluginEntries];
}

export async function resolveSearchProviderPickerEntry(
  config: OpenClawConfig,
  providerId: string,
  workspaceDir?: string,
): Promise<SearchProviderPickerEntry | undefined> {
  const entries = await resolveSearchProviderPickerEntries(config, workspaceDir);
  return entries.find((entry) => entry.value === providerId);
}

function buildPluginSearchProviderEntryFromManifest(params: {
  config: OpenClawConfig;
  installEntry: InstallableSearchProviderPluginCatalogEntry;
  workspaceDir?: string;
}): PluginSearchProviderEntry | undefined {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cache: false,
  });
  const pluginRecord = registry.plugins.find((plugin) => plugin.id === params.installEntry.id);
  if (!pluginRecord) {
    return undefined;
  }

  return {
    kind: "plugin",
    value: params.installEntry.providerId,
    label: params.installEntry.meta.label,
    hint: [
      pluginRecord.description || "Plugin-provided web search",
      formatPluginSourceHint(pluginRecord.origin),
    ].join(" · "),
    configured: false,
    pluginId: pluginRecord.id,
    origin: pluginRecord.origin,
    description: pluginRecord.description,
    docsUrl: undefined,
    configFieldOrder: undefined,
    configJsonSchema: pluginRecord.configSchema,
    configUiHints: pluginRecord.configUiHints,
  };
}

async function promptSearchProviderPluginInstallChoice(
  installableEntries: InstallableSearchProviderPluginCatalogEntry[],
  prompter: WizardPrompter,
): Promise<InstallableSearchProviderPluginCatalogEntry | undefined> {
  if (installableEntries.length === 0) {
    return undefined;
  }
  if (installableEntries.length === 1) {
    return installableEntries[0];
  }
  const choice = await prompter.select<string>({
    message: "Choose provider plugin to install",
    options: [
      ...installableEntries.map((entry) => ({
        value: entry.providerId,
        label: entry.meta.label,
        hint: entry.description,
      })),
      {
        value: SEARCH_PROVIDER_SKIP_SENTINEL,
        label: "Skip for now",
        hint: "Keep the current search setup unchanged",
      },
    ],
    initialValue: installableEntries[0]?.providerId ?? SEARCH_PROVIDER_SKIP_SENTINEL,
  });
  if (choice === SEARCH_PROVIDER_SKIP_SENTINEL) {
    return undefined;
  }
  return installableEntries.find((entry) => entry.providerId === choice);
}

async function installSearchProviderPlugin(params: {
  config: OpenClawConfig;
  entry: InstallableSearchProviderPluginCatalogEntry;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  workspaceDir?: string;
}): Promise<OpenClawConfig> {
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.config,
    entry: params.entry,
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
  });
  if (!result.installed) {
    return params.config;
  }
  reloadOnboardingPluginRegistry({
    cfg: result.cfg,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
    suppressOpenAllowlistWarning: true,
  });
  return result.cfg;
}

async function resolveInstalledSearchProviderEntry(params: {
  config: OpenClawConfig;
  installEntry: InstallableSearchProviderPluginCatalogEntry;
  workspaceDir?: string;
}): Promise<PluginSearchProviderEntry | undefined> {
  const installedProvider = await resolveSearchProviderPickerEntry(
    params.config,
    params.installEntry.providerId,
    params.workspaceDir,
  );
  if (installedProvider?.kind === "plugin") {
    return installedProvider;
  }
  return buildPluginSearchProviderEntryFromManifest({
    config: params.config,
    installEntry: params.installEntry,
    workspaceDir: params.workspaceDir,
  });
}

export async function applySearchProviderChoice(params: {
  config: OpenClawConfig;
  choice: SearchProviderPickerChoice;
  intent?: SearchProviderFlowIntent;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  opts?: SetupSearchOptions;
}): Promise<OpenClawConfig> {
  const intent = params.intent ?? "switch-active";
  if (
    params.choice === SEARCH_PROVIDER_SKIP_SENTINEL ||
    params.choice === SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL
  ) {
    return params.config;
  }

  if (params.choice === SEARCH_PROVIDER_INSTALL_SENTINEL) {
    const providerEntries = await resolveSearchProviderPickerEntries(
      params.config,
      params.opts?.workspaceDir,
    );
    const installableEntries = resolveInstallableSearchProviderPlugins(providerEntries);
    const selectedInstallEntry = await promptSearchProviderPluginInstallChoice(
      installableEntries,
      params.prompter,
    );
    if (!selectedInstallEntry) {
      return params.config;
    }
    const installedConfig = await installSearchProviderPlugin({
      config: params.config,
      entry: selectedInstallEntry,
      runtime: params.runtime,
      prompter: params.prompter,
      workspaceDir: params.opts?.workspaceDir,
    });
    if (installedConfig === params.config) {
      return params.config;
    }
    const installedProvider = await resolveInstalledSearchProviderEntry({
      config: installedConfig,
      installEntry: selectedInstallEntry,
      workspaceDir: params.opts?.workspaceDir,
    });
    if (!installedProvider) {
      await params.prompter.note(
        [
          `Installed ${selectedInstallEntry.meta.label}, but OpenClaw could not load its web search provider yet.`,
          "Restart the gateway and try configure again.",
        ].join("\n"),
        "Plugin install",
      );
      return installedConfig;
    }
    const enabled = enablePluginInConfig(installedConfig, installedProvider.pluginId);
    const hookRunner = createSearchProviderHookRunner(enabled.config, params.opts?.workspaceDir);
    const providerDetails: SearchProviderHookDetails = {
      providerId: installedProvider.value,
      providerLabel: installedProvider.label,
      providerSource: "plugin",
      pluginId: installedProvider.pluginId,
      configured: installedProvider.configured,
    };
    let next =
      intent === "switch-active"
        ? setWebSearchProvider(enabled.config, installedProvider.value)
        : enabled.config;
    await maybeNoteBeforeSearchProviderConfigure({
      hookRunner,
      config: next,
      provider: providerDetails,
      intent,
      prompter: params.prompter,
      workspaceDir: params.opts?.workspaceDir,
    });
    const pluginConfigResult = await promptPluginSearchProviderConfig(
      next,
      installedProvider,
      params.prompter,
    );
    const result = pluginConfigResult.valid
      ? preserveSearchProviderIntent(
          installedConfig,
          pluginConfigResult.config,
          intent,
          installedProvider.value,
        )
      : preserveSearchProviderIntent(
          installedConfig,
          enabled.config,
          "configure-provider",
          installedProvider.value,
        );
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: installedConfig,
      resultConfig: result,
      provider: providerDetails,
      intent,
      workspaceDir: params.opts?.workspaceDir,
    });
    return result;
  }

  return configureSearchProviderSelection(
    params.config,
    params.choice,
    params.prompter,
    intent,
    params.opts,
  );
}

type SearchProviderPickerModelParams = {
  config: OpenClawConfig;
  providerEntries: SearchProviderPickerEntry[];
  includeSkipOption: boolean;
  skipHint?: string;
};

type SearchProviderPickerModel = {
  unloadedExistingPluginProvider?: string;
  installableEntries: InstallableSearchProviderPluginCatalogEntry[];
  options: Array<{ value: SearchProviderPickerChoice; label: string; hint?: string }>;
  initialValue: SearchProviderPickerChoice;
  configuredCount: number;
  activeProvider?: string;
};

function formatPickerEntryHint(params: {
  entry: SearchProviderPickerEntry;
  isActive: boolean;
  configuredCount: number;
}): string {
  const { entry, isActive, configuredCount } = params;
  const baseParts =
    entry.kind === "plugin"
      ? [
          entry.description?.trim() || "Plugin-provided web search",
          formatPluginSourceHint(entry.origin),
        ]
      : [entry.hint, "Built-in"];

  if (configuredCount > 1) {
    if (entry.configured) {
      baseParts.push(isActive ? "Active now" : "Configured");
    }
  }

  return baseParts.join(" · ");
}

export function buildSearchProviderPickerModel(
  params: SearchProviderPickerModelParams,
): SearchProviderPickerModel {
  const { config, providerEntries, includeSkipOption, skipHint } = params;
  const existingProvider = resolveCapabilitySlotSelection(config, "providers.search");
  const existingPluginProvider =
    typeof existingProvider === "string" &&
    existingProvider.trim() &&
    !isBuiltinWebSearchProviderId(existingProvider)
      ? existingProvider
      : undefined;
  const loadedExistingPluginProvider =
    existingPluginProvider &&
    providerEntries.some(
      (entry) => entry.kind === "plugin" && entry.value === existingPluginProvider,
    )
      ? existingPluginProvider
      : undefined;
  const unloadedExistingPluginProvider =
    existingPluginProvider && !loadedExistingPluginProvider ? existingPluginProvider : undefined;

  const activeLoadedProvider = providerEntries.find(
    (entry) => entry.value === existingProvider,
  )?.value;
  const configuredEntries = providerEntries.filter((entry) => entry.configured);
  const configuredCount = configuredEntries.length;

  const sortedEntries = [...providerEntries].toSorted((left, right) => {
    const leftActive = left.value === activeLoadedProvider;
    const rightActive = right.value === activeLoadedProvider;
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
    if (left.configured !== right.configured) {
      return left.configured ? -1 : 1;
    }
    return 0;
  });

  const defaultProvider =
    activeLoadedProvider ??
    (configuredCount === 1 ? configuredEntries[0]?.value : undefined) ??
    configuredEntries[0]?.value ??
    sortedEntries[0]?.value ??
    SEARCH_PROVIDER_OPTIONS[0].value;

  const installableEntries = resolveInstallableSearchProviderPlugins(providerEntries);
  const options: Array<{ value: SearchProviderPickerChoice; label: string; hint?: string }> = [
    ...(unloadedExistingPluginProvider
      ? [
          {
            value: SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL as const,
            label: `Keep current provider (${unloadedExistingPluginProvider})`,
            hint: "Leave the current plugin-managed web_search provider unchanged",
          },
        ]
      : []),
    ...sortedEntries.map((entry) => ({
      value: entry.value,
      label: entry.label,
      hint: formatPickerEntryHint({
        entry,
        isActive: entry.value === activeLoadedProvider,
        configuredCount,
      }),
    })),
    ...(installableEntries.length > 0
      ? [
          {
            value: SEARCH_PROVIDER_INSTALL_SENTINEL as const,
            label: "Install external provider plugin",
            hint: "Add an external web search plugin",
          },
        ]
      : []),
    ...(includeSkipOption
      ? [
          {
            value: SEARCH_PROVIDER_SKIP_SENTINEL as const,
            label: "Skip for now",
            hint: skipHint,
          },
        ]
      : []),
  ];

  return {
    unloadedExistingPluginProvider,
    installableEntries,
    options,
    initialValue: unloadedExistingPluginProvider
      ? SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL
      : defaultProvider,
    configuredCount,
    activeProvider: activeLoadedProvider,
  };
}

export async function configureSearchProviderSelection(
  config: OpenClawConfig,
  choice: string,
  prompter: WizardPrompter,
  intent: SearchProviderFlowIntent = "switch-active",
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  const providerEntries = await resolveSearchProviderPickerEntries(config, opts?.workspaceDir);
  const selectedEntry = providerEntries.find((entry) => entry.value === choice);
  if (selectedEntry?.kind === "plugin") {
    const enabled = enablePluginInConfig(config, selectedEntry.pluginId);
    const hookRunner = createSearchProviderHookRunner(enabled.config, opts?.workspaceDir);
    const providerDetails: SearchProviderHookDetails = {
      providerId: selectedEntry.value,
      providerLabel: selectedEntry.label,
      providerSource: "plugin",
      pluginId: selectedEntry.pluginId,
      configured: selectedEntry.configured,
    };
    let next =
      intent === "switch-active"
        ? setWebSearchProvider(enabled.config, selectedEntry.value)
        : enabled.config;
    if (selectedEntry.configured) {
      const result = preserveSearchProviderIntent(config, next, intent, selectedEntry.value);
      await runAfterSearchProviderHooks({
        hookRunner,
        originalConfig: config,
        resultConfig: result,
        provider: providerDetails,
        intent,
        workspaceDir: opts?.workspaceDir,
      });
      return result;
    }
    if (opts?.quickstartDefaults && selectedEntry.configured) {
      const result = preserveSearchProviderIntent(config, next, intent, selectedEntry.value);
      await runAfterSearchProviderHooks({
        hookRunner,
        originalConfig: config,
        resultConfig: result,
        provider: providerDetails,
        intent,
        workspaceDir: opts?.workspaceDir,
      });
      return result;
    }
    await maybeNoteBeforeSearchProviderConfigure({
      hookRunner,
      config: next,
      provider: providerDetails,
      intent,
      prompter,
      workspaceDir: opts?.workspaceDir,
    });
    const pluginConfigResult = await promptPluginSearchProviderConfig(
      next,
      selectedEntry,
      prompter,
    );
    const result = pluginConfigResult.valid
      ? preserveSearchProviderIntent(config, pluginConfigResult.config, intent, selectedEntry.value)
      : preserveSearchProviderIntent(
          config,
          enabled.config,
          "configure-provider",
          selectedEntry.value,
        );
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: config,
      resultConfig: result,
      provider: providerDetails,
      intent,
      workspaceDir: opts?.workspaceDir,
    });
    return result;
  }

  const builtinChoice = choice as SearchProvider;
  const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === builtinChoice);
  if (!entry) {
    return config;
  }
  const hookRunner = createSearchProviderHookRunner(config, opts?.workspaceDir);
  const providerDetails: SearchProviderHookDetails = {
    providerId: builtinChoice,
    providerLabel: entry.label,
    providerSource: "builtin",
    configured: hasExistingKey(config, builtinChoice) || hasKeyInEnv(entry),
  };
  const existingKey = resolveExistingKey(config, builtinChoice);
  const keyConfigured = hasExistingKey(config, builtinChoice);
  const envAvailable = hasKeyInEnv(entry);

  if (intent === "switch-active" && (keyConfigured || envAvailable)) {
    const result = existingKey
      ? applySearchKey(config, builtinChoice, existingKey)
      : applyProviderOnly(config, builtinChoice);
    const next = preserveSearchProviderIntent(config, result, intent, builtinChoice);
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: config,
      resultConfig: next,
      provider: providerDetails,
      intent,
      workspaceDir: opts?.workspaceDir,
    });
    return next;
  }

  if (opts?.quickstartDefaults && (keyConfigured || envAvailable)) {
    const result = existingKey
      ? applySearchKey(config, builtinChoice, existingKey)
      : applyProviderOnly(config, builtinChoice);
    const next = preserveSearchProviderIntent(config, result, intent, builtinChoice);
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: config,
      resultConfig: next,
      provider: providerDetails,
      intent,
      workspaceDir: opts?.workspaceDir,
    });
    return next;
  }

  await maybeNoteBeforeSearchProviderConfigure({
    hookRunner,
    config,
    provider: providerDetails,
    intent,
    prompter,
    workspaceDir: opts?.workspaceDir,
  });

  const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    if (keyConfigured) {
      return preserveDisabledState(config, applyProviderOnly(config, builtinChoice));
    }
    const ref = buildSearchEnvRef(builtinChoice);
    await prompter.note(
      [
        "Secret references enabled — OpenClaw will store a reference instead of the API key.",
        `Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
        ...(envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`]),
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Web search",
    );
    const result = preserveSearchProviderIntent(
      config,
      applySearchKey(config, builtinChoice, ref),
      intent,
      builtinChoice,
    );
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: config,
      resultConfig: result,
      provider: providerDetails,
      intent,
      workspaceDir: opts?.workspaceDir,
    });
    return result;
  }

  const keyInput = await prompter.text({
    message: keyConfigured
      ? `${entry.label} API key (leave blank to keep current)`
      : envAvailable
        ? `${entry.label} API key (leave blank to use env var)`
        : `${entry.label} API key`,
    placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
  });

  const key = keyInput?.trim() ?? "";
  if (key) {
    const secretInput = resolveSearchSecretInput(builtinChoice, key, opts?.secretInputMode);
    const result = preserveSearchProviderIntent(
      config,
      applySearchKey(config, builtinChoice, secretInput),
      intent,
      builtinChoice,
    );
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: config,
      resultConfig: result,
      provider: providerDetails,
      intent,
      workspaceDir: opts?.workspaceDir,
    });
    return result;
  }

  if (existingKey) {
    const result = preserveSearchProviderIntent(
      config,
      applySearchKey(config, builtinChoice, existingKey),
      intent,
      builtinChoice,
    );
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: config,
      resultConfig: result,
      provider: providerDetails,
      intent,
      workspaceDir: opts?.workspaceDir,
    });
    return result;
  }

  if (keyConfigured || envAvailable) {
    const result = preserveSearchProviderIntent(
      config,
      applyProviderOnly(config, builtinChoice),
      intent,
      builtinChoice,
    );
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: config,
      resultConfig: result,
      provider: providerDetails,
      intent,
      workspaceDir: opts?.workspaceDir,
    });
    return result;
  }

  await prompter.note(
    [
      "No API key stored — web_search won't work until a key is available.",
      `Get your key at: ${entry.signupUrl}`,
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const result = preserveSearchProviderIntent(
    config,
    applyCapabilitySlotSelection({
      config,
      slot: "providers.search",
      selectedId: builtinChoice,
    }),
    intent,
    builtinChoice,
  );
  await runAfterSearchProviderHooks({
    hookRunner,
    originalConfig: config,
    resultConfig: result,
    provider: providerDetails,
    intent,
    workspaceDir: opts?.workspaceDir,
  });
  return result;
}

function preserveSearchProviderIntent(
  original: OpenClawConfig,
  result: OpenClawConfig,
  intent: SearchProviderFlowIntent,
  selectedProvider: string,
): OpenClawConfig {
  if (intent !== "configure-provider") {
    return preserveDisabledState(original, result);
  }

  const currentProvider = resolveCapabilitySlotSelection(original, "providers.search");
  let next = result;
  if (currentProvider && currentProvider !== selectedProvider) {
    next = applyCapabilitySlotSelection({
      config: next,
      slot: "providers.search",
      selectedId: currentProvider,
    });
  }
  return preserveDisabledState(original, next);
}

export async function promptSearchProviderFlow(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  opts?: SetupSearchOptions;
  includeSkipOption: boolean;
  skipHint?: string;
}): Promise<OpenClawConfig> {
  const providerEntries = await resolveSearchProviderPickerEntries(
    params.config,
    params.opts?.workspaceDir,
  );
  const pickerModel = buildSearchProviderPickerModel({
    config: params.config,
    providerEntries,
    includeSkipOption: params.includeSkipOption,
    skipHint: params.skipHint,
  });
  const action = await promptProviderManagementIntent({
    prompter: params.prompter,
    message: "Web search setup",
    includeSkipOption: params.includeSkipOption,
    configuredCount: pickerModel.configuredCount,
    configureValue: SEARCH_PROVIDER_CONFIGURE_SENTINEL,
    switchValue: SEARCH_PROVIDER_SWITCH_ACTIVE_SENTINEL,
    skipValue: SEARCH_PROVIDER_SKIP_SENTINEL,
    configureLabel: "Configure or install a provider",
    configureHint:
      "Update keys, plugin settings, or install a provider without changing the active provider",
    switchLabel: "Switch active provider",
    switchHint: "Change which provider web_search uses right now",
    skipHint: "Configure later with openclaw configure --section web",
  });
  if (action === SEARCH_PROVIDER_SKIP_SENTINEL) {
    return params.config;
  }
  const intent: SearchProviderFlowIntent =
    action === SEARCH_PROVIDER_CONFIGURE_SENTINEL ? "configure-provider" : "switch-active";
  const choice = await params.prompter.select<SearchProviderPickerChoice>({
    message:
      intent === "switch-active"
        ? "Choose active web search provider"
        : "Choose provider to configure",
    options: buildProviderSelectionOptions({
      intent,
      options: pickerModel.options,
      activeValue: pickerModel.activeProvider,
      hiddenValues: intent === "configure-provider" ? [SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL] : [],
    }),
    initialValue:
      intent === "switch-active"
        ? pickerModel.initialValue
        : (pickerModel.options.find(
            (option) => option.value !== SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL,
          )?.value ?? pickerModel.initialValue),
  });

  return applySearchProviderChoice({
    config: params.config,
    choice,
    intent,
    runtime: params.runtime,
    prompter: params.prompter,
    opts: params.opts,
  });
}

export function hasKeyInEnv(entry: SearchProviderEntry): boolean {
  return entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
}

function rawKeyValue(config: OpenClawConfig, provider: SearchProvider): unknown {
  const search = config.tools?.web?.search;
  switch (provider) {
    case "brave":
      return search?.apiKey;
    case "gemini":
      return search?.gemini?.apiKey;
    case "grok":
      return search?.grok?.apiKey;
    case "kimi":
      return search?.kimi?.apiKey;
    case "perplexity":
      return search?.perplexity?.apiKey;
  }
}

/** Returns the plaintext key string, or undefined for SecretRefs/missing. */
export function resolveExistingKey(
  config: OpenClawConfig,
  provider: SearchProvider,
): string | undefined {
  return normalizeSecretInputString(rawKeyValue(config, provider));
}

/** Returns true if a key is configured (plaintext string or SecretRef). */
export function hasExistingKey(config: OpenClawConfig, provider: SearchProvider): boolean {
  return hasConfiguredSecretInput(rawKeyValue(config, provider));
}

/** Build an env-backed SecretRef for a search provider. */
function buildSearchEnvRef(provider: SearchProvider): SecretRef {
  const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === provider);
  const envVar = entry?.envKeys.find((k) => Boolean(process.env[k]?.trim())) ?? entry?.envKeys[0];
  if (!envVar) {
    throw new Error(
      `No env var mapping for search provider "${provider}" in secret-input-mode=ref.`,
    );
  }
  return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id: envVar };
}

/** Resolve a plaintext key into the appropriate SecretInput based on mode. */
function resolveSearchSecretInput(
  provider: SearchProvider,
  key: string,
  secretInputMode?: SecretInputMode,
): SecretInput {
  const useSecretRefMode = secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    return buildSearchEnvRef(provider);
  }
  return key;
}

export function applySearchKey(
  config: OpenClawConfig,
  provider: SearchProvider,
  key: SecretInput,
): OpenClawConfig {
  const search = { ...config.tools?.web?.search, provider, enabled: true };
  switch (provider) {
    case "brave":
      search.apiKey = key;
      break;
    case "gemini":
      search.gemini = { ...search.gemini, apiKey: key };
      break;
    case "grok":
      search.grok = { ...search.grok, apiKey: key };
      break;
    case "kimi":
      search.kimi = { ...search.kimi, apiKey: key };
      break;
    case "perplexity":
      search.perplexity = { ...search.perplexity, apiKey: key };
      break;
  }
  return {
    ...config,
    tools: {
      ...config.tools,
      web: { ...config.tools?.web, search },
    },
  };
}

function applyProviderOnly(config: OpenClawConfig, provider: SearchProvider): OpenClawConfig {
  const next = applyCapabilitySlotSelection({
    config,
    slot: "providers.search",
    selectedId: provider,
  });
  return {
    ...next,
    tools: {
      ...next.tools,
      web: {
        ...next.tools?.web,
        search: {
          ...next.tools?.web?.search,
          enabled: true,
        },
      },
    },
  };
}

function preserveDisabledState(original: OpenClawConfig, result: OpenClawConfig): OpenClawConfig {
  if (original.tools?.web?.search?.enabled !== false) {
    return result;
  }
  return {
    ...result,
    tools: {
      ...result.tools,
      web: { ...result.tools?.web, search: { ...result.tools?.web?.search, enabled: false } },
    },
  };
}

export type SetupSearchOptions = {
  quickstartDefaults?: boolean;
  secretInputMode?: SecretInputMode;
  workspaceDir?: string;
};

export async function setupSearch(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Web search lets your agent look things up online.",
      "Choose a provider and enter the required built-in or plugin settings.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  return promptSearchProviderFlow({
    config,
    runtime,
    prompter,
    opts,
    includeSkipOption: true,
    skipHint: "Configure later with openclaw configure --section web",
  });
}
