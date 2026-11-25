import type {
  FrontendSink,
  InboundCommand,
  InboundDecision,
  InboundMessage,
} from "@wheatley-ai/sdk";
import { BUILTIN_COMMANDS } from "@wheatley-ai/sdk";

/** A `FrontendSink` that records every call. `decide` resolves `decideResult`. */
export class RecordingSink implements FrontendSink {
  readonly commands = BUILTIN_COMMANDS;
  readonly messages: InboundMessage[] = [];
  readonly commandCalls: InboundCommand[] = [];
  readonly decisions: InboundDecision[] = [];
  decideResult = true;

  readonly send = async (message: InboundMessage): Promise<void> => {
    await Promise.resolve();
    this.messages.push(message);
  };

  readonly command = async (command: InboundCommand): Promise<void> => {
    await Promise.resolve();
    this.commandCalls.push(command);
  };

  readonly decide = async (decision: InboundDecision): Promise<boolean> => {
    await Promise.resolve();
    this.decisions.push(decision);

    return this.decideResult;
  };
}
