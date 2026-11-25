// The `wheatley` executable: `bin/wheatley.js` imports the compiled form of this file.
import { processIo } from "./cli/io.js";
import { runCli } from "./cli/main.js";

const io = processIo();

process.exitCode = await runCli(process.argv.slice(2), io);

// Standard input keeps the event loop alive after a command that reads no input, so the CLI exits explicitly.
process.exit();
