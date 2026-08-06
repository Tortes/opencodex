#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "src/adapters/openai-chat.ts");
let source = await readFile(path, "utf8");
const before = `      const qwenVllmCompat = applyQwenVllmRequestCompat(body, provider, tools !== undefined);\n      if (qwenVllmCompat.thinkingDisabled) {\n        reasoningLog = {\n          effectiveEffort: "none",\n          wireField: "chat_template_kwargs.enable_thinking",\n          wireValue: false,\n        };\n      }`;
const after = `      applyQwenVllmRequestCompat(body, provider, tools !== undefined);`;
if (!source.includes(before)) throw new Error("Qwen-vLLM reasoning log compatibility block not found");
source = source.replace(before, after);
await writeFile(path, source);
console.log(`Removed unsupported custom reasoningLog wire field from ${path}`);
