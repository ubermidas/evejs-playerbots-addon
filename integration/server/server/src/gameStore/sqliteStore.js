"use strict";

/**
 * SQLITE PERSISTENCE BACKEND (proof-of-concept):
 *
 * A thin key/value-blob store used as the on-disk backend for selected
 * runtime tables, in place of one big data.json file per table.
 *
 * Each logical table maps to one SQL table with the shape:
 *     "<table>"(key TEXT PRIMARY KEY, json TEXT NOT NULL)
 * i.e. one row per top-level entity, with the entity record stored as a
 * JSON blob. This keeps the existing nested-object cache semantics in
 * server/src/gameStore/index.js completely intact — SQLite is only the
 * durable container — while giving us:
 *   - ACID writes (no more whole-file-rewrite corruption window), and
 *   - per-row upserts (a change to one character no longer rewrites the
 *     entire table file).
 *
 * The store is intentionally tiny and synchronous (better-sqlite3) so it
 * slots in behind the existing synchronous read/write/remove API without
 * forcing any consumer to become async.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const storeRoot = require("./storeRoot");
const persistenceLeasePolicy = require("./persistenceLeasePolicy");
const { APPLICATION_ID, SCHEMA_VERSION, TYPED_TABLES } = require("./shared-schema/version");
const { hasSubtreeDigests, subtreeDigests } = require("./shared-schema/subtreeDigests");
const { tryWriteCorporationCharge } = require("./shared-schema/walletChargeSql");

let Database = null;
let db = null;
let dbPath = null;
let dbReadOnly = false;
let sharedSchema = false;

// SQL identifiers are interpolated into DDL/DML, so hard-fail on anything
// that is not a plain table name. Every real table name is camelCase ascii.
const SAFE_TABLE_NAME = /^[A-Za-z0-9_]+$/;
const INTERNAL_TABLE_NAMES = new Set([
  "_migrations",
  "_persistence_outbox",
  "_persistence_owners",
]);

const LEGACY_PERSISTENCE_OWNER_ROLE = "__legacy__";
const STANDALONE_PERSISTENCE_OWNER_ROLE = "standalone";
const DEFAULT_PERSISTENCE_OWNER_LEASE_MS =
  persistenceLeasePolicy.DEFAULT_LEASE_MS;
const MIN_PERSISTENCE_OWNER_LEASE_MS = persistenceLeasePolicy.MIN_LEASE_MS;
const PERSISTENCE_OWNER_ROLE_PATTERN = /^[A-Za-z0-9_.:-]+$/;
let standalonePersistenceOwnerFence = null;

const ensuredTables = new Set();
const upsertStatements = new Map();
const deleteStatements = new Map();

function assertSafeTableName(table) {
  if (!SAFE_TABLE_NAME.test(String(table || ""))) {
    throw new Error(`unsafe sqlite table name: ${JSON.stringify(table)}`);
  }
  return table;
}

// ── Nested-row ("wrapper") tables ───────────────────────────────────
// Most tables are flat: each top-level key is an entity, stored one row per
// key. A few tables nest their entities one level under a named group (e.g.
// notifications.boxes[characterID], wormholeRuntimeState.pairsByID[pairID]).
// For those, storing the whole group as one row means a change to a single
// entity rewrites the entire group blob. Opt a table in here and its entities
// are stored one row per entity (key "group\u001fentityID"), so one change is
// one small row. Everything not listed is unchanged (flat).
const ROW_GROUPS = {
  items: [
    "__evejsInventoryGrantReceipts", "__evejsCareerCombatOutcomes", "__evejsIncursionCombatOutcomes",
    "__evejsIncursionLogisticsHealth", "__evejsIncursionFactoryWithdrawals",
  ],
  achievements: ["characters"],
  dailyGoals: ["byCharacter", "monthly", "rewardSettlements"],
  fwOpenReplay: ["organizationEnlistments", "membershipWarnings"],
  freelanceProjects: ["projects", "deliveries"],
  notifications: ["boxes"],
  miningRuntimeState: ["systems"],
  wormholeRuntimeState: ["pairsByID", "staticSlotsByKey", "polarizationByCharacter"],
  alliances: ["records", "affiliationChangesByCorporation"],
  corporations: ["records"],
  bookmarkFolders: ["records"],
  bookmarkGroups: ["records"],
  bookmarkKnownFolders: ["recordsByCharacterID"],
  bookmarks: ["records"],
  calendarEvents: ["events"],
  calendarResponses: ["responses"],
  characterEnergyState: ["characters"],
  characterNotes: ["characters"],
  contractSettlements: ["byContractID"],
  corporationBills: ["bills", "automaticPaySettingsByOwner"],
  corporationGoals: ["goalsByID", "records"],
  corporationFoundings: ["byCharacter"],
  allianceFoundings: ["byCorporation"],
  allianceDepartures: ["departuresByOperationID", "activeDepartureByCorporationID", "closuresByAllianceID", "pendingSovTransfersByAllianceID"],
  corporationLiquidations: ["pending"],
  corporationRuntime: [
    "corporations", "alliances", "wars", "warNegotiations",
    "mutualWarInvites", "mutualWarInviteBlocks", "peaceTreaties",
  ],
  dungeonRuntimeState: ["instancesByID"],
  homefrontReplay: ["operations", "receipts", "pending"],
  observatoryFlashpointReplay: ["receipts", "pending", "loot", "trades"],
  incursionReplay: ["operations", "receipts", "pending", "releases", "history", "closures", "terminalOutcomes"],
  incursionLifecycle: ["tales", "requests"],
  industryBlueprintState: ["records"],
  industryFacilityState: ["facilities"],
  industryJobs: ["jobs"],
  industryInstallSettlements: ["byCharacter"],
  industryRuntime: ["monitors"],
  jumpBridgeSettlements: ["byCharacter"],
  reprocessingFacilityState: ["facilities"],
  reprocessingSettlements: ["byCharacter"],
  insuranceContracts: ["contractsByShipID", "contractHistoryByID", "payoutLedgerByLossID", "pendingOperationsByID"],
  lpWallets: ["characterWallets", "corporationWallets", "operationReceipts"],
  evermarkPurchases: ["byCharacter"],
  lpStorePurchases: ["byCharacter"],
  miningLedger: ["characters", "observers", "careerOreQuantities", "events", "observerHeaders"],
  killRights: ["rights", "activations", "purchases"],
  contrabandPenalties: ["byOperationID"],
  customsInspectionCases: ["byCaseID"],
  killmails: ["records", "pending"],
  mail: ["messages", "mailboxes", "mailingLists"],
  mapTelemetry: ["visitsByCharacterID"],
  missionRuntimeState: ["charactersByID"],
  missionRewardSettlements: ["byOperationID"],
  researchRuntimeState: ["charactersByID"],
  moduleGroupingState: ["ships"],
  moonExtractions: ["resourcesByStructureID", "extractions"],
  newEdenStoreRuntime: ["accounts"],
  newEdenStorePurchaseSettlements: ["byOperationID"],
  npcEntities: ["entities", "incursionOutcomes", "nativeAbilityState", "incursionSupportHealth"],
  npcControlState: ["startupRuleOverrides", "characterFlags", "systemGateControls"],
  npcModules: ["modules"],
  npcCargo: ["cargo", "miningTransfers"],
  npcRuntimeControllers: ["controllers"],
  npcWrecks: ["wrecks"],
  npcWreckItems: ["items"],
  overviewSharedPresets: ["entries"],
  planetOrbitalState: ["orbitalsByID", "replacementsByPlanet"],
  planetaryCustomsSettlements: ["byCharacter"],
  planetRuntimeState: [
    "resourcesByPlanetID", "coloniesByKey", "launchesByID", "acceptedNetworkEditsByKey",
    "networkEditReceiptsByKey", "customsOperationReceipts",
  ],
  playerBounties: ["pools", "contributions", "hunterStats", "payoutsByID"],
  playerBots: ["_taskRecords"],
  rafflesRuntime: ["reservations"],
  repairOperations: ["operationsByID"],
  savedFittings: ["owners"],
  sharedSettings: ["entries"],
  shipCosmetics: ["characters", "ships"],
  shipDirt: ["ships"],
  shipKillCounters: ["ships"],
  solarSystemInterferenceState: ["systems"],
  sovereignty: ["alliances", "systems", "hubs", "skyhooks", "mercenaryDens", "resources"],
  structurePaintwork: ["catalogueByTypeID", "licensesByID", "structureAssignments"],
  structureProfiles: ["profilesByID"],
  structureTetherRestrictions: ["restrictions"],
  // Empty today; wrapper shapes confirmed from each owning service's defaults.
  bookmarkSubfolders: ["records", "recordsByCharacterID"],
  corporationVotes: ["corporations"],
  evermarkEntitlements: ["characters"],
  pendingNpcBounties: ["npcTypes", "__events"],
  dynamicResourceRuntime: ["systems", "funding", "settlements", "unlocks", "losses"],
  probeRuntimeState: ["charactersByID", "probesByID"],
  shipLogoFittings: ["ships"],
  shipSkinComponentRuntime: ["finite", "infinite", "activations", "reservations", "storeGrants"],
  shipSkinDraftRuntime: ["drafts", "designs", "requests"],
  shipSkinSequencingRuntime: ["jobs", "requests"],
  shipSkinThirdPartyRuntime: ["licenses", "grants", "mutations", "listings", "requests", "operations", "componentStock", "importedDesigns"],
  chatState: ["channels", "privateChannelByPair"],
  chatStaticContracts: ["observations"],
  chatBacklog: ["entriesByRoomName"],
  abyssalRecoveryTombstones: [
    "byCharacterID",
    "byShipID",
    "byHostLocationID",
  ],
};
const ROW_KEY_SEP = "\u001f";
const DUNGEON_INSTANCE_PREFIX = `instancesByID${ROW_KEY_SEP}`;
const ABYSSAL_INSTANCE_PREDICATE =
  `key >= '${DUNGEON_INSTANCE_PREFIX}' AND key < 'instancesByID ' ` +
  "AND json_extract(json, '$.siteFamily') = 'abyssal' " +
  "AND json_extract(json, '$.siteKind') = 'abyssal-pocket'";

function rowGroupsFor(table) {
  return ROW_GROUPS[table] || null;
}

// Owner-scoped career recovery reads committed evidence without hydrating
// unrelated players' rows. SQLite maintains these indexes with each checkpoint.
const CAREER_READS = {
  killmails: { group: "records", field: "finalCharacterID" },
  industryJobs: { group: "jobs", field: "installerID" },
  items: { group: "__evejsCareerCombatOutcomes", field: "characterID", pending: true },
};
function careerReadPredicate(definition) {
  const prefix = `${definition.group}${ROW_KEY_SEP}`;
  return `key >= '${prefix}' AND key < '${definition.group} '` +
    (definition.pending ? " AND json_type(json, '$.acknowledged') IS NOT 'true'" : "");
}
function careerOwnerExpression(definition) {
  return `CAST(json_extract(json, '$.${definition.field}') AS REAL)`;
}
function careerExceptionalOwnerPredicate(definition) {
  // Number() also accepts hex/binary/octal strings and JS whitespace that
  // SQLite's numeric cast treats as zero. Keep those uncommon identities in a
  // separate small index; the final JS equality remains authoritative.
  return `${careerReadPredicate(definition)} AND ${careerOwnerExpression(definition)} = 0` +
    ` AND json_type(json, '$.${definition.field}') IN ('text', 'array', 'object')`;
}
function createCareerReadIndex(table) {
  const definition = CAREER_READS[table];
  if (!definition || (sharedSchema && TYPED_TABLES.has(table))) return;
  requireWritableDb().exec(`CREATE INDEX IF NOT EXISTS career_${table}_owner_v1
    ON "${table}"(${careerOwnerExpression(definition)}) WHERE ${careerReadPredicate(definition)}`);
  requireWritableDb().exec(`CREATE INDEX IF NOT EXISTS career_${table}_exceptional_owner_v1
    ON "${table}"(key) WHERE ${careerExceptionalOwnerPredicate(definition)}`);
}
function ensureCareerReadIndex(table, ownerFence) {
  if (!CAREER_READS[table]) return;
  const requestedFence = resolveDirectMutationFence(ownerFence);
  requireWritableDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    existingTableConnection(table);
    createCareerReadIndex(table);
  }).immediate();
}

// Reshape legacy career groups once during writable preload. Leaving a nonempty
// blob until the next gameplay write would keep recovery on its full-group
// compatibility path indefinitely for otherwise idle evidence owners.
function ensureCareerRowStorage(table, ownerFence) {
  const groups = {
    items: ["__evejsCareerCombatOutcomes"],
    achievements: ["characters"],
    pendingNpcBounties: ["__events"],
    killmails: ["records"],
    industryJobs: ["jobs"],
  }[table];
  if (!groups) return;
  const requestedFence = resolveDirectMutationFence(ownerFence);
  requireWritableDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    const connection = existingTableConnection(table);
    for (const group of groups) {
      const row = connection.prepare(`SELECT json FROM "${table}" WHERE key = ?`).get(group);
      const legacy = row ? JSON.parse(row.json) : null;
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy) || !Object.keys(legacy).length) continue;
      const selected = loadExistingTablePath(table, [group]).value;
      const rows = explodeToRows(table, { [group]: selected });
      // Keep logical string-key order when old split overrides precede newly
      // split legacy siblings. Career duplicate-ID timestamps use the first
      // qualifying record, so retaining old rowids would change precedence.
      const prefix = `${group}${ROW_KEY_SEP}`;
      connection.prepare(`DELETE FROM "${table}" WHERE key >= ? AND key < ?`).run(prefix, `${group} `);
      applyChangeStatements(table, Object.entries(rows).map(([key, value]) => [key, JSON.stringify(value)]), []);
    }
  }).immediate();
}

/**
 * Flatten a nested table object into the `{ rowKey: value }` map actually
 * stored as SQLite rows. For a configured group it emits one row per entity
 * (`group\u001fentityID`) plus a skeleton `group` row, so a group that is
 * present but empty still round-trips. Flat tables pass through unchanged.
 */
