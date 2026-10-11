import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "subscriptions-package-"));
const tarball = join(scratch, "package.tgz");
async function run(command) {
    const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Package check failed (${exitCode}): ${command.join(" ")}`);
}
try {
    await run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", tarball, "--quiet"]);
    await run(["bunx", "--bun", "publint", tarball]);
    await run(["bunx", "--bun", "attw", tarball, "--ignore-rules", "no-resolution", "--ignore-rules", "cjs-resolves-to-esm"]);
} finally {
    await rm(scratch, { recursive: true, force: true });
}
