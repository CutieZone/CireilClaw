import * as vb from "valibot";

const nonEmptyString = vb.pipe(vb.string(), vb.nonEmpty());

// Simple string condition schema with validation
const ConditionStringSchema = vb.message(
  vb.pipe(
    vb.string(),
    vb.check(
      (str) =>
        str === "discord:nsfw" ||
        str === "discord:dm" ||
        /^discord:dm:\d+$/.test(str) ||
        /^discord:guild:\d+$/.test(str) ||
        /^discord:channel:\d+$/.test(str) ||
        str === "tui" ||
        str === "internal",
    ),
  ),
  "Invalid condition format. Supported: discord:nsfw, discord:dm[:id], discord:guild:id, discord:channel:id, tui, internal",
);

const WhenSchema = vb.union([
  ConditionStringSchema,
  vb.pipe(vb.array(ConditionStringSchema), vb.minLength(1)),
]);

const LogicModeSchema = vb.exactOptional(vb.picklist(["and", "or"]), "or");

const BlockActionSchema = vb.literal("load");

const PathActionSchema = vb.picklist(["allow", "deny"]);

const BlockRuleSchema = vb.strictObject({
  action: BlockActionSchema,
  mode: LogicModeSchema,
  when: WhenSchema,
});

const PathRuleSchema = vb.strictObject({
  action: PathActionSchema,
  mode: LogicModeSchema,
  when: WhenSchema,
});

const ConditionsConfigSchema = vb.strictObject({
  blocks: vb.exactOptional(vb.record(nonEmptyString, BlockRuleSchema), {}),
  memories: vb.exactOptional(vb.record(nonEmptyString, PathRuleSchema), {}),
  workspace: vb.exactOptional(vb.record(nonEmptyString, PathRuleSchema), {}),
});

type ConditionsConfig = vb.InferOutput<typeof ConditionsConfigSchema>;
type BlockRule = vb.InferOutput<typeof BlockRuleSchema>;
type PathRule = vb.InferOutput<typeof PathRuleSchema>;
type Condition = vb.InferOutput<typeof ConditionStringSchema>;

export {
  ConditionsConfigSchema,
  BlockRuleSchema,
  PathRuleSchema,
  ConditionStringSchema as ConditionSchema,
  WhenSchema,
  LogicModeSchema,
};
export type { ConditionsConfig, BlockRule, PathRule, Condition };