function explodeToRows(table, object = {}) {
  const groups = rowGroupsFor(table);
  const rows = {};
  for (const key of Object.keys(object || {})) {
    const value = object[key];
    const isGroup =
      groups &&
      groups.includes(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value);
    if (isGroup) {
      rows[key] = {}; // skeleton: records that the group exists (even if empty)
      for (const entityKey of Object.keys(value)) {
        if (String(entityKey).includes(ROW_KEY_SEP)) {
          throw new Error(
            `entity key contains reserved separator: ${table}.${key}.${entityKey}`,
          );
        }
        rows[`${key}${ROW_KEY_SEP}${entityKey}`] = value[entityKey];
      }
    } else {
      rows[key] = value;
    }
  }
  return rows;
}

/**
 * Inverse of explodeToRows: rebuild the nested table object from the flat
 * `{ rowKey: value }` row map. Order-independent and lossless.
 */
function assembleFromRows(table, rows = {}) {
  const groups = new Set(rowGroupsFor(table) || []);
  const object = {};
  for (const rowKey of Object.keys(rows)) {
    const sepIndex = rowKey.indexOf(ROW_KEY_SEP);
    if (sepIndex >= 0) {
      const group = rowKey.slice(0, sepIndex);
      const entityKey = rowKey.slice(sepIndex + 1);
      if (!object[group] || typeof object[group] !== "object") {
        object[group] = {};
      }
      object[group][entityKey] = rows[rowKey];
    } else if (groups.has(rowKey)) {
      // Group container row. In the per-entity format this is an empty skeleton.
      // A not-yet-reconverted install may still hold the whole group blob here
      // (from before the split) — merge it in without clobbering per-entity rows,
      // so the first flush cleanly converts it.
      const blob =
        rows[rowKey] && typeof rows[rowKey] === "object" && !Array.isArray(rows[rowKey])
          ? rows[rowKey]
          : {};
      object[rowKey] = { ...blob, ...(object[rowKey] || {}) };
    } else {
      object[rowKey] = rows[rowKey];
    }
  }
  return object;
}

/**
 * Resolve the value of a SINGLE stored row directly from a nested table object,
 * without exploding the whole table. This is the per-row counterpart to
 * explodeToRows used by the gameStore dirty-row flush fast path, and it MUST
 * mirror explodeToRows exactly:
 *   - `groupentity`  -> object[group][entity]   (the entity record)
 *   - bare group key       -> {}                       (the empty skeleton row)
 *   - flat / scalar key    -> object[key]
 *   - any absent key       -> undefined                (signals a deleted row)
 * The equivalence to explodeToRows()[rowKey] is pinned by a guard test.
 */
function rowValueForKey(table, object, rowKey) {
  const source = object && typeof object === "object" ? object : {};
  const sepIndex = String(rowKey).indexOf(ROW_KEY_SEP);
  if (sepIndex >= 0) {
    const group = rowKey.slice(0, sepIndex);
    const entityKey = rowKey.slice(sepIndex + 1);
    const groupValue = source[group];
    if (
      groupValue &&
      typeof groupValue === "object" &&
      !Array.isArray(groupValue) &&
      Object.prototype.hasOwnProperty.call(groupValue, entityKey)
    ) {
      return groupValue[entityKey];
    }
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(source, rowKey)) {
    return undefined;
  }
  const value = source[rowKey];
  const groups = rowGroupsFor(table);
  const isGroup =
    groups &&
    groups.includes(rowKey) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value);
  return isGroup ? {} : value;
}

function persistenceOwnerError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizePersistenceOwnerRole(value, options = {}) {
  const role = String(value || "").trim();
  if (
    !role ||
    role.length > 128 ||
    !PERSISTENCE_OWNER_ROLE_PATTERN.test(role) ||
    (role === LEGACY_PERSISTENCE_OWNER_ROLE && options.allowLegacy !== true)
  ) {
    throw persistenceOwnerError(
      `invalid persistence owner role: ${JSON.stringify(value)}`,
      "PERSISTENCE_OWNER_ROLE_INVALID",
    );
  }
  return role;
}

function normalizePersistenceOwnerInstanceId(value) {
  const instanceId = String(value || "").trim();
  if (!instanceId || instanceId.length > 320) {
    throw persistenceOwnerError(
      "persistence owner instanceId must be a non-empty string no longer than 320 characters",
      "PERSISTENCE_OWNER_INSTANCE_INVALID",
    );
  }
  return instanceId;
}

function normalizePersistenceOwnerFence(value) {
  if (!value || typeof value !== "object") {
    throw persistenceOwnerError(
      "persistence operation requires an acquired owner fence",
      "PERSISTENCE_OWNER_FENCE_REQUIRED",
    );
  }
  const ownerRole = normalizePersistenceOwnerRole(
    value.ownerRole === undefined ? value.role : value.ownerRole,
  );
  const instanceId = normalizePersistenceOwnerInstanceId(
    value.instanceId === undefined ? value.ownerInstanceId : value.instanceId,
  );
  const epoch = Number(value.epoch === undefined ? value.ownerEpoch : value.epoch);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw persistenceOwnerError(
      "persistence owner epoch must be a positive safe integer",
      "PERSISTENCE_OWNER_EPOCH_INVALID",
    );
  }
  return { ownerRole, epoch, instanceId };
}

function copyPersistenceOwnerFence(value) {
  const fence = normalizePersistenceOwnerFence(value);
  const leaseExpiresAt = Number(value.leaseExpiresAt);
  return {
    ...fence,
    ...(Number.isSafeInteger(leaseExpiresAt) ? { leaseExpiresAt } : {}),
  };
}

function normalizePersistenceOwnerLeaseMs(value) {
  const leaseMs = value === undefined
    ? DEFAULT_PERSISTENCE_OWNER_LEASE_MS
    : Number(value);
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < MIN_PERSISTENCE_OWNER_LEASE_MS
  ) {
    throw persistenceOwnerError(
      `persistence owner leaseMs must be an integer of at least ${MIN_PERSISTENCE_OWNER_LEASE_MS}`,
      "PERSISTENCE_OWNER_LEASE_INVALID",
    );
  }
  return leaseMs;
}

function persistenceOutboxCreateSql(tableName = "_persistence_outbox") {
  assertSafeTableName(tableName);
  return `
    CREATE TABLE "${tableName}" (
      operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL UNIQUE,
      owner_role TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 0),
      owner_instance_id TEXT NOT NULL,
      upserts_json TEXT NOT NULL,
      deletes_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'applied')),
      created_at TEXT NOT NULL,
      applied_at TEXT,
      CHECK (
        (owner_role = '${LEGACY_PERSISTENCE_OWNER_ROLE}' AND owner_epoch = 0) OR
        (owner_role <> '${LEGACY_PERSISTENCE_OWNER_ROLE}' AND owner_epoch > 0)
      )
    )
  `;
}

