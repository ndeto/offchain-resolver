import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  createPublicClient,
  decodeAbiParameters,
  encodeAbiParameters,
  http as viemHttp,
} from "viem";
import { baseSepolia } from "viem/chains";

const TEXT_ABI = [
  {
    type: "function",
    name: "text",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "value", type: "string" }],
  },
] as const;

const DATA_ABI = [
  {
    type: "function",
    name: "data",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "value", type: "bytes" }],
  },
] as const;

loadEnvFile(".env.local");
loadEnvFile(".env");

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
const resolverAddress =
  process.env.BASE_SEPOLIA_AGENT_DELEGATIONS_RESOLVER_ADDRESS ??
  process.env.AGENT_DELEGATIONS_RESOLVER_ADDRESS;

if (!rpcUrl) {
  throw new Error("BASE_SEPOLIA_RPC_URL is required");
}

if (!resolverAddress) {
  throw new Error(
    "BASE_SEPOLIA_AGENT_DELEGATIONS_RESOLVER_ADDRESS (or AGENT_DELEGATIONS_RESOLVER_ADDRESS) is required"
  );
}

const client = createPublicClient({
  chain: baseSepolia,
  transport: viemHttp(rpcUrl),
});

const port = Number(process.env.PORT ?? 8787);

const server = http.createServer(async (req, res) => {
  if (!req.url || (req.url !== "/" && req.url !== "/agent-delegations")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const body = await readRawBody(req);
    console.log("Received offchain request:", body || "<empty>");

    const requestData = parseRequestData(body);
    if (!requestData) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing request data" }));
      return;
    }

    const [kind, node, key] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "string" }],
      requestData
    );

    if (kind !== 0 && kind !== 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Unsupported request kind: ${kind}` }));
      return;
    }

    const isText = kind === 0;
    const response = await client.readContract({
      address: resolverAddress as `0x${string}`,
      abi: isText ? TEXT_ABI : DATA_ABI,
      functionName: isText ? "text" : "data",
      args: [node as `0x${string}`, key],
    });

    const encoded = isText
      ? encodeAbiParameters([{ type: "string" }], [response as string])
      : encodeAbiParameters([{ type: "bytes" }], [response as `0x${string}`]);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: encoded }));
  } catch (error) {
    console.error("Gateway error:", error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(port, () => {
  console.log(
    `Agent delegations offchain resolver listening on http://localhost:${port}`
  );
});

async function readRawBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequestData(body: string): `0x${string}` | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.data === "string" && parsed.data.startsWith("0x")) {
      return parsed.data as `0x${string}`;
    }
  } catch {
    // Ignore invalid JSON.
  }
  if (body.startsWith("0x")) {
    return body as `0x${string}`;
  }
  return null;
}

function loadEnvFile(filename: string): void {
  const filePath = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
