/** Add future optional rules here; the server and lobby UI share this whitelist. */
export const RULE_OPTIONS = [
  {
    id: "friendlyRobber",
    label: "友善强盗",
    description: "强盗不能移动到低于 3 个公开胜利点玩家的建筑相邻地形，荒漠除外。",
    defaultValue: false,
    kind: "official",
    engineOption: "friendlyRobber",
  },
  {
    id: "mixedPortTrade",
    label: "通用港口混合兑换",
    description: "拥有通用 3:1 港口时，允许任意 3 张资源混合换 1 张；关闭时按官方规则使用同类资源。专用 2:1 港口不解锁混合兑换。",
    defaultValue: false,
    kind: "house",
    engineOption: "mixedPortTrade",
  },
  {
    id: "allowUndo",
    label: "允许撤销建造",
    description: "当前玩家可撤销尚未进入交易、掷骰、打牌或结束回合等后续操作的可逆建造。",
    defaultValue: true,
    kind: "house",
    engineOption: "allowUndo",
  },
  {
    id: "infiniteBank",
    label: "无限银行",
    description: "银行资源不受实体卡数量限制，产出、兑换与丰收不会因银行缺货中止；玩家仍须支付正常费用。",
    defaultValue: false,
    kind: "house",
    engineOption: "infiniteBank",
  },
  {
    id: "flexibleRoll",
    label: "自由掷骰时机",
    description: "主回合可以先交易和建造再掷骰；每回合仍只掷一次，未掷骰不能结束。配对玩家的第二行动者仍不掷骰。",
    defaultValue: false,
    kind: "house",
    engineOption: "flexibleRoll",
  },
  {
    id: "allowGifts",
    label: "允许赠送资源",
    description: "玩家报价可只付出或只索取资源，由对方接受；交易仍须包含当前行动玩家，不允许赠送发展卡。",
    defaultValue: false,
    kind: "house",
    engineOption: "allowGifts",
  },
  {
    id: "roundUpDiscard",
    label: "弃牌向上取整",
    description: "掷出 7 时，超过 7 张资源的玩家弃掉一半并向上取整；关闭时使用官方向下取整规则。",
    defaultValue: false,
    kind: "house",
    engineOption: "roundUpDiscard",
  },
] as const satisfies ReadonlyArray<{
  id: string; label: string; description: string; defaultValue: boolean;
  kind: "official" | "house"; engineOption: string;
}>;

export type RuleOptionId = typeof RULE_OPTIONS[number]["id"];
export type RuleFlagOptions = Record<RuleOptionId, boolean>;
export type RuleChanges = Partial<RuleFlagOptions>;

export type RuleProposal = {
  id: number;
  proposerId: string;
  changes: RuleChanges;
  votes: Record<string, boolean>;
  status: "pending" | "approved" | "rejected" | "withdrawn";
};

export type RuleVoteAction =
  | { type: "proposeRules"; changes: RuleChanges }
  | { type: "voteRules"; proposalId: number; approve: boolean }
  | { type: "withdrawRuleProposal"; proposalId: number };

/** Flat options remain supported; optional `rules` grouping is normalized to flat flags. */
export function normalizeRuleFlags(input: Record<string, unknown>, previous: Partial<RuleFlagOptions> = {}): RuleFlagOptions {
  const nestedValue = input.rules;
  if (nestedValue !== undefined && (!nestedValue || typeof nestedValue !== "object" || Array.isArray(nestedValue))) {
    throw new Error("可选规则必须是规则名称与开关组成的对象。");
  }
  const nested = (nestedValue ?? {}) as Record<string, unknown>;
  const names = new Set<string>(RULE_OPTIONS.map((rule) => rule.id));
  if (Object.keys(nested).some((key) => !names.has(key))) throw new Error("存在尚未支持的可选规则。");
  const result = {} as RuleFlagOptions;
  for (const rule of RULE_OPTIONS) {
    const flatValue = input[rule.id];
    const groupedValue = nested[rule.id];
    if ((flatValue !== undefined && typeof flatValue !== "boolean") || (groupedValue !== undefined && typeof groupedValue !== "boolean")) {
      throw new Error(`${rule.label}必须为开启或关闭。`);
    }
    if (flatValue !== undefined && groupedValue !== undefined && flatValue !== groupedValue) {
      throw new Error(`${rule.label}的设置存在冲突。`);
    }
    result[rule.id] = (groupedValue ?? flatValue ?? previous[rule.id] ?? rule.defaultValue) as boolean;
  }
  return result;
}