function ensurePersistenceSchema() {
  const connection = requireWritableDb();
  // A persistence worker attaches while its peer may already be writing. A
  // current schema needs only WAL reads; requesting BEGIN IMMEDIATE here can
  // make that worker fail to open behind a long main-thread transaction.
  const columnsOf = (table) => new Set(connection.prepare(`PRAGMA table_info('${table}')`).all().map(column => column.name));
  const owners = columnsOf("_persistence_owners"), outbox = columnsOf("_persistence_outbox");
  if (["owner_role", "epoch", "instance_id", "active", "exclusive", "lease_expires_at", "acquired_at", "released_at"]
    .every(column => owners.has(column)) &&
    ["operation_id", "table_name", "owner_role", "owner_epoch", "owner_instance_id", "upserts_json", "deletes_json", "state", "created_at", "applied_at"]
      .every(column => outbox.has(column))) return;
  // Cluster peers can open the same database concurrently during startup.
  // When migration is needed, inspect again under the write lock so a waiter
  // cannot repeat a migration another peer has already committed.
  const ensure = connection.transaction(() => {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS _persistence_owners (
        owner_role TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL CHECK (epoch > 0),
        instance_id TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        exclusive INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0, 1)),
        lease_expires_at INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        released_at TEXT
      )
    `);
    const ownerColumns = new Set(
      connection
        .prepare("PRAGMA table_info('_persistence_owners')")
        .all()
        .map((column) => column.name),
    );
    if (!ownerColumns.has("exclusive")) {
      connection.exec(
        "ALTER TABLE _persistence_owners ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0, 1))",
      );
    }
    if (!ownerColumns.has("lease_expires_at")) {
      connection.exec(
        "ALTER TABLE _persistence_owners ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0",
      );
    }

    const existing = connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_persistence_outbox'",
      )
      .get();
    if (!existing) {
      connection.exec(persistenceOutboxCreateSql());
      return;
    }

    const columns = new Set(
      connection
        .prepare("PRAGMA table_info('_persistence_outbox')")
        .all()
        .map((column) => column.name),
    );
    const outboxOwnerColumns = [
      "owner_role",
      "owner_epoch",
      "owner_instance_id",
    ];
    if (outboxOwnerColumns.every((column) => columns.has(column))) {
      return;
    }
    if (outboxOwnerColumns.some((column) => columns.has(column))) {
      throw persistenceOwnerError(
        "persistence outbox has a partially migrated owner schema",
        "PERSISTENCE_OUTBOX_SCHEMA_INVALID",
      );
    }

    // The July 2026 journal had no owner columns. Preserve operation IDs and
    // global table uniqueness. Rows stay quarantined until their table's
    // explicit owner adopts them.
    connection.exec(
      'ALTER TABLE "_persistence_outbox" RENAME TO "_persistence_outbox_legacy_migration"',
    );
    connection.exec(persistenceOutboxCreateSql());
    connection
      .prepare(
        `INSERT INTO _persistence_outbox(
           operation_id, table_name, owner_role, owner_epoch, owner_instance_id,
           upserts_json, deletes_json, state, created_at, applied_at
         )
         SELECT operation_id, table_name, ?, 0, ?, upserts_json, deletes_json,
                state, created_at, applied_at
         FROM _persistence_outbox_legacy_migration
         ORDER BY operation_id ASC`,
      )
      .run(LEGACY_PERSISTENCE_OWNER_ROLE, "legacy-schema-migration");
    connection.exec('DROP TABLE "_persistence_outbox_legacy_migration"');
  });
  ensure.immediate();
}

// The owner fence is checked several times per table flush (enqueue, apply,
// acknowledge, direct mutations). Prepare its SELECT once per connection.
const persistenceOwnerStatements = new WeakMap();

function getPersistenceOwnerStatement(connection) {
  let statement = persistenceOwnerStatements.get(connection);
  if (!statement) {
    statement = connection.prepare(
      `SELECT owner_role, epoch, instance_id, active, lease_expires_at
       FROM _persistence_owners WHERE owner_role = ?`,
    );
    persistenceOwnerStatements.set(connection, statement);
  }
  return statement;
}

function assertActivePersistenceOwner(ownerFence) {
  const fence = normalizePersistenceOwnerFence(ownerFence);
  const stored = getPersistenceOwnerStatement(requireDb()).get(fence.ownerRole);
  if (
    !stored ||
    stored.active !== 1 ||
    stored.epoch !== fence.epoch ||
    stored.instance_id !== fence.instanceId ||
    stored.lease_expires_at <= Date.now()
  ) {
    throw persistenceOwnerError(
      `persistence owner ${fence.ownerRole} epoch ${fence.epoch} is stale or inactive`,
      "PERSISTENCE_OWNER_STALE",
      {
        ownerRole: fence.ownerRole,
        ownerEpoch: fence.epoch,
        leaseExpiresAt: stored ? stored.lease_expires_at : null,
      },
    );
  }
  return { ...fence, leaseExpiresAt: stored.lease_expires_at };
}

function assertPersistenceOwner(ownerFence) {
  return copyPersistenceOwnerFence(assertActivePersistenceOwner(ownerFence));
}

/**
 * Hold SQLite's immediate writer lock while revalidating an owner fence and
 * synchronously publishing already-staged sidecar files. A successor cannot
 * advance the durable epoch between the check and the final atomic rename.
 * Expiry is intentionally checked when the transaction begins; the lock then
 * prevents a takeover until the short publication callback completes.
 */
function withPersistenceOwnerPublicationSync(ownerFence, publish) {
  requireWritableDb();
  if (typeof publish !== "function") {
    throw new TypeError(
      "persistence owner publication requires a synchronous callback",
    );
  }
  const requestedFence = normalizePersistenceOwnerFence(ownerFence);
  const publication = requireDb().transaction(() => {
    const activeFence = assertActivePersistenceOwner(requestedFence);
    return publish(copyPersistenceOwnerFence(activeFence));
  });
  return publication.immediate();
}

function acquirePersistenceOwner(ownerRole, instanceId, options = {}) {
  requireWritableDb();
  const role = normalizePersistenceOwnerRole(ownerRole);
  const normalizedInstanceId = normalizePersistenceOwnerInstanceId(instanceId);
  const exclusive = options.exclusive === true || role === "maintenance";
  const forceTakeover =
    options.forceTakeover === true || options.forceExclusive === true;
  const leaseMs = normalizePersistenceOwnerLeaseMs(options.leaseMs);
  const nowMs = Date.now();
  const leaseExpiresAt = nowMs + leaseMs;
  const acquiredAt = new Date().toISOString();
  const acquire = requireDb().transaction(() => {
    const existing = requireDb()
      .prepare(
        `SELECT owner_role, epoch, instance_id, active, exclusive,
                lease_expires_at
         FROM _persistence_owners WHERE owner_role = ?`,
      )
      .get(role);
    const existingLeaseIsLive = Boolean(
      existing &&
      existing.active === 1 &&
      existing.lease_expires_at > nowMs,
    );
    const sameLiveInstance = Boolean(
      existingLeaseIsLive && existing.instance_id === normalizedInstanceId,
    );
    if (
      existingLeaseIsLive &&
      !sameLiveInstance &&
      !forceTakeover
    ) {
      throw persistenceOwnerError(
        `persistence owner ${role} is active in another instance`,
        "PERSISTENCE_OWNER_ACTIVE",
        {
          ownerRole: role,
          ownerEpoch: existing.epoch,
          ownerInstanceId: existing.instance_id,
          leaseExpiresAt: existing.lease_expires_at,
        },
      );
    }

    const conflictingOwners = exclusive
      ? requireDb()
        .prepare(
          `SELECT owner_role, epoch, instance_id, exclusive, lease_expires_at
           FROM _persistence_owners
           WHERE active = 1 AND lease_expires_at > ? AND owner_role <> ?
           ORDER BY owner_role ASC`,
        )
        .all(nowMs, role)
      : requireDb()
        .prepare(
          `SELECT owner_role, epoch, instance_id, exclusive, lease_expires_at
           FROM _persistence_owners
           WHERE active = 1 AND lease_expires_at > ?
             AND exclusive = 1 AND owner_role <> ?
           ORDER BY owner_role ASC`,
        )
        .all(nowMs, role);
    if (conflictingOwners.length > 0 && options.forceExclusive !== true) {
      throw persistenceOwnerError(
        `persistence owner ${role} conflicts with active ` +
          conflictingOwners.map((owner) => owner.owner_role).join(", "),
        "PERSISTENCE_OWNER_CONFLICT",
        { ownerRole: role, conflictingOwners },
      );
    }
    if (conflictingOwners.length > 0) {
      // Reserved for a proven-offline maintenance transition. Mark every
      // conflicting lease inactive in the same transaction so their epochs
      // fail closed if a stale process resumes.
      requireDb()
        .prepare(
          `UPDATE _persistence_owners
           SET active = 0, lease_expires_at = 0, released_at = ?
           WHERE active = 1 AND lease_expires_at > ? AND owner_role <> ?`,
        )
        .run(acquiredAt, nowMs, role);
    }
    const epoch = sameLiveInstance
      ? existing.epoch
      : existing
        ? existing.epoch + 1
        : 1;
    requireDb()
      .prepare(
        `INSERT INTO _persistence_owners(
           owner_role, epoch, instance_id, active, exclusive,
           lease_expires_at, acquired_at, released_at
         ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL)
         ON CONFLICT(owner_role) DO UPDATE SET
           epoch = excluded.epoch,
           instance_id = excluded.instance_id,
           active = 1,
           exclusive = excluded.exclusive,
           lease_expires_at = excluded.lease_expires_at,
           acquired_at = excluded.acquired_at,
           released_at = NULL`,
      )
      .run(
        role,
        epoch,
        normalizedInstanceId,
        exclusive ? 1 : 0,
        leaseExpiresAt,
        acquiredAt,
      );
    return {
      ownerRole: role,
      epoch,
      instanceId: normalizedInstanceId,
      leaseExpiresAt,
    };
  });
  return copyPersistenceOwnerFence(acquire.immediate());
}

function renewPersistenceOwner(ownerFence, options = {}) {
  const connection = requireWritableDb();
  const leaseMs = normalizePersistenceOwnerLeaseMs(options.leaseMs);
  const checkpointOnCommit = options.checkpointOnCommit === true;
  const renew = connection.transaction(() => {
    const fence = assertActivePersistenceOwner(ownerFence);
    const leaseExpiresAt = Date.now() + leaseMs;
    const result = connection
      .prepare(
        `UPDATE _persistence_owners
         SET lease_expires_at = ?
         WHERE owner_role = ? AND epoch = ? AND instance_id = ?
           AND active = 1 AND lease_expires_at > ?`,
      )
      .run(
        leaseExpiresAt,
        fence.ownerRole,
        fence.epoch,
        fence.instanceId,
        Date.now(),
      );
    if (result.changes !== 1) {
      throw persistenceOwnerError(
        `failed to renew persistence owner ${fence.ownerRole}`,
        "PERSISTENCE_OWNER_STALE",
        { ownerRole: fence.ownerRole, ownerEpoch: fence.epoch },
      );
    }
    if (checkpointOnCommit) {
      connection.pragma("wal_autocheckpoint = 1000");
    }
    return { ...fence, leaseExpiresAt };
  });
  try {
    return copyPersistenceOwnerFence(renew.immediate());
  } finally {
    if (checkpointOnCommit) {
      disableWalAutoCheckpoint();
    }
  }
}

function releasePersistenceOwner(ownerFence) {
  requireWritableDb();
  const release = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(ownerFence);
    const result = requireDb()
      .prepare(
        `UPDATE _persistence_owners
         SET active = 0, lease_expires_at = 0, released_at = ?
         WHERE owner_role = ? AND epoch = ? AND instance_id = ? AND active = 1`,
      )
      .run(
        new Date().toISOString(),
        fence.ownerRole,
        fence.epoch,
        fence.instanceId,
      );
    if (result.changes !== 1) {
      throw persistenceOwnerError(
        `failed to release persistence owner ${fence.ownerRole}`,
        "PERSISTENCE_OWNER_RELEASE_FAILED",
      );
    }
    return true;
  });
  return release.immediate();
}

function ensureStandalonePersistenceOwner() {
  if (standalonePersistenceOwnerFence) {
    return assertActivePersistenceOwner(standalonePersistenceOwnerFence);
  }
  const implicitLiveDbPath = path.join(
    storeRoot.resolveStoreRoot(),
    "gamestore.sqlite",
  );
  if (
    process.env.EVEJS_TEST_STORE_ISOLATED !== "1" &&
    dbPath &&
    path.resolve(dbPath) === path.resolve(implicitLiveDbPath)
  ) {
    throw persistenceOwnerError(
      "refusing implicit standalone persistence ownership of the live gameStore; configure an explicit owner role",
      "PERSISTENCE_OWNER_FENCE_REQUIRED",
    );
  }
  standalonePersistenceOwnerFence = acquirePersistenceOwner(
    STANDALONE_PERSISTENCE_OWNER_ROLE,
    `standalone:${process.pid}:${crypto.randomUUID()}`,
    { forceTakeover: true },
  );
  return copyPersistenceOwnerFence(standalonePersistenceOwnerFence);
}

function resolvePersistenceOwnerFence(ownerFence) {
  return ownerFence === undefined || ownerFence === null
    ? ensureStandalonePersistenceOwner()
    : normalizePersistenceOwnerFence(ownerFence);
}

function adoptLegacyPersistenceOperations(ownerFence, tableNames) {
  requireWritableDb();
  if (!Array.isArray(tableNames)) {
    throw new TypeError(
      "legacy persistence adoption requires an explicit table-name array",
    );
  }
  const normalizedTables = [...new Set(
    tableNames.map((table) => normalizePersistenceTable(table)),
  )];
  const adopt = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(ownerFence);
    if (normalizedTables.length === 0) {
      return [];
    }
    const placeholders = normalizedTables.map(() => "?").join(", ");
    const rows = requireDb()
      .prepare(
        persistenceOperationSelectSql(
          `WHERE owner_role = ? AND table_name IN (${placeholders}) ` +
            "ORDER BY operation_id ASC",
        ),
      )
      .all(LEGACY_PERSISTENCE_OWNER_ROLE, ...normalizedTables);
    if (rows.length === 0) {
      return [];
    }
    requireDb()
      .prepare(
        `UPDATE _persistence_outbox
         SET owner_role = ?, owner_epoch = ?, owner_instance_id = ?
         WHERE owner_role = ? AND table_name IN (${placeholders})`,
      )
      .run(
        fence.ownerRole,
        fence.epoch,
        fence.instanceId,
        LEGACY_PERSISTENCE_OWNER_ROLE,
        ...normalizedTables,
      );
    return rows.map((row) => parsePersistenceOperationRow({
      ...row,
      owner_role: fence.ownerRole,
      owner_epoch: fence.epoch,
      owner_instance_id: fence.instanceId,
    }));
  });
  return adopt.immediate();
}

/**
 * Open the backing SQLite database. Writable owners create/migrate the file
 * and use WAL. Passive readers use an existing file in SQLite's readonly plus
 * query_only modes and never execute schema or journal DDL.
 */
function init(targetPath, options = {}) {
  const normalizedPath = storeRoot.assertOutsideSourceStore(targetPath);
  const readOnly = options.readOnly === true;
  if (db && dbPath === normalizedPath && dbReadOnly === readOnly) {
    return db;
  }
  if (db) {
    close();
  }
  if (!Database) {
    Database = require("better-sqlite3");
  }
  if (!readOnly) {
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  }
  try {
    db = new Database(
      normalizedPath,
      readOnly ? { readonly: true, fileMustExist: true } : undefined,
    );
    dbPath = normalizedPath;
    dbReadOnly = readOnly;
    sharedSchema = db.pragma("application_id", { simple: true }) === APPLICATION_ID;
    if (sharedSchema && db.pragma("user_version", { simple: true }) !== SCHEMA_VERSION) {
      throw new Error("Unsupported shared game database schema version");
    }
    db.pragma("busy_timeout = 5000");
    if (readOnly) {
      db.pragma("query_only = ON");
      return db;
    }
    // Install the lock wait before the WAL-setting PRAGMA itself can contend
    // with another process opening this shared database during cluster startup.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    // The persistence worker (when enabled) opens a SECOND connection to this
    // same WAL database. WAL serializes writers; busy_timeout waits through a
    // momentary peer transaction instead of surfacing SQLITE_BUSY.
    db.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (table_name TEXT PRIMARY KEY, migrated_at TEXT NOT NULL)",
    );
    // Durable handoff journal for asynchronous persistence writes. Operation
    // identities stay global and table_name remains globally UNIQUE.
    ensurePersistenceSchema();
    if (sharedSchema) {
      require("./shared-schema/upgrades").applySharedSchemaUpgrades(db, Database);
    }
    return db;
  } catch (error) {
    close();
    throw error;
  }
}

function disableWalAutoCheckpoint() {
  requireWritableDb().pragma("wal_autocheckpoint = 0");
}

function isMigrated(table) {
  assertSafeTableName(table);
  return Boolean(
    requireDb().prepare("SELECT 1 FROM _migrations WHERE table_name = ?").get(table),
  );
}

function resolveDirectMutationFence(ownerFence) {
  // Legacy sqliteStore-only tests use disposable attested roots and predate
  // GameStore's controller fence. Production/offline callers must provide a
  // fence (or pass through the guarded implicit-standalone path, which refuses
  // the live store).
  if (
    (ownerFence === undefined || ownerFence === null) &&
    process.env.EVEJS_TEST_STORE_ISOLATED === "1"
  ) {
    return null;
  }
  return resolvePersistenceOwnerFence(ownerFence);
}

function assertDirectMutationOwner(requestedFence) {
  return requestedFence
    ? assertActivePersistenceOwner(requestedFence)
    : null;
}

function createSqlTable(table) {
  assertSafeTableName(table);
  const connection = requireWritableDb();
  if (sharedSchema && TYPED_TABLES.has(table)) {
    existingTableConnection(table);
    return;
  }
  connection.exec(
    `CREATE TABLE IF NOT EXISTS "${table}" (key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  );
  createCareerReadIndex(table);
  if (table === "dungeonRuntimeState") {
    // Career recovery must find durable Abyssal evidence without reading every
    // unrelated combat/mining dungeon. SQLite maintains this partial index in
    // the same transaction as row changes. Build it only on a writable owner,
    // never as a side effect of a passive/readPersisted request.
    createDungeonReadIndexes();
  }
}

