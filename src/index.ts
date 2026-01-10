import fs from "node:fs";
import path from "node:path";
import express from "express";
import {
  createPublicClient,
  decodeFunctionData,
  decodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
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

const BATCH_GATEWAY_ABI = [
  {
    name: "query",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        type: "tuple[]",
        name: "queries",
        components: [
          { type: "address", name: "sender" },
          { type: "string[]", name: "urls" },
          { type: "bytes", name: "data" },
        ],
      },
    ],
    outputs: [
      { type: "bool[]", name: "failures" },
      { type: "bytes[]", name: "responses" },
    ],
  },
] as const;

const SOLIDITY_ERROR = [
  {
    name: "Error",
    type: "error",
    inputs: [{ name: "message", type: "string" }],
  },
] as const;

type ReadTextArgs = {
  address: `0x${string}`;
  node: `0x${string}`;
  key: string;
};

type ReadDataArgs = {
  address: `0x${string}`;
  node: `0x${string}`;
  key: string;
};

loadEnvFile(".env.local");
loadEnvFile(".env");

// Base Sepolia resolver read via RPC to build CCIP responses.
const rpcUrl = process.env.SEPOLIA_RPC_URL;
const resolverAddress =
  process.env.BASE_SEPOLIA_AGENT_DELEGATIONS_RESOLVER_ADDRESS;

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

const app = express();

app.use(express.text({ type: "*/*" }));

app.post(["/", "/agent-delegations"], async (req, res) => {
  try {
    // Parse the raw body to extract CCIP-Read request bytes.
    const body =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    console.log("Received offchain request:", body || "<empty>");

    const requestData = parseRequestData(body);
    if (!requestData) {
      return res.status(400).json({ error: "Missing request data" });
    }

    const batchResponse = await tryHandleBatchGateway(requestData);
    if (batchResponse) {
      // Universal Resolver batch payload: respond with encoded batch results.
      return res.status(200).json({ data: batchResponse });
    }

    // Direct payload from a resolver: decode and read the onchain resolver.
    const [kind, node, key] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "string" }],
      requestData
    );

    if (kind !== 0 && kind !== 1) {
      return res
        .status(400)
        .json({ error: `Unsupported request kind: ${kind}` });
    }

    const isText = kind === 0;
    const response = isText
      ? await readText({
          address: resolverAddress as `0x${string}`,
          node: node as `0x${string}`,
          key,
        })
      : await readData({
          address: resolverAddress as `0x${string}`,
          node: node as `0x${string}`,
          key,
        });

    const encoded = isText
      ? encodeAbiParameters([{ type: "string" }], [response as string])
      : encodeAbiParameters([{ type: "bytes" }], [response as `0x${string}`]);

    return res.status(200).json({ data: encoded });
  } catch (error) {
    console.error("Gateway error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.all("*", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default app;

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`Offchain resolver listening on http://localhost:${port}`);
  });
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

async function tryHandleBatchGateway(
  data: `0x${string}`
): Promise<`0x${string}` | null> {
  // Batch payloads are ABI-encoded calls to query((sender, urls, data)[]).
  try {
    const decoded = decodeFunctionData({
      abi: BATCH_GATEWAY_ABI,
      data,
    });
    if (decoded.functionName !== "query") return null;
    const queries = decoded.args[0] as Array<{
      sender: `0x${string}`;
      urls: string[];
      data: `0x${string}`;
    }>;

    const failures: boolean[] = [];
    const responses: `0x${string}`[] = [];

    await Promise.all(
      queries.map(async (query, index) => {
        try {
          responses[index] = await resolveDirectRequest(query.data);
          failures[index] = false;
        } catch (error) {
          failures[index] = true;
          responses[index] = encodeBatchError(error);
        }
      })
    );

    return encodeFunctionResult({
      abi: BATCH_GATEWAY_ABI,
      functionName: "query",
      result: [failures, responses],
    });
  } catch {
    return null;
  }
}

async function resolveDirectRequest(
  data: `0x${string}`
): Promise<`0x${string}`> {
  // Resolve a single CCIP-Read payload against the onchain resolver.
  const [kind, node, key] = decodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes32" }, { type: "string" }],
    data
  );

  if (kind !== 0 && kind !== 1) {
    throw new Error(`Unsupported request kind: ${kind}`);
  }

  const isText = kind === 0;
  const response = isText
    ? await readText({
        address: resolverAddress as `0x${string}`,
        node: node as `0x${string}`,
        key,
      })
    : await readData({
        address: resolverAddress as `0x${string}`,
        node: node as `0x${string}`,
        key,
      });

  return isText
    ? encodeAbiParameters([{ type: "string" }], [response as string])
    : encodeAbiParameters([{ type: "bytes" }], [response as `0x${string}`]);
}

function encodeBatchError(error: unknown): `0x${string}` {
  // Encode an error as a Solidity Error(string) for batch responses.
  const message = error instanceof Error ? error.message : "Gateway error";
  return encodeErrorResult({
    abi: SOLIDITY_ERROR,
    errorName: "Error",
    args: [message],
  });
}

async function readText(args: ReadTextArgs): Promise<string> {
  const { address, node, key } = args;
  return client.readContract({
    address,
    abi: TEXT_ABI,
    functionName: "text",
    args: [node, key],
  } as unknown as Parameters<typeof client.readContract>[0]) as Promise<string>;
}

async function readData(args: ReadDataArgs): Promise<`0x${string}`> {
  const { address, node, key } = args;
  return client.readContract({
    address,
    abi: DATA_ABI,
    functionName: "data",
    args: [node, key],
  } as unknown as Parameters<typeof client.readContract>[0]) as Promise<`0x${string}`>;
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
