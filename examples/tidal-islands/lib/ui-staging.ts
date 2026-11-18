/** Pure local card staging. These helpers never deduct the authoritative hand. */
export const RES = ["wood", "brick", "sheep", "wheat", "ore"] as const;
export type Resource = typeof RES[number];
export type ResourceCounts = Record<Resource, number>;
export type ResourceSelection = Partial<ResourceCounts>;
export type BuildKind = "road" | "settlement" | "city" | "development";

export const BUILD_COSTS: Readonly<Record<BuildKind, Readonly<ResourceSelection>>> = Object.freeze({
  road: Object.freeze({ wood: 1, brick: 1 }),
  settlement: Object.freeze({ wood: 1, brick: 1, sheep: 1, wheat: 1 }),
  city: Object.freeze({ wheat: 2, ore: 3 }),
  development: Object.freeze({ sheep: 1, wheat: 1, ore: 1 }),
});

const resourceSet = new Set<string>(RES);
const blank = (): ResourceCounts => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const total = (value: ResourceCounts) => RES.reduce((sum, resource) => sum + value[resource], 0);

function parseCounts(value: unknown): ResourceCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !resourceSet.has(key))) return null;
  const counts = blank();
  for (const resource of RES) {
    const amount = Object.hasOwn(input, resource) ? input[resource] : 0;
    if (!Number.isSafeInteger(amount) || (amount as number) < 0) return null;
    counts[resource] = amount as number;
  }
  return Number.isSafeInteger(total(counts)) ? counts : null;
}

function requireCounts(value: unknown, label: string): ResourceCounts {
  const parsed = parseCounts(value);
  if (!parsed) throw new Error(`${label}只能包含五种资源，数量须为非负安全整数。`);
  return parsed;
}

/** Available cards after local staging; stale over-staging cannot show negatives. */
export function availableHand(hand: unknown, staged: unknown): ResourceCounts {
  const inventory = requireCounts(hand, "手牌");
  const selected = requireCounts(staged, "暂存牌");
  const result = blank();
  for (const resource of RES) result[resource] = Math.max(0, inventory[resource] - selected[resource]);
  return result;
}

export function canStage(hand: unknown, staged: unknown, resource: unknown): boolean {
  const inventory = parseCounts(hand);
  const selected = parseCounts(staged);
  return !!inventory && !!selected && typeof resource === "string" && resourceSet.has(resource)
    && inventory[resource as Resource] > selected[resource as Resource];
}

/** Extra staged cards are allowed; the caller keeps any unused cards staged. */
export function coversCost(staged: unknown, cost: unknown): boolean {
  const selected = parseCounts(staged);
  const required = parseCounts(cost);
  return !!selected && !!required && RES.every((resource) => selected[resource] >= required[resource]);
}

/** Resource sufficiency alone; turn phase and board placement are checked separately. */
export function stagedBuildAffordability(staged: unknown): Record<BuildKind, boolean> {
  return {
    road: coversCost(staged, BUILD_COSTS.road),
    settlement: coversCost(staged, BUILD_COSTS.settlement),
    city: coversCost(staged, BUILD_COSTS.city),
    development: coversCost(staged, BUILD_COSTS.development),
  };
}

/** Consume exactly one local build payment while preserving all excess staged cards. */
export function spendStagedBuild(staged: unknown, kind: unknown): ResourceCounts {
  const selected = requireCounts(staged, "暂存牌");
  if (typeof kind !== "string" || !Object.hasOwn(BUILD_COSTS, kind)) throw new Error("建造类型无效。");
  const cost = BUILD_COSTS[kind as BuildKind];
  if (!coversCost(selected, cost)) throw new Error("暂存资源不足以支付本次建造。");
  for (const resource of RES) selected[resource] -= cost[resource] ?? 0;
  return selected;
}

export function stagedBuildOptions(staged: unknown, legal: unknown): Record<BuildKind, boolean> {
  const none = { road: false, settlement: false, city: false, development: false };
  if (!parseCounts(staged) || !legal || typeof legal !== "object" || Array.isArray(legal)) return none;
  const affordable = stagedBuildAffordability(staged);
  const actions = legal as Record<string, unknown>;
  const hasPlaces = (key: string) => Array.isArray(actions[key]) && actions[key].length > 0;
  return {
    road: hasPlaces("roads") && affordable.road,
    settlement: hasPlaces("settlements") && affordable.settlement,
    city: hasPlaces("cities") && affordable.city,
    development: actions.canBuyDevelopment === true && affordable.development,
  };
}

export type MaritimeQuote = { valid: boolean; receiveCount: number; reason: string };

/** Quotes only the payment basket; desired cards and bank stock are server checked. */
export function maritimeQuote(
  staged: unknown,
  mode: "bank" | "port",
  bankRatios: unknown,
  hasGenericPort: boolean,
  mixedEnabled: boolean,
  mixed: boolean,
): MaritimeQuote {
  const invalid = (reason: string): MaritimeQuote => ({ valid: false, receiveCount: 0, reason });
  const selected = parseCounts(staged);
  if (!selected) return invalid("暂存牌只能包含五种资源，数量须为非负安全整数。");
  if (mode !== "bank" && mode !== "port") return invalid("请选择银行或港口兑换。");
  if ([hasGenericPort, mixedEnabled, mixed].some((flag) => typeof flag !== "boolean")) return invalid("港口规则设置无效。");
  if (!total(selected)) return invalid("请先放入需要兑换的资源牌。");
  if (mixed) {
    if (mode !== "port") return invalid("银行只能使用每组 4 张同类资源。");
    if (!mixedEnabled) return invalid("本局未开启通用港口混合兑换。");
    if (!hasGenericPort) return invalid("混合兑换需要拥有通用 3:1 港口。");
    if (total(selected) % 3) return invalid("混合兑换须每 3 张资源组成一组。");
    return { valid: true, receiveCount: total(selected) / 3, reason: "" };
  }

  const ratios: Record<string, unknown> = {};
  if (mode === "port") {
    if (!bankRatios || typeof bankRatios !== "object" || Array.isArray(bankRatios)) return invalid("港口兑换比例无效。");
    for (const [resource, ratio] of Object.entries(bankRatios)) {
      if (!resourceSet.has(resource) || ![2, 3, 4].includes(ratio as number)) return invalid("港口兑换比例无效。");
      ratios[resource] = ratio;
    }
  }
  let receiveCount = 0;
  for (const resource of RES) {
    if (!selected[resource]) continue;
    const ratio = mode === "bank" ? 4 : (ratios[resource] ?? 4) as number;
    if (mode === "port" && ratio >= 4) return invalid("暂存牌中有资源尚无可用港口，请使用银行或调整资源。");
    if (selected[resource] % ratio) return invalid(`每种资源必须按 ${ratio}:1 比例放入完整组，不能合并零散组。`);
    receiveCount += selected[resource] / ratio;
  }
  return { valid: true, receiveCount, reason: "" };
}

export function canDiscard(staged: unknown, required: unknown): boolean {
  const selected = parseCounts(staged);
  return !!selected && Number.isSafeInteger(required) && (required as number) >= 0 && total(selected) === required;
}

/** Reconcile after a newer server hand arrives; neither argument is mutated. */
export function reconcileStaged(hand: unknown, staged: unknown): ResourceCounts {
  const inventory = requireCounts(hand, "手牌");
  const selected = requireCounts(staged, "暂存牌");
  const result = blank();
  for (const resource of RES) result[resource] = Math.min(inventory[resource], selected[resource]);
  return result;
}