function createDungeonReadIndexes() {
  if (sharedSchema && TYPED_TABLES.has("dungeonRuntimeState")) return;
  requireWritableDb().exec(
    `CREATE INDEX IF NOT EXISTS dungeon_runtime_abyssal_instances_v1
     ON "dungeonRuntimeState"(key) WHERE ${ABYSSAL_INSTANCE_PREDICATE}`,
  );
}

function ensureDungeonReadIndexes(ownerFence) {
  const requestedFence = resolveDirectMutationFence(ownerFence);
  const ensure = requireWritableDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    existingTableConnection("dungeonRuntimeState");
    createDungeonReadIndexes();
  });
  ensure.immediate();
}

function markMigrated(table, ownerFence) {
  assertSafeTableName(table);
  const requestedFence = resolveDirectMutationFence(ownerFence);
  const mark = requireWritableDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    createSqlTable(table);
    requireWritableDb()
      .prepare(
        `INSERT INTO _migrations(table_name, migrated_at) VALUES (?, ?)
         ON CONFLICT(table_name) DO NOTHING`,
      )
      .run(table, new Date().toISOString());
  });
  mark.immediate();
  ensuredTables.add(table);
}

function requireDb() {
  if (!db) {
    throw new Error("sqliteStore.init(dbPath) must be called before use");
  }
  return db;
}

function requireWritableDb() {
  const connection = requireDb();
  if (dbReadOnly) {
    throw persistenceOwnerError(
      "SQLite store is open read-only; persistence mutation is forbidden",
      "SQLITE_STORE_READ_ONLY",
      { dbPath },
    );
  }
  return connection;
}

function ensureSqlTable(table) {
  assertSafeTableName(table);
  if (ensuredTables.has(table)) {
    return;
  }
  createSqlTable(table);
  ensuredTables.add(table);
}

// A typed table is a view whose write trigger reads the row document in every one of
// its statements. Handed over as JSONB, the document is parsed once instead of once per
// statement, and what the view stores and reads back is unchanged. A change-aware
// table (dungeon instances) also gets digests of the row's parts, so its triggers
// skip the parts that did not change.
function getUpsertStatement(table) {
  if (!upsertStatements.has(table)) {
    upsertStatements.set(
      table,
      requireDb().prepare(
        sharedSchema && TYPED_TABLES.has(table)
          ? hasSubtreeDigests(table)
            ? `INSERT INTO "${table}"(key, json, subtree_digests) VALUES (?, jsonb(?), jsonb(?))`
            : `INSERT INTO "${table}"(key, json) VALUES (?, jsonb(?))`
          : `INSERT INTO "${table}"(key, json) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET json = excluded.json`,
      ),
    );
  }
  return upsertStatements.get(table);
}

function getDeleteStatement(table) {
  if (!deleteStatements.has(table)) {
    deleteStatements.set(
      table,
      requireDb().prepare(`DELETE FROM "${table}" WHERE key = ?`),
    );
  }
  return deleteStatements.get(table);
}

function normalizePersistenceOperationId(operationId) {
  if (!Number.isSafeInteger(operationId) || operationId <= 0) {
    throw new Error(
      `invalid persistence operation ID: ${JSON.stringify(operationId)}`,
    );
  }
  return operationId;
}

function normalizePersistenceTable(table, label = "persistence table") {
  if (typeof table !== "string") {
    throw new Error(`${label} must be a string`);
  }
  assertSafeTableName(table);
  if (INTERNAL_TABLE_NAMES.has(table.toLowerCase()) || /^sqlite_/i.test(table)) {
    throw new Error(`${label} may not name an internal SQLite table`);
  }
  return table;
}

