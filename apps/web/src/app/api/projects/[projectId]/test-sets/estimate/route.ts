import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { documents } from "@ragbench/db";
import { CHEAP_LLM, DEFAULT_PASSAGE_CHARS, estimateLlmCostUsd, lookupLlmModel } from "@ragbench/core";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { auth } from "@/auth";
import { requireProject } from "@/lib/projects";
import type { Session } from "next-auth";

const EstimateQuery = z.object({
  model: z.string().min(1),
  count: z.coerce.number().int().min(1).max(200),
});

// Per-question generator cost: a fixed prompt/instructions overhead plus the passage itself, at
// the same window samplePassages actually cuts (DEFAULT_PASSAGE_CHARS), converted to tokens at
// the conventional ~4 chars/token. Output is the generation call's maxTokens ceiling in practice.
const BASE_INPUT_TOKENS = 350;
const GENERATOR_OUTPUT_TOKENS = 200;
// The triviality gate runs once per candidate question on a second, cheap model (CHEAP_LLM) --
// but only for real generators. Mock mode never calls it (generate-testset.ts skips the gate
// entirely when the generator is mock), so it must not inflate a mock estimate either.
const GATE_INPUT_TOKENS = 150;
const GATE_OUTPUT_TOKENS = 10;

export async function estimateTestSet(projectId: string, req: Request, session: Session | null) {
  if (!session?.user?.organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await requireProject(projectId, session);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  const parsed = EstimateQuery.safeParse({
    model: url.searchParams.get("model"),
    count: url.searchParams.get("count"),
  });
  if (!parsed.success) return NextResponse.json({ error: "invalid query" }, { status: 400 });
  const { model, count } = parsed.data;

  const modelEntry = lookupLlmModel(model);
  if (!modelEntry) return NextResponse.json({ error: `unknown model: ${model}` }, { status: 400 });

  const perQuestionInput = BASE_INPUT_TOKENS + DEFAULT_PASSAGE_CHARS / 4;
  const generatorInputTokens = count * perQuestionInput;
  const generatorOutputTokens = count * GENERATOR_OUTPUT_TOKENS;
  const isMock = modelEntry.provider === "mock";

  const gateInputTokens = isMock ? 0 : count * GATE_INPUT_TOKENS;
  const gateOutputTokens = isMock ? 0 : count * GATE_OUTPUT_TOKENS;

  const estimatedUsd = estimateLlmCostUsd(model, generatorInputTokens, generatorOutputTokens)
    + (isMock ? 0 : estimateLlmCostUsd(CHEAP_LLM, gateInputTokens, gateOutputTokens));

  const [{ readyCount }] = await getDb()
    .select({ readyCount: sql<number>`count(*)`.mapWith(Number) })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.status, "ready")));

  const body: Record<string, unknown> = {
    inputTokens: generatorInputTokens + gateInputTokens,
    outputTokens: generatorOutputTokens + gateOutputTokens,
    estimatedUsd,
    documents: readyCount,
  };
  if (readyCount === 0) body.warning = "project has no ready documents yet -- generation will yield an empty set";

  return NextResponse.json(body);
}

export async function GET(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return estimateTestSet(projectId, req, await auth());
}
