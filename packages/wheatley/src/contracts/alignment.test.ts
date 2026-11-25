// The SDK cannot depend on the private protocol package, so both define the shared Approval, command, and delivery
// vocabulary. These type assertions fail `pnpm typecheck` if the two drift apart.
import type {
  ApprovalDecision as ProtocolApprovalDecision,
  ApprovalOutcome as ProtocolApprovalOutcome,
  ApprovalResolution as ProtocolApprovalResolution,
  CommandName as ProtocolCommandName,
  DeliveryKind as ProtocolDeliveryKind,
} from "@wheatley/protocol";
import { CommandNameSchema } from "@wheatley/protocol";
import type {
  ApprovalDecision as SdkApprovalDecision,
  ApprovalOutcome as SdkApprovalOutcome,
  ApprovalResolution as SdkApprovalResolution,
  CommandName as SdkCommandName,
  DeliveryKind as SdkDeliveryKind,
} from "@wheatley/sdk";
import { BUILTIN_COMMANDS } from "@wheatley/sdk";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("protocol and SDK vocabulary", () => {
  it("uses the same Approval, command, and delivery types", () => {
    expectTypeOf<ProtocolApprovalDecision>().toEqualTypeOf<SdkApprovalDecision>();
    expectTypeOf<ProtocolApprovalOutcome>().toEqualTypeOf<SdkApprovalOutcome>();
    expectTypeOf<ProtocolCommandName>().toEqualTypeOf<SdkCommandName>();
    expectTypeOf<ProtocolDeliveryKind>().toEqualTypeOf<SdkDeliveryKind>();
    expectTypeOf<ProtocolApprovalResolution>().toExtend<SdkApprovalResolution>();
    expectTypeOf<SdkApprovalResolution>().toExtend<ProtocolApprovalResolution>();
  });

  it("lists the same built-in commands", () => {
    const names: ProtocolCommandName[] = BUILTIN_COMMANDS.map(
      (command) => command.name
    );

    const protocolNames = new Set(
      CommandNameSchema.anyOf.map((schema) => schema.const)
    );

    expect(new Set(names)).toStrictEqual(protocolNames);
    expect(names).toHaveLength(protocolNames.size);
  });
});