function validatePersistenceUpserts(upserts, label = "persistence upserts") {
  if (!Array.isArray(upserts)) {
    throw new Error(`${label} must be an array`);
  }
  return upserts.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${label}[${index}] must be a [key, json] pair`);
    }
    const [key, json] = entry;
    if (typeof key !== "string") {
      throw new Error(`${label}[${index}][0] must be a string key`);
    }
    if (typeof json !== "string") {
      throw new Error(`${label}[${index}][1] must be a JSON string`);
    }
    try {
      JSON.parse(json);
    } catch (error) {
      throw new Error(
        `${label}[${index}][1] is not valid JSON: ${error.message}`,
      );
    }
    return [key, json];
  });
}

function validatePersistenceDeletes(deletes, label = "persistence deletes") {
  if (!Array.isArray(deletes)) {
    throw new Error(`${label} must be an array`);
  }
  return deletes.map((key, index) => {
    if (typeof key !== "string") {
      throw new Error(`${label}[${index}] must be a string key`);
    }
    return key;
  });
}

function parsePersistencePayload(raw, label, operationId) {
  if (typeof raw !== "string") {
    throw new Error(
      `persistence operation ${operationId} has a non-string ${label} payload`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `persistence operation ${operationId} has malformed ${label} JSON: ${error.message}`,
    );
  }
}

function parsePersistenceOperationRow(row) {
  if (!row) {
    return null;
  }
  const operationId = normalizePersistenceOperationId(row.operation_id);
  const table = normalizePersistenceTable(
    row.table_name,
    `persistence operation ${operationId} table`,
  );
  const ownerRole = normalizePersistenceOwnerRole(row.owner_role, {
    allowLegacy: true,
  });
  const ownerEpoch = Number(row.owner_epoch);
  const ownerInstanceId = normalizePersistenceOwnerInstanceId(
    row.owner_instance_id,
  );
  if (
    !Number.isSafeInteger(ownerEpoch) ||
    ownerEpoch < 0 ||
    (ownerRole === LEGACY_PERSISTENCE_OWNER_ROLE && ownerEpoch !== 0) ||
    (ownerRole !== LEGACY_PERSISTENCE_OWNER_ROLE && ownerEpoch <= 0)
  ) {
    throw new Error(
      `persistence operation ${operationId} has invalid owner epoch ${JSON.stringify(row.owner_epoch)}`,
    );
  }
  const upserts = validatePersistenceUpserts(
    parsePersistencePayload(row.upserts_json, "upserts", operationId),
    `persistence operation ${operationId} upserts`,
  );
  const deletes = validatePersistenceDeletes(
    parsePersistencePayload(row.deletes_json, "deletes", operationId),
    `persistence operation ${operationId} deletes`,
  );
  if (row.state !== "pending" && row.state !== "applied") {
    throw new Error(
      `persistence operation ${operationId} has invalid state: ${JSON.stringify(row.state)}`,
    );
  }
  if (typeof row.created_at !== "string" || row.created_at.length === 0) {
    throw new Error(`persistence operation ${operationId} has invalid created_at`);
  }
  if (row.state === "pending" && row.applied_at !== null) {
    throw new Error(
      `pending persistence operation ${operationId} unexpectedly has applied_at`,
    );
  }
  if (
    row.state === "applied" &&
    (typeof row.applied_at !== "string" || row.applied_at.length === 0)
  ) {
    throw new Error(
      `applied persistence operation ${operationId} is missing applied_at`,
    );
  }
  return {
    operationId,
    table,
    ownerRole,
    ownerEpoch,
    ownerInstanceId,
    upserts,
    deletes,
    state: row.state,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  };
}

function persistenceOperationSelectSql(whereClause = "") {
  return `SELECT operation_id, table_name, owner_role, owner_epoch,
                 owner_instance_id, upserts_json, deletes_json,
                 state, created_at, applied_at
          FROM _persistence_outbox ${whereClause}`;
}

function assertPersistenceOperationOwner(operation, ownerFence) {
  if (operation.ownerRole !== ownerFence.ownerRole) {
    throw persistenceOwnerError(
      `persistence operation ${operation.operationId} belongs to ${operation.ownerRole}, not ${ownerFence.ownerRole}`,
      "PERSISTENCE_OPERATION_OWNER_MISMATCH",
      {
        operationId: operation.operationId,
        ownerRole: operation.ownerRole,
        expectedOwnerRole: ownerFence.ownerRole,
      },
    );
  }
  return operation;
}

function getPersistenceOperation(operationId, ownerFence) {
  const normalizedId = normalizePersistenceOperationId(operationId);
  const fence = assertActivePersistenceOwner(
    resolvePersistenceOwnerFence(ownerFence),
  );
  const row = requireDb()
    .prepare(persistenceOperationSelectSql("WHERE operation_id = ?"))
    .get(normalizedId);
  const operation = parsePersistenceOperationRow(row);
  return operation ? assertPersistenceOperationOwner(operation, fence) : null;
}

function listPersistenceOperations(ownerFence) {
  const fence = assertActivePersistenceOwner(
    resolvePersistenceOwnerFence(ownerFence),
  );
  return requireDb()
    .prepare(
      persistenceOperationSelectSql(
        "WHERE owner_role = ? ORDER BY operation_id ASC",
      ),
    )
    .all(fence.ownerRole)
    .map(parsePersistenceOperationRow);
}

function listAllPersistenceOperations() {
  return requireDb()
    .prepare(persistenceOperationSelectSql("ORDER BY operation_id ASC"))
    .all()
    .map(parsePersistenceOperationRow);
}

/**
 * An exclusive maintenance owner may recover its own prior/adopted batches,
 * but it must never edit application rows while another logical owner's exact
 * batch remains journaled. That owner must recover the batch with its own
 * callback/baseline semantics first.
 */
function assertNoForeignPersistenceOperations(ownerFence) {
  requireWritableDb();
  const requestedFence = normalizePersistenceOwnerFence(ownerFence);
  const inspect = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const storedOwner = requireDb()
      .prepare(
        `SELECT exclusive FROM _persistence_owners
         WHERE owner_role = ? AND epoch = ? AND instance_id = ?`,
      )
      .get(fence.ownerRole, fence.epoch, fence.instanceId);
    if (
      fence.ownerRole !== "maintenance" ||
      !storedOwner ||
      storedOwner.exclusive !== 1
    ) {
      throw persistenceOwnerError(
        "foreign persistence operation inspection requires the active exclusive maintenance owner",
        "PERSISTENCE_MAINTENANCE_FENCE_REQUIRED",
        { ownerRole: fence.ownerRole, ownerEpoch: fence.epoch },
      );
    }
    const foreignOperations = requireDb()
      .prepare(
        `SELECT operation_id, table_name, owner_role, owner_epoch,
                owner_instance_id, state
         FROM _persistence_outbox
         WHERE owner_role <> ?
         ORDER BY operation_id ASC`,
      )
      .all(fence.ownerRole)
      .map((row) => ({
        operationId: Number(row.operation_id),
        table: row.table_name,
        ownerRole: row.owner_role,
        ownerEpoch: Number(row.owner_epoch),
        ownerInstanceId: row.owner_instance_id,
        state: row.state,
      }));
    if (foreignOperations.length > 0) {
      const diagnostic = foreignOperations
        .map((operation) =>
          `${operation.ownerRole}:${operation.table}#${operation.operationId}`)
        .join(", ");
      throw persistenceOwnerError(
        `exclusive maintenance is blocked by ${foreignOperations.length} ` +
          `foreign persistence operation${foreignOperations.length === 1 ? "" : "s"}: ` +
          diagnostic,
        "PERSISTENCE_FOREIGN_OPERATIONS_PENDING",
        {
          ownerRole: fence.ownerRole,
          ownerEpoch: fence.epoch,
          foreignOperations,
        },
      );
    }
    return true;
  });
  return inspect.immediate();
}

function assertExpectedPersistenceTable(operation, expectedTable) {
  const normalizedTable = normalizePersistenceTable(
    expectedTable,
    "expected persistence table",
  );
  if (operation.table !== normalizedTable) {
    throw new Error(
      `persistence operation ${operation.operationId} targets ${operation.table}, not ${normalizedTable}`,
    );
  }
  return normalizedTable;
}

function enqueuePersistenceOperation(
  table,
  upserts = [],
  deletes = [],
  ownerFence,
) {
  return enqueuePersistenceOperations([{ table, upserts, deletes }], ownerFence)[0];
}

function runWalletTimedTransaction(db, phase, enabled, operation) {
  if (!enabled) return db.transaction(operation).immediate();
  const start = performance.now();
  let entered;
  let finished;
  let outcome = "error";
  try {
    const result = db.transaction(() => {
      entered = performance.now();
      try { return operation(); }
      finally { finished = performance.now(); }
    }).immediate();
    outcome = "ok";
    return result;
  } finally {
    const end = performance.now();
    if (end - start >= 100) {
      require("../utils/logger").warn(`[WalletSqliteTiming] phase=${phase} outcome=${outcome}` +
        ` beginMs=${((entered ?? end) - start).toFixed(2)}` +
        ` bodyMs=${(entered === undefined ? 0 : finished - entered).toFixed(2)}` +
        ` finishMs=${(finished === undefined ? 0 : end - finished).toFixed(2)}`);
    }
  }
}

