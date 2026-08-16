import { spawn } from "node:child_process";

export interface RunOptions {
  input?: string;
  capture?: boolean;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [options.input === undefined ? "inherit" : "pipe", options.capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with status ${code}`));
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
