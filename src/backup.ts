// Configuration backup: exact BackupV1 shape, strict validation, and a
// single-transaction import. The backup is unencrypted and intentionally
// contains full provider connection data (including credentials) and gateway
// key hashes; it never contains the login password, sessions, or usage.

import type { Database } from "bun:sqlite";
import {
  getSettings,
  listConnections,
  listAliases,
  listGatewayKeys,
  type ConnectionData,
  type ModelAlias,
  type ProviderConnectionWithCooldown,
} from "./db.ts";
import { validateConnectionInput } from "./connection-input.ts";

export interface BackupGatewayKey {
  id: string;
  name: string;
  secretHash: string;
  secretPrefix: string;
  secretSuffix: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackupV1 {
  format: "fast-9router-backup";
  version: 1;
  createdAt: string;
  data: {
    settings: {
      gatewayEnforce: boolean;
      disabledModels: string[];
      rtkEnabled: boolean;
      cavemanEnabled: boolean;
      cavemanLevel: string;
      ponytailEnabled: boolean;
      ponytailLevel: string;
    };
    providerConnections: Array<{
      id: number;
      provider: string;
      name: string;
      isActive: boolean;
      priority: number;
      data: ConnectionData;
      createdAt: string;
      updatedAt: string;
    }>;
    modelAliases: ModelAlias[];
    gatewayApiKeys: BackupGatewayKey[];
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportBackup(db: Database): BackupV1 {
  const settings = getSettings(db);
  return {
    format: "fast-9router-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    data: {
      settings: {
        gatewayEnforce: settings.gatewayEnforce,
        disabledModels: settings.disabledModels,
        rtkEnabled: settings.rtkEnabled,
        cavemanEnabled: settings.cavemanEnabled,
        cavemanLevel: settings.cavemanLevel,
        ponytailEnabled: settings.ponytailEnabled,
        ponytailLevel: settings.ponytailLevel,
      },
      providerConnections: listConnections(db).map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        isActive: connection.isActive === 1,
        priority: connection.priority,
        data: connection.data,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      })),
      modelAliases: listAliases(db),
      gatewayApiKeys: listGatewayKeys(db).map((key) => ({
        id: key.id,
        name: key.name,
        secretHash: key.secretHash,
        secretPrefix: key.secretPrefix,
        secretSuffix: key.secretSuffix,
        isActive: key.isActive === 1,
        createdAt: key.createdAt,
        updatedAt: key.updatedAt,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_CONNECTIONS = 10_000;
const MAX_ALIASES = 10_000;
const MAX_GATEWAY_KEYS = 1_000;
const MAX_STRING_BYTES = 4 * 1024;
const MAX_TOKEN_BYTES = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const TOKEN_KEYS = new Set(["apiKey", "accessToken", "refreshToken", "idToken"]);

export type BackupValidation =
  | { ok: true; backup: BackupV1 }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, key: string, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  return new TextEncoder().encode(value).byteLength <= maxBytes ? value : null;
}

function exactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(obj);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

export function validateBackupPayload(db: Database, raw: unknown): BackupValidation {
  if (!isPlainObject(raw)) return { ok: false, error: "backup must be a JSON object" };
  if (raw.format !== "fast-9router-backup") return { ok: false, error: "unsupported backup format" };
  if (raw.version !== 1) return { ok: false, error: "unsupported backup version" };
  if (!exactKeys(raw, ["format", "version", "createdAt", "data"])) {
    return { ok: false, error: "backup has unknown or missing top-level fields" };
  }
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    return { ok: false, error: "backup createdAt must be an ISO timestamp" };
  }
  if (!isPlainObject(raw.data)) return { ok: false, error: "backup data must be an object" };
  const data = raw.data;

  // --- settings -------------------------------------------------------------
  if (!isPlainObject(data.settings) || !exactKeys(data.settings, ["gatewayEnforce", "disabledModels", "rtkEnabled", "cavemanEnabled", "cavemanLevel", "ponytailEnabled", "ponytailLevel"])) {
    return { ok: false, error: "backup settings must contain exactly the known fields" };
  }
  const settings = data.settings;
  for (const key of ["gatewayEnforce", "rtkEnabled", "cavemanEnabled", "ponytailEnabled"] as const) {
    if (typeof settings[key] !== "boolean") return { ok: false, error: `settings.${key} must be a boolean` };
  }
  for (const key of ["cavemanLevel", "ponytailLevel"] as const) {
    if (settings[key] !== "lite" && settings[key] !== "full" && settings[key] !== "ultra") {
      return { ok: false, error: `settings.${key} must be one of lite, full, ultra` };
    }
  }
  if (!Array.isArray(settings.disabledModels)
    || settings.disabledModels.some((model) => typeof model !== "string" || model.trim() === "" || model.length > 256)) {
    return { ok: false, error: "settings.disabledModels must be an array of non-empty strings" };
  }
  const settingsData: BackupV1["data"]["settings"] = {
    gatewayEnforce: settings.gatewayEnforce as boolean,
    disabledModels: settings.disabledModels as string[],
    rtkEnabled: settings.rtkEnabled as boolean,
    cavemanEnabled: settings.cavemanEnabled as boolean,
    cavemanLevel: settings.cavemanLevel as string,
    ponytailEnabled: settings.ponytailEnabled as boolean,
    ponytailLevel: settings.ponytailLevel as string,
  };

  // --- provider connections ---------------------------------------------------
  if (!Array.isArray(data.providerConnections)) return { ok: false, error: "providerConnections must be an array" };
  if (data.providerConnections.length > MAX_CONNECTIONS) return { ok: false, error: `backup exceeds ${MAX_CONNECTIONS} connections` };
  const connections: BackupV1["data"]["providerConnections"] = [];
  const connectionIds = new Set<number>();
  for (const row of data.providerConnections) {
    if (!isPlainObject(row)) return { ok: false, error: "each provider connection must be an object" };
    const id = row.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || connectionIds.has(id)) {
      return { ok: false, error: "provider connection IDs must be unique positive integers" };
    }
    connectionIds.add(id);
    const validated = validateConnectionInput(connections as unknown as ProviderConnectionWithCooldown[], row);
    if ("error" in validated) return { ok: false, error: `invalid provider connection: ${validated.error}` };
    connections.push({
      id,
      provider: validated.provider,
      name: boundedString(validated.name, "name", MAX_STRING_BYTES)!,
      isActive: validated.isActive,
      priority: validated.priority,
      data: validated.data,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
    });
  }

  // --- model aliases ------------------------------------------------------------
  if (!Array.isArray(data.modelAliases)) return { ok: false, error: "modelAliases must be an array" };
  if (data.modelAliases.length > MAX_ALIASES) return { ok: false, error: `backup exceeds ${MAX_ALIASES} aliases` };
  const aliases: ModelAlias[] = [];
  const aliasNames = new Set<string>();
  const configuredCanonicals = new Set(
    connections.map((connection) =>
      connection.provider === "codex"
        ? (connection.data.models ?? []).map((model) => `cx/${model}`)
        : connection.provider === "anthropic"
          ? (connection.data.models ?? []).map((model) => `anthropic/${model}`)
          : (connection.data.models ?? []).map((model) => `${connection.data.prefix ?? ""}/${model}`),
    ).flat(),
  );
  for (const row of data.modelAliases) {
    if (!isPlainObject(row) || !exactKeys(row, ["id", "name", "target", "createdAt"])) {
      return { ok: false, error: "each model alias must contain exactly id, name, target, createdAt" };
    }
    if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0) {
      return { ok: false, error: "alias IDs must be positive integers" };
    }
    const name = boundedString(row.name, "name", MAX_STRING_BYTES);
    const target = boundedString(row.target, "target", MAX_STRING_BYTES);
    if (name === null || name.trim() === "" || name.includes("/")) {
      return { ok: false, error: "alias names must be non-empty and must not contain '/'" };
    }
    if (aliasNames.has(name)) return { ok: false, error: `duplicate alias name: ${name}` };
    aliasNames.add(name);
    if (target === null || !configuredCanonicals.has(target)) {
      return { ok: false, error: `alias target must be a configured canonical model: ${String(row.target)}` };
    }
    aliases.push({ id: row.id, name, target, createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString() });
  }

  // --- gateway API keys -----------------------------------------------------------
  if (!Array.isArray(data.gatewayApiKeys)) return { ok: false, error: "gatewayApiKeys must be an array" };
  if (data.gatewayApiKeys.length > MAX_GATEWAY_KEYS) return { ok: false, error: `backup exceeds ${MAX_GATEWAY_KEYS} gateway keys` };
  const keys: BackupGatewayKey[] = [];
  const keyIds = new Set<string>();
  const keyNames = new Set<string>();
  const keyHashes = new Set<string>();
  let activeKeys = 0;
  for (const row of data.gatewayApiKeys) {
    if (!isPlainObject(row) || !exactKeys(row, ["id", "name", "secretHash", "secretPrefix", "secretSuffix", "isActive", "createdAt", "updatedAt"])) {
      return { ok: false, error: "each gateway key must contain exactly the known fields" };
    }
    if (typeof row.id !== "string" || !UUID_RE.test(row.id) || keyIds.has(row.id)) {
      return { ok: false, error: "gateway key IDs must be unique UUIDs" };
    }
    keyIds.add(row.id);
    const name = boundedString(row.name, "name", MAX_STRING_BYTES);
    if (name === null || name.trim() === "" || name.length > 80 || keyNames.has(name.toLowerCase())) {
      return { ok: false, error: "gateway key names must be unique, 1-80 characters" };
    }
    keyNames.add(name.toLowerCase());
    if (typeof row.secretHash !== "string" || !SHA256_HEX_RE.test(row.secretHash) || keyHashes.has(row.secretHash)) {
      return { ok: false, error: "gateway key hashes must be unique 64-character lowercase SHA-256 hex" };
    }
    keyHashes.add(row.secretHash);
    if (typeof row.secretPrefix !== "string" || row.secretPrefix.length < 1 || row.secretPrefix.length > 8) {
      return { ok: false, error: "gateway key display prefix must be 1-8 characters" };
    }
    if (typeof row.secretSuffix !== "string" || row.secretSuffix.length < 1 || row.secretSuffix.length > 4) {
      return { ok: false, error: "gateway key display suffix must be 1-4 characters" };
    }
    if (typeof row.isActive !== "boolean") return { ok: false, error: "gateway key isActive must be a boolean" };
    if (row.isActive) activeKeys++;
    keys.push({
      id: row.id,
      name,
      secretHash: row.secretHash,
      secretPrefix: row.secretPrefix,
      secretSuffix: row.secretSuffix,
      isActive: row.isActive,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
    });
  }
  if (settingsData.gatewayEnforce && activeKeys === 0) {
    return { ok: false, error: "gatewayEnforce cannot be enabled with zero active gateway keys" };
  }

  // --- credential token bound check ------------------------------------------------
  for (const connection of connections) {
    for (const [key, value] of Object.entries(connection.data)) {
      if (typeof value !== "string") continue;
      const max = TOKEN_KEYS.has(key) ? MAX_TOKEN_BYTES : MAX_STRING_BYTES;
      if (new TextEncoder().encode(value).byteLength > max) {
        return { ok: false, error: `connection data field '${key}' exceeds ${max} bytes` };
      }
    }
  }

  return {
    ok: true,
    backup: {
      format: "fast-9router-backup",
      version: 1,
      createdAt: raw.createdAt,
      data: {
        settings: {
          gatewayEnforce: settingsData.gatewayEnforce,
          disabledModels: settingsData.disabledModels,
          rtkEnabled: settingsData.rtkEnabled,
          cavemanEnabled: settingsData.cavemanEnabled,
          cavemanLevel: settingsData.cavemanLevel,
          ponytailEnabled: settingsData.ponytailEnabled,
          ponytailLevel: settingsData.ponytailLevel,
        },
        providerConnections: connections,
        modelAliases: aliases,
        gatewayApiKeys: keys,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Import (one transaction; validation already performed)
// ---------------------------------------------------------------------------

export interface BackupImportCounts {
  connections: number;
  aliases: number;
  gatewayKeys: number;
}

export function importBackup(db: Database, backup: BackupV1): BackupImportCounts {
  const { settings, providerConnections, modelAliases, gatewayApiKeys } = backup.data;
  db.transaction(() => {
    db.query("DELETE FROM providerConnections").run();
    const insertConnection = db.query(
      `INSERT INTO providerConnections (id, provider, name, isActive, priority, data, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const connection of providerConnections) {
      insertConnection.run(
        connection.id,
        connection.provider,
        connection.name,
        connection.isActive ? 1 : 0,
        connection.priority,
        JSON.stringify(connection.data),
        connection.createdAt,
        connection.updatedAt,
      );
    }

    db.query("DELETE FROM modelAliases").run();
    const insertAlias = db.query("INSERT INTO modelAliases (id, name, target, createdAt) VALUES (?, ?, ?, ?)");
    for (const alias of modelAliases) {
      insertAlias.run(alias.id, alias.name, alias.target, alias.createdAt);
    }

    db.query("DELETE FROM gatewayApiKeys").run();
    const insertKey = db.query(
      `INSERT INTO gatewayApiKeys (id, name, secretHash, secretPrefix, secretSuffix, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const key of gatewayApiKeys) {
      insertKey.run(
        key.id,
        key.name,
        key.secretHash,
        key.secretPrefix,
        key.secretSuffix,
        key.isActive ? 1 : 0,
        key.createdAt,
        key.updatedAt,
      );
    }

    db.query(
      `UPDATE settings SET gatewayEnforce = ?, disabledModels = ?, rtkEnabled = ?, cavemanEnabled = ?,
         cavemanLevel = ?, ponytailEnabled = ?, ponytailLevel = ? WHERE id = 1`,
    ).run(
      settings.gatewayEnforce ? 1 : 0,
      JSON.stringify(settings.disabledModels),
      settings.rtkEnabled ? 1 : 0,
      settings.cavemanEnabled ? 1 : 0,
      settings.cavemanLevel,
      settings.ponytailEnabled ? 1 : 0,
      settings.ponytailLevel,
    );
  })();
  return {
    connections: providerConnections.length,
    aliases: modelAliases.length,
    gatewayKeys: gatewayApiKeys.length,
  };
}