function enqueuePersistenceOperations(batches, ownerFence) {
  const db = requireWritableDb();
  const normalized = batches.map(({ table, upserts, deletes }) => ({
    table: normalizePersistenceTable(table),
    upserts: validatePersistenceUpserts(upserts),
    deletes: validatePersistenceDeletes(deletes),
  }));
  const createdAt = new Date().toISOString();
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);

  const operations = runWalletTimedTransaction(db, "enqueue", !db.inTransaction &&
    normalized.some(batch => batch.table === "walletAuthorityState"), () => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const insert = db.prepare(
      `INSERT INTO _persistence_outbox(
         table_name, owner_role, owner_epoch, owner_instance_id,
         upserts_json, deletes_json, state, created_at, applied_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    );
    return normalized.map(({ table, upserts, deletes }) => {
      // A stale owner cannot create even an empty table. The table and its
      // replayable operation are published in the same fenced transaction.
      createSqlTable(table);
      const result = insert.run(
        table,
        fence.ownerRole,
        fence.epoch,
        fence.instanceId,
        JSON.stringify(upserts),
        JSON.stringify(deletes),
        createdAt,
      );
      return {
        operationId: normalizePersistenceOperationId(result.lastInsertRowid),
        table,
        ownerRole: fence.ownerRole,
        ownerEpoch: fence.epoch,
        ownerInstanceId: fence.instanceId,
        upserts,
        deletes,
        state: "pending",
        createdAt,
        appliedAt: null,
      };
    });
  });
  for (const { table } of operations) {
    ensuredTables.add(table);
  }
  return operations;
}

// A row the schema refuses (a CHECK, a key the typed view does not
// recognize, a field of the wrong shape) can never be applied, however often
// its batch is retried. Disk, lock and I/O errors are not refusals.
function isRowRefusal(error) {
  return Boolean(error) && typeof error.code === "string" &&
    /^SQLITE_(CONSTRAINT|MISMATCH)/.test(error.code);
}

let rejectedRowsListener = null;

// The main thread logs every set-aside row once. The worker records rows but
// has no listener; the main thread reports them when it acknowledges the batch.
function onRejectedRows(listener) {
  rejectedRowsListener = typeof listener === "function" ? listener : null;
}

function rejectedRowsTableExists() {
  return Boolean(requireDb()
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_persistence_rejected_rows'")
    .get());
}

// Created on the first refusal, inside the write transaction that needs it.
function ensureRejectedRowsTable() {
  requireDb().exec(`
    CREATE TABLE IF NOT EXISTS _persistence_rejected_rows (
      rejection_id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id INTEGER NOT NULL,
      table_name TEXT NOT NULL,
      row_key TEXT NOT NULL,
      change_kind TEXT NOT NULL CHECK (change_kind IN ('upsert', 'delete')),
      row_json TEXT,
      error TEXT NOT NULL,
      rejected_at TEXT NOT NULL,
      reported INTEGER NOT NULL DEFAULT 0 CHECK (reported IN (0, 1)),
      UNIQUE (operation_id, table_name, row_key, change_kind)
    )
  `);
}

function reportRejectedRows(rows) {
  if (!rejectedRowsListener || rows.length === 0) return false;
  try {
    rejectedRowsListener(rows.map((row) => ({ ...row })));
  } catch (_error) {
    // Reporting must never undo the save that set the rows aside.
  }
  return true;
}

function recordRejectedRows(table, operationId, rejected) {
  ensureRejectedRowsTable();
  const rejectedAt = new Date().toISOString();
  const reported = reportRejectedRows(rejected.map((row) => ({ ...row, table, operationId })));
  const insert = requireDb().prepare(
    `INSERT OR IGNORE INTO _persistence_rejected_rows (
       operation_id, table_name, row_key, change_kind, row_json, error, rejected_at, reported
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rejected) {
    insert.run(operationId, table, row.key, row.kind, row.json, row.error, rejectedAt, reported ? 1 : 0);
  }
}

// Reports, once, the rows the worker set aside for this batch.
function reportUnreportedRejectedRows(operationId) {
  if (!rejectedRowsListener || !rejectedRowsTableExists()) return;
  const rows = requireDb().prepare(
    `SELECT table_name, row_key, change_kind, row_json, error FROM _persistence_rejected_rows
     WHERE operation_id = ? AND reported = 0 ORDER BY rejection_id`,
  ).all(operationId);
  if (rows.length === 0) return;
  reportRejectedRows(rows.map((row) => ({
    table: row.table_name, operationId, key: row.row_key, kind: row.change_kind, json: row.row_json, error: row.error,
  })));
  requireDb().prepare("UPDATE _persistence_rejected_rows SET reported = 1 WHERE operation_id = ? AND reported = 0")
    .run(operationId);
}

// Applies one batch inside the caller's transaction. With `setAside`, a batch
// the schema refuses is applied row by row instead: every row that applies is
// saved, and every refused row is recorded in _persistence_rejected_rows with
// its error, so one bad row cannot stop its table, other tables or the next
// start from saving. Without it, any failure fails the batch.
function applyChangeStatements(table, upserts, deletes, setAside = null) {
  const upsert = getUpsertStatement(table);
  const remove = getDeleteStatement(table);
  const digests = sharedSchema && TYPED_TABLES.has(table) && hasSubtreeDigests(table);
  const runUpsert = ([key, json]) => {
    if (sharedSchema && table === "walletAuthorityState" && tryWriteCorporationCharge(requireDb(), String(key), json)) return;
    if (digests) upsert.run(String(key), json, subtreeDigests(table, key, json));
    else upsert.run(String(key), json);
  };
  const runDelete = (key) => remove.run(String(key));
  if (!setAside) {
    for (const change of upserts) runUpsert(change);
    for (const key of deletes) runDelete(key);
    return upserts.length + deletes.length;
  }
  // Each nested better-sqlite3 transaction is a savepoint, so a refused
  // attempt rolls back only itself.
  const db = requireDb();
  try {
    db.transaction(() => {
      for (const change of upserts) runUpsert(change);
      for (const key of deletes) runDelete(key);
    })();
    return upserts.length + deletes.length;
  } catch (error) {
    if (!isRowRefusal(error)) throw error;
  }
  const rejected = [];
  const attempt = (run, key, kind, json) => {
    try {
      db.transaction(run)();
    } catch (error) {
      if (!isRowRefusal(error)) throw error;
      rejected.push({ key: String(key), kind, json, error: error.message || String(error) });
    }
  };
  for (const change of upserts) attempt(() => runUpsert(change), change[0], "upsert", change[1]);
  for (const key of deletes) attempt(() => runDelete(key), key, "delete", null);
  if (rejected.length) recordRejectedRows(table, setAside.operationId, rejected);
  return upserts.length + deletes.length - rejected.length;
}

function applyPersistenceOperation(operationId, expectedTable, ownerFence) {
  requireWritableDb();
  const normalizedId = normalizePersistenceOperationId(operationId);
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  const normalizedExpectedTable =
    expectedTable === undefined
      ? undefined
      : normalizePersistenceTable(
        expectedTable,
        "expected persistence table",
      );
  const txn = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const operation = getPersistenceOperation(normalizedId, fence);
    if (!operation) {
      // A stale worker may begin after synchronous reconciliation removed the
      // row. Treat the already-reconciled operation as a harmless no-op.
      return null;
    }
    if (normalizedExpectedTable !== undefined) {
      assertExpectedPersistenceTable(operation, normalizedExpectedTable);
    }
    applyChangeStatements(
      operation.table,
      operation.upserts,
      operation.deletes,
      { operationId: operation.operationId },
    );
    const appliedAt = operation.appliedAt || new Date().toISOString();
    const updated = requireDb()
      .prepare(
        `UPDATE _persistence_outbox
         SET state = 'applied', applied_at = ?
         WHERE operation_id = ? AND table_name = ?`,
      )
      .run(appliedAt, operation.operationId, operation.table);
    if (updated.changes !== 1) {
      throw new Error(
        `failed to mark persistence operation ${operation.operationId} applied`,
      );
    }
    return {
      ...operation,
      state: "applied",
      appliedAt,
    };
  });
  return txn.immediate();
}

function getPersistenceOperationForTable(table, ownerFence) {
  const fence = assertActivePersistenceOwner(ownerFence);
  const operation = parsePersistenceOperationRow(requireDb()
    .prepare(persistenceOperationSelectSql("WHERE table_name = ?"))
    .get(normalizePersistenceTable(table)));
  return operation ? assertPersistenceOperationOwner(operation, fence) : null;
}

function acknowledgeDeferredOperation(table, operationId, ownerFence) {
  const operation = getPersistenceOperationForTable(table, ownerFence);
  if (operation?.operationId !== operationId || operation.state !== "applied") return;
  const acknowledge = requireDb().transaction(() => {
    const current = getPersistenceOperationForTable(table, ownerFence);
    if (current?.operationId === operationId && current.state === "applied") {
      acknowledgePersistenceOperation(operationId, table, ownerFence);
    }
  });
  acknowledge.immediate();
}

function journalDeferredBatches(batches, ownerFence) {
  const db = requireWritableDb();
  // Keep applied rows as proof until the caller accepts the result. If the
  // worker dies between commit and reply, only the exact same batch may adopt
  // that proof. The next batch may retire the previous accepted proof itself.
  const journal = db.transaction(() => {
    const pending = [];
    const operations = new Map();
    for (const batch of batches) {
      if (batch.previousOperationId) {
        acknowledgeDeferredOperation(batch.table, batch.previousOperationId, ownerFence);
      }
      const existing = getPersistenceOperationForTable(batch.table, ownerFence);
      if (!existing) {
        pending.push(batch);
      } else if (existing.ownerEpoch === ownerFence.epoch &&
                 existing.ownerInstanceId === ownerFence.instanceId &&
                 JSON.stringify(existing.upserts) === JSON.stringify(batch.upserts) &&
                 JSON.stringify(existing.deletes) === JSON.stringify(batch.deletes)) {
        operations.set(batch.table, existing);
      } else {
        throw new Error(`unexpected persistence operation ${existing.operationId} for ${batch.table}`);
      }
    }
    if (pending.length) {
      for (const operation of enqueuePersistenceOperations(pending, ownerFence)) {
        operations.set(operation.table, operation);
      }
    }
    return batches.map(({ table }) => operations.get(table));
  });
  return journal.immediate();
}

function acknowledgePersistenceOperation(operationId, expectedTable, ownerFence) {
  requireWritableDb();
  const normalizedId = normalizePersistenceOperationId(operationId);
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  normalizePersistenceTable(expectedTable, "expected persistence table");
  const txn = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const operation = getPersistenceOperation(normalizedId, fence);
    if (!operation) {
      throw new Error(`persistence operation ${normalizedId} does not exist`);
    }
    assertExpectedPersistenceTable(operation, expectedTable);
    if (operation.state !== "applied") {
      throw new Error(
        `persistence operation ${normalizedId} cannot be acknowledged from state ${operation.state}`,
      );
    }
    const removed = requireDb()
      .prepare(
        `DELETE FROM _persistence_outbox
         WHERE operation_id = ? AND table_name = ? AND state = 'applied'`,
      )
      .run(operation.operationId, operation.table);
    if (removed.changes !== 1) {
      throw new Error(
        `failed to acknowledge persistence operation ${operation.operationId}`,
      );
    }
    reportUnreportedRejectedRows(operation.operationId);
    return operation;
  });
  return txn.immediate();
}

// A synchronous write has no worker handoff to recover. Commit the validated
// diff in one fenced transaction and leave any existing journal to its owner.
function commitSynchronousChanges(table, upserts, deletes, ownerFence) {
  const normalizedTable = normalizePersistenceTable(table);
  const normalizedUpserts = validatePersistenceUpserts(upserts);
  const normalizedDeletes = validatePersistenceDeletes(deletes);
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  const connection = requireWritableDb();
  const commit = connection.transaction(() => {
    assertActivePersistenceOwner(requestedFence);
    if (connection.prepare("SELECT 1 FROM _persistence_outbox WHERE table_name = ?").get(normalizedTable)) {
      throw new Error(`An in-flight persistence operation still owns ${normalizedTable}`);
    }
    createSqlTable(normalizedTable);
    applyChangeStatements(normalizedTable, normalizedUpserts, normalizedDeletes);
  });
  commit.immediate();
  ensuredTables.add(normalizedTable);
}

function reconcilePersistenceOperation(operationId, expectedTable, ownerFence) {
  requireWritableDb();
  const normalizedId = normalizePersistenceOperationId(operationId);
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  normalizePersistenceTable(expectedTable, "expected persistence table");
  return runWalletTimedTransaction(requireDb(), "reconcile", expectedTable === "walletAuthorityState", () => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const operation = getPersistenceOperation(normalizedId, fence);
    if (!operation) {
      return null;
    }
    assertExpectedPersistenceTable(operation, expectedTable);
    applyChangeStatements(
      operation.table,
      operation.upserts,
      operation.deletes,
      { operationId: operation.operationId },
    );
    const removed = requireDb()
      .prepare(
        "DELETE FROM _persistence_outbox WHERE operation_id = ? AND table_name = ?",
      )
      .run(operation.operationId, operation.table);
    if (removed.changes !== 1) {
      throw new Error(
        `failed to reconcile persistence operation ${operation.operationId}`,
      );
    }
    return {
      ...operation,
      state: "applied",
      appliedAt: operation.appliedAt || new Date().toISOString(),
    };
  });
}

function recoverPersistenceOperations(ownerFence) {
  requireWritableDb();
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  // Read, validate, and replay only this logical owner's journal in one
  // transaction. Applied rows deliberately remain durable until the owner has
  // accepted the recovery callback and acknowledges the exact ordered batch.
  const txn = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const operations = listPersistenceOperations(fence);
    const recovered = [];
    for (const operation of operations) {
      applyChangeStatements(
        operation.table,
        operation.upserts,
        operation.deletes,
        { operationId: operation.operationId },
      );
      const appliedAt = operation.appliedAt || new Date().toISOString();
      const updated = requireDb()
        .prepare(
          `UPDATE _persistence_outbox
           SET state = 'applied', applied_at = ?
           WHERE operation_id = ? AND table_name = ? AND owner_role = ?`,
        )
        .run(
          appliedAt,
          operation.operationId,
          operation.table,
          fence.ownerRole,
        );
      if (updated.changes !== 1) {
        throw new Error(
          `failed to recover persistence operation ${operation.operationId}`,
        );
      }
      recovered.push({
        ...operation,
        state: "applied",
        appliedAt,
      });
    }
    return recovered;
  });
  return txn.immediate();
}

function acknowledgeRecoveredPersistenceOperations(operationIds, ownerFence) {
  requireWritableDb();
  const ids = [...new Set(
    (Array.isArray(operationIds) ? operationIds : [operationIds])
      .map(normalizePersistenceOperationId),
  )];
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  const acknowledge = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const acknowledged = [];
    for (const operationId of ids) {
      const operation = getPersistenceOperation(operationId, fence);
      if (!operation) {
        throw persistenceOwnerError(
          `recovered persistence operation ${operationId} does not exist`,
          "PERSISTENCE_OPERATION_NOT_FOUND",
          { operationId },
        );
      }
      if (operation.state !== "applied") {
        throw new Error(
          `recovered persistence operation ${operationId} cannot be acknowledged from state ${operation.state}`,
        );
      }
      acknowledged.push(operation);
    }
    for (const operation of acknowledged) {
      const removed = requireDb()
        .prepare(
          `DELETE FROM _persistence_outbox
           WHERE operation_id = ? AND table_name = ? AND owner_role = ?
             AND state = 'applied'`,
        )
        .run(operation.operationId, operation.table, fence.ownerRole);
      if (removed.changes !== 1) {
        throw new Error(
          `failed to acknowledge recovered persistence operation ${operation.operationId}`,
        );
      }
    }
    return acknowledged;
  });
  return acknowledge.immediate();
}

// Raw `[{ key, json }]` rows as stored — index.js uses these to build both the
// in-memory cache (assembled) and its per-row flush baseline.
function loadRows(table) {
  ensureSqlTable(table);
  return requireDb().prepare(`SELECT key, json FROM "${table}"`).all();
}

// Passive readers must not manufacture an empty table or run migration DDL.
// Missing durable schema fails loudly: treating it as an empty baseline makes
// an under-covered read indistinguishable from a legitimately empty table.
function existingTableConnection(table) {
  const normalizedTable = normalizePersistenceTable(table);
  const connection = requireDb();
  const storageType = sharedSchema && TYPED_TABLES.has(normalizedTable) ? "view" : "table";
  const exists = connection
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?",
    )
    .get(storageType, normalizedTable);
  if (!exists) {
    const error = new Error(
      `SQLite table does not exist: ${normalizedTable}`,
    );
    error.code = "SQLITE_TABLE_NOT_FOUND";
    error.table = normalizedTable;
    error.dbPath = dbPath;
    throw error;
  }
  return connection;
}

function loadExistingRows(table) {
  const normalizedTable = normalizePersistenceTable(table);
  return existingTableConnection(normalizedTable)
    .prepare(`SELECT key, json FROM "${normalizedTable}"`)
    .all();
}

/**
 * Load an entire table into the nested object index.js caches in memory —
 * assembling wrapper tables back from their per-entity rows.
 */
function loadTableObject(table) {
  const parsed = {};
  for (const row of loadRows(table)) {
    parsed[row.key] = JSON.parse(row.json);
  }
  return assembleFromRows(table, parsed);
}

function loadExistingTableObject(table) {
  const parsed = {};
  for (const row of loadExistingRows(table)) {
    parsed[row.key] = JSON.parse(row.json);
  }
  return assembleFromRows(table, parsed);
}

// Whether SQLite serves this table through a typed view (rows read back by key).
function isSharedSchemaTable(table) {
  return sharedSchema && TYPED_TABLES.has(normalizePersistenceTable(table));
}

function selectPath(value, segments) {
  for (const segment of segments) {
    if (value === null || typeof value !== "object" || !(segment in value)) {
      return { exists: false, value: null };
    }
    value = value[segment];
  }
  return { exists: true, value };
}

// Match assembleFromRows while selecting only the durable row(s) that can own
// this path. An entity row overrides the legacy group blob even when it is null.
function loadExistingTablePath(table, segments = []) {
  const normalizedTable = normalizePersistenceTable(table);
  const connection = existingTableConnection(normalizedTable);
  if (segments.length === 0) return { exists: true, value: loadExistingTableObject(normalizedTable) };
  const [first, second] = segments;
  if (sharedSchema && normalizedTable === "characters" && segments.length === 2 &&
      second === "standingOperationReceipts") {
    const row = connection.prepare(`SELECT record.character_standing_receipts_kind AS kind,
      (SELECT json_group_object(receipt.member_key, json(receipt.json) ORDER BY receipt.member_order)
        FROM character_standing_receipts_legacy_rows AS receipt WHERE receipt.parent_id = record.row_id) AS receipts
      FROM character_records AS record WHERE record.legacy_key = ?`).get(first);
    if (row?.kind === 'object') return { exists: true, value: JSON.parse(row.receipts) };
  }
  const groups = rowGroupsFor(normalizedTable) || [];
  const readRow = (key) => connection.prepare(`SELECT json FROM "${normalizedTable}" WHERE key = ?`).get(key);
  if (groups.includes(first)) {
    if (segments.length === 1) {
      const rows = {};
      const prefix = `${first}${ROW_KEY_SEP}`;
      const order = sharedSchema && TYPED_TABLES.has(normalizedTable) ? "key" : "rowid";
      for (const row of connection.prepare(
        `SELECT key, json FROM "${normalizedTable}" WHERE key = ? OR (key >= ? AND key < ?) ORDER BY ${order}`,
      ).all(first, prefix, `${first} `)) rows[row.key] = JSON.parse(row.json);
      return selectPath(assembleFromRows(normalizedTable, rows), segments);
    }
    // Legacy conversion may commit between independent reads. Observe the
    // override and legacy container in one SQLite statement/snapshot.
    const entityKey = `${first}${ROW_KEY_SEP}${second}`;
    const rows = connection.prepare(`SELECT key, json FROM "${normalizedTable}" WHERE key IN (?, ?)`).all(entityKey, first);
    const row = rows.find((entry) => entry.key === entityKey);
    if (row) return selectPath(JSON.parse(row.json), segments.slice(2));
    const legacy = rows.find((entry) => entry.key === first);
    const value = legacy ? JSON.parse(legacy.json) : null;
    const group = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return selectPath(group, segments.slice(1));
  }
  const row = readRow(first);
  return row ? selectPath(JSON.parse(row.json), segments.slice(1)) : { exists: false, value: null };
}

function loadExistingAbyssalInstances(characterID = 0) {
  const connection = existingTableConnection("dungeonRuntimeState");
  return connection.transaction(() => loadAbyssalInstancesInSnapshot(connection, characterID)).deferred();
}

function loadExistingIncursionPending(table, instanceID) {
  const group = table === "npcEntities" ? "incursionOutcomes"
    : table === "items" ? "__evejsIncursionCombatOutcomes" : null;
  if (!group) throw new Error("unsupported incursion outcome table");
  const connection = existingTableConnection(table);
  const scope = instanceID ?? null;
  if (sharedSchema) {
    const prefix = table === "items" ? "inventory_incursion_combat" : "npc_incursion_combat";
    const pending = "receipt.format_version = 1 AND receipt.acknowledged IS NOT 1";
    const projection = `JOIN ${prefix}_receipts_legacy_rows AS projected USING (legacy_key)`;
    const rows = scope === null
      ? connection.prepare(`SELECT projected.json FROM ${prefix}_receipts AS receipt
          ${projection} WHERE ${pending} ORDER BY receipt.legacy_key`).all()
      : connection.prepare(`SELECT projected.json FROM ${prefix}_events AS event
          JOIN ${prefix}_receipts AS receipt ON receipt.row_id = event.parent_id
          ${projection} WHERE event.instance_id = ? AND ${pending} ORDER BY receipt.legacy_key`).all(scope);
    return rows.map(row => JSON.parse(row.json));
  }
  return connection.transaction(() => {
    const legacy = connection.prepare(`SELECT json FROM "${table}" WHERE key = ?`).get(group);
    // Merge legacy and split rows before filtering so an acknowledged split
    // row always supersedes its older, pending legacy copy.
    if (legacy && Object.keys(JSON.parse(legacy.json) || {}).length) {
      const rows = loadExistingTablePath(table, [group]).value || {};
      return Object.values(rows).filter(receipt => receipt?.version === 1 && receipt.acknowledged !== true &&
        (scope === null || receipt.event?.instanceID === scope));
    }
    return connection.prepare(`SELECT json FROM "${table}"
      WHERE key >= ? AND key < ? AND json_extract(json, '$.version') = 1
        AND json_type(json, '$.version') IN ('integer', 'real')
        AND json_type(json, '$.acknowledged') IS NOT 'true'
        AND (? IS NULL OR (json_type(json, '$.event.instanceID') IN ('integer', 'real')
          AND json_extract(json, '$.event.instanceID') = ?))`)
      .all(`${group}${ROW_KEY_SEP}`, `${group} `, scope, scope).map(row => JSON.parse(row.json));
  }).deferred();
}

function loadExistingCareerRows(table, characterID) {
  const definition = CAREER_READS[table];
  if (!definition) throw new Error("unsupported career evidence table");
  const connection = existingTableConnection(table);
  const id = Number(characterID);
  if (!Number.isSafeInteger(id) || id <= 0) return {};
  if (sharedSchema && table === "items") {
    const rows = connection.prepare(`SELECT receipt.legacy_key, projected.json
      FROM inventory_career_combat_receipts AS receipt
      JOIN inventory_career_combat_receipts_legacy_rows AS projected USING (legacy_key)
      WHERE receipt.character_id = ? AND receipt.acknowledged IS NOT 1 ORDER BY receipt.row_id`).all(id);
    return Object.fromEntries(rows.map(row => [
      row.legacy_key.slice(definition.group.length + 1), JSON.parse(row.json),
    ]));
  }
  if (sharedSchema && table === "industryJobs") {
    const rows = connection.prepare(`SELECT job.job_key, projected.json
      FROM industry_jobs AS job JOIN industry_jobs_legacy_rows AS projected USING (legacy_key)
      WHERE job.installer_id = ? ORDER BY job.row_id`).all(id);
    return Object.fromEntries(rows.map(row => [String(row.job_key), JSON.parse(row.json)]));
  }
  if (sharedSchema && table === "killmails") {
    const rows = connection.prepare(`WITH matches AS MATERIALIZED (
      SELECT row_id, legacy_key FROM killmail_records WHERE final_character_id = ?
      UNION ALL
      SELECT row_id, legacy_key FROM killmail_records
        WHERE typeof(final_character_value) = 'text' AND final_character_id IS NOT ?
    )
    SELECT matches.legacy_key, projected.json
      FROM matches JOIN killmail_records_legacy_rows AS projected USING (legacy_key)
      ORDER BY matches.row_id`).all(id, id);
    const records = rows.map(row => [
      row.legacy_key.slice(definition.group.length + 1), JSON.parse(row.json),
    ]).filter(([, record]) => Number(record.finalCharacterID) === id);
    return Object.fromEntries(records);
  }
  return connection.transaction(() => {
    const groupRow = connection.prepare(`SELECT json FROM "${table}" WHERE key = ?`).get(definition.group);
    const legacy = groupRow ? JSON.parse(groupRow.json) : null;
    let candidates;
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy) && Object.keys(legacy).length) {
      // Compatibility until the writable owner converts its legacy group.
      candidates = loadExistingTablePath(table, [definition.group]).value || {};
    } else {
      candidates = {};
      const exceptionalIndex = `career_${table}_exceptional_owner_v1`;
      const hasExceptionalIndex = connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(exceptionalIndex);
      // Do not let a large population of ordinary numeric zero owners turn
      // the compatibility branch into an index scan of unrelated NPC kills.
      // Passive old schemas still work until their writable owner upgrades.
      const exceptionalHint = hasExceptionalIndex ? `INDEXED BY "${exceptionalIndex}"` : "";
      for (const row of connection.prepare(`SELECT key, json, rowid FROM "${table}"
        WHERE ${careerReadPredicate(definition)} AND ${careerOwnerExpression(definition)} = ?
        UNION ALL SELECT key, json, rowid FROM "${table}" ${exceptionalHint} WHERE ${careerExceptionalOwnerPredicate(definition)}
        ORDER BY rowid`).all(id)) {
        candidates[row.key.slice(definition.group.length + 1)] = JSON.parse(row.json);
      }
    }
    return Object.fromEntries(Object.entries(candidates).filter(([, value]) =>
      Number(value?.[definition.field]) === id && (!definition.pending || value?.acknowledged !== true)));
  }).deferred();
}

function loadAbyssalInstancesInSnapshot(connection, characterID) {
  const id = Number(characterID);
  if (sharedSchema && TYPED_TABLES.has("dungeonRuntimeState")) {
    const pilot = Number.isSafeInteger(id) && id > 0 ? id : null;
    const rows = connection.prepare(`
      SELECT instance.instance_id, projected.json
      FROM dungeon_instances AS instance JOIN dungeon_instances_legacy_rows AS projected USING (legacy_key)
      WHERE instance.site_family = 'abyssal' AND instance.site_kind = 'abyssal-pocket'
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM dungeon_environment_state AS environment
          JOIN dungeon_abyssal_state AS runtime ON runtime.parent_id = environment.row_id
          JOIN dungeon_abyssal_pockets AS pocket ON pocket.parent_id = runtime.row_id
          JOIN dungeon_abyssal_participants AS participant ON participant.parent_id = pocket.row_id
          WHERE environment.parent_id = instance.row_id AND participant.character_id = ?
        ))
      ORDER BY instance.legacy_key
    `).all(pilot, pilot);
    return Object.fromEntries(rows.map(row => [row.instance_id, JSON.parse(row.json)]));
  }

  const groupRow = connection.prepare('SELECT json FROM "dungeonRuntimeState" WHERE key = ?').get("instancesByID");
  const legacy = groupRow ? JSON.parse(groupRow.json) : null;
  let instances;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy) && Object.keys(legacy).length) {
    // Exceptional pre-split storage: merge overrides before filtering, otherwise
    // an ordinary split row could resurrect an obsolete Abyssal legacy record.
    instances = loadExistingTableObject("dungeonRuntimeState").instancesByID || {};
  } else {
    instances = {};
    for (const row of connection.prepare(
      `SELECT key, json FROM "dungeonRuntimeState" WHERE ${ABYSSAL_INSTANCE_PREDICATE}`,
    ).all()) instances[row.key.slice(DUNGEON_INSTANCE_PREFIX.length)] = JSON.parse(row.json);
  }
  const selected = {};
  for (const [key, instance] of Object.entries(instances)) {
    if (instance?.siteFamily !== "abyssal" || instance?.siteKind !== "abyssal-pocket") continue;
    if (Number.isSafeInteger(id) && id > 0) {
      const roster = instance?.environmentState?.abyssalRuntimeState?.pocketState?.participantRoster;
      if (!Array.isArray(roster) || !roster.some((member) => Number(member?.characterID) === id)) continue;
    }
    selected[key] = instance;
  }
  return selected;
}

/**
 * Apply a batch of row changes in a single transaction.
 * @param {Array<[string, string]>} upserts  [key, jsonString] pairs to write.
 * @param {Array<string>} deletes            keys to remove.
 * @returns {number} number of rows touched.
 */
function applyChanges(table, upserts = [], deletes = [], ownerFence) {
  if (upserts.length === 0 && deletes.length === 0) {
    return 0;
  }
  const normalizedTable = normalizePersistenceTable(table);
  const requestedFence = resolveDirectMutationFence(ownerFence);
  const txn = requireWritableDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    createSqlTable(normalizedTable);
    return applyChangeStatements(normalizedTable, upserts, deletes);
  });
  const changed = txn.immediate();
  ensuredTables.add(normalizedTable);
  return changed;
}

/**
 * Replace the full contents of a table from a plain object (used by the
 * one-shot JSON → SQLite importer).
 */
function replaceAll(table, object = {}, ownerFence) {
  requireWritableDb();
  const normalizedTable = normalizePersistenceTable(table);
  const requestedFence = resolveDirectMutationFence(ownerFence);
  const rows = explodeToRows(normalizedTable, object);
  const rowKeys = Object.keys(rows);
  const txn = requireDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    createSqlTable(normalizedTable);
    const upsert = getUpsertStatement(normalizedTable);
    requireDb().exec(`DELETE FROM "${normalizedTable}"`);
    for (const rowKey of rowKeys) {
      upsert.run(String(rowKey), JSON.stringify(rows[rowKey]));
    }
  });
  txn.immediate();
  ensuredTables.add(normalizedTable);
  return rowKeys.length;
}

function rowCount(table) {
  ensureSqlTable(table);
  return requireDb().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
}

function getDatabasePath() {
  return dbPath;
}

// Pages that deletes and rewrites free stay inside the file until VACUUM, so
// the file never shrinks by itself.
function readPageUsage() {
  const database = requireDb();
  return {
    pageSize: database.pragma("page_size", { simple: true }),
    pageCount: database.pragma("page_count", { simple: true }),
    freePages: database.pragma("freelist_count", { simple: true }),
  };
}

// Below this much free space a mostly-empty file is not worth a message; a
// fresh or small store is often more than half free pages.
const FREE_SPACE_WARNING_MIN_BYTES = 64 * 1024 * 1024;

// The startup message when more than half the file is free pages, else null.
// Compacting is an offline job (tools/Maintenance/vacuum-gamestore.js); the
// server never does it at startup.
function freeSpaceWarning(usage) {
  const pageCount = Number(usage && usage.pageCount) || 0;
  const freePages = Number(usage && usage.freePages) || 0;
  const pageSize = Number(usage && usage.pageSize) || 0;
  const freeBytes = freePages * pageSize;
  if (freePages * 2 <= pageCount || freeBytes < FREE_SPACE_WARNING_MIN_BYTES) {
    return null;
  }
  const megabytes = (bytes) => Math.round(bytes / (1024 * 1024));
  return `gamestore.sqlite is ${Math.round((freePages / pageCount) * 100)}% free pages ` +
    `(${megabytes(freeBytes)} MB of ${megabytes(pageCount * pageSize)} MB). ` +
    'Stop the server and run "node tools/Maintenance/vacuum-gamestore.js" to compact it.';
}

function isReadOnly() {
  return Boolean(db && dbReadOnly);
}

function close() {
  if (db) {
    db.close();
  }
  db = null;
  dbPath = null;
  dbReadOnly = false;
  sharedSchema = false;
  ensuredTables.clear();
  upsertStatements.clear();
  deleteStatements.clear();
  standalonePersistenceOwnerFence = null;
}

module.exports = {
  init,
  disableWalAutoCheckpoint,
  onRejectedRows,
  reportRejectedRows,
  ensureSqlTable,
  isMigrated,
  markMigrated,
  loadRows,
  loadExistingRows,
  loadTableObject,
  loadExistingTableObject,
  loadExistingTablePath,
  loadExistingAbyssalInstances,
  loadExistingIncursionPending,
  loadExistingCareerRows,
  ensureCareerReadIndex,
  ensureCareerRowStorage,
  ensureDungeonReadIndexes,
  explodeToRows,
  assembleFromRows,
  isSharedSchemaTable,
  selectPath,
  rowValueForKey,
  rowGroupsFor,
  ROW_KEY_SEP,
  LEGACY_PERSISTENCE_OWNER_ROLE,
  STANDALONE_PERSISTENCE_OWNER_ROLE,
  DEFAULT_PERSISTENCE_OWNER_LEASE_MS,
  recoveryRetainsPersistenceOperations: true,
  assertPersistenceOwner,
  withPersistenceOwnerPublicationSync,
  acquirePersistenceOwner,
  renewPersistenceOwner,
  releasePersistenceOwner,
  adoptLegacyPersistenceOperations,
  enqueuePersistenceOperation,
  commitSynchronousChanges,
  enqueuePersistenceOperations,
  getPersistenceOperation,
  journalDeferredBatches,
  acknowledgeDeferredOperation,
  listPersistenceOperations,
  listAllPersistenceOperations,
  assertNoForeignPersistenceOperations,
  applyPersistenceOperation,
  acknowledgePersistenceOperation,
  acknowledgeRecoveredPersistenceOperations,
  reconcilePersistenceOperation,
  recoverPersistenceOperations,
  applyChanges,
  replaceAll,
  rowCount,
  getDatabasePath,
  readPageUsage,
  freeSpaceWarning,
  FREE_SPACE_WARNING_MIN_BYTES,
  isReadOnly,
  close,
};
