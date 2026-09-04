import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The full keyless demo story, end to end, against real web + worker processes and a real
 * Postgres, using only the `mock-*` providers (no API key, no spend). One serial test rather than
 * several: every later step depends on state (the project, the chunk sets, the test set, the
 * configs, the run) created by the step before it, and Playwright's page/context don't survive
 * across separate `test()` blocks without extra plumbing that would only reintroduce the same
 * dependency by hand.
 *
 * Fixture design (see fixture.md and its 18 short, topically distinct sections): with the default
 * `fixed` chunker (200 tokens, 40 overlap) the document chunks into 6 pieces, and the mock
 * bag-of-words embedding ranks the first generated question's OWN chunk 4th out of 6 for its own
 * query -- a reproducible, deterministic miss at topK 1 (and a reproducible hit at topK 5), which
 * is what gives the run's grid both a hit and a miss to exercise Diagnose against. Confirmed by
 * simulating chunkFixed/samplePassages/mockGenerateQa/hashEmbed directly over this file before
 * wiring up the browser flow.
 */

const SCREENSHOT_DIR = join(__dirname, "screenshots");

/** Scopes a locator to the `<section>` whose SectionHead heading matches exactly -- every form
 * on the project/run pages lives inside one of these, and several field labels ("Name",
 * "Embedding model") are reused verbatim across sections, so an unscoped `getByLabel` is ambiguous. */
function section(page: Page, heading: string): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

/** Selects a <select> option by matching its visible text rather than its value, for the two
 * selects (chunk set, test set) whose option value is an opaque id the test never sees directly. */
async function selectByOptionText(select: Locator, textMatch: RegExp): Promise<void> {
  const option = select.locator("option").filter({ hasText: textMatch }).first();
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  if (value === null) throw new Error(`option matching ${textMatch} has no value`);
  await select.selectOption(value);
}

/** Polls a chunk-set row's "Embeddings" cell until its coverage reads "model N/N" with N > 0 --
 * i.e. every chunk in the set has a vector for that model and a config can retrieve against it. */
async function waitForFullEmbedding(row: Locator, model: string, timeoutMs: number): Promise<void> {
  await expect(async () => {
    const text = await row.innerText();
    const m = text.match(new RegExp(`${model}\\s+(\\d+)/(\\d+)`));
    expect(m, `no "${model} n/n" coverage found in row text: ${text}`).not.toBeNull();
    const [, embedded, total] = m!;
    expect(Number(total)).toBeGreaterThan(0);
    expect(embedded).toBe(total);
  }).toPass({ timeout: timeoutMs, intervals: [1000] });
}

test.describe.configure({ mode: "serial" });

test("demo mode: signup through a diagnosed evidence page", async ({ page }, testInfo) => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const stamp = Date.now();
  const email = `e2e-${stamp}@ragbench.test`;
  const password = "correct-horse-battery-staple";

  await test.step("signup", async () => {
    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByLabel("Organization").fill(`RAGBench E2E ${stamp}`);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/login");
  });

  await test.step("login", async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForURL("**/projects");
  });

  const projectName = `Demo project ${stamp}`;
  await test.step("create project", async () => {
    await page.getByLabel("New project").fill(projectName);
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByRole("link", { name: projectName }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]+$/);
  });

  await test.step("upload the fixture document", async () => {
    const buffer = readFileSync(join(__dirname, "fixture.md"));
    await section(page, "Documents")
      .getByLabel("Add a document")
      .setInputFiles({ name: "fixture.md", mimeType: "text/markdown", buffer });
    await section(page, "Documents").getByRole("button", { name: "Upload" }).click();
    const row = section(page, "Documents").getByRole("row", { name: /fixture\.md/ });
    await expect(row.getByText("ready", { exact: true })).toBeVisible({ timeout: 60_000 });
  });

  await test.step("create the fixed + mock-embedding chunk set", async () => {
    const chunkSets = section(page, "Chunk sets");
    // Chunker defaults to "fixed" and there is nothing else to pick for it.
    await chunkSets.getByLabel("Embedding model").selectOption("mock-embedding");
    await chunkSets.getByRole("button", { name: "Create chunk set" }).click();
    const row = chunkSets.getByRole("row", { name: /fixed/ });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await waitForFullEmbedding(row, "mock-embedding", 60_000);
  });

  await test.step("create a second (heading) chunk set", async () => {
    const chunkSets = section(page, "Chunk sets");
    await chunkSets.getByLabel("Chunker").selectOption("heading");
    // Left at "(no embedding)" deliberately -- this set exists to prove a project can hold more
    // than one chunking strategy side by side, not to be run against.
    await chunkSets.getByRole("button", { name: "Create chunk set" }).click();
    await expect(chunkSets.getByRole("row", { name: /heading/ })).toBeVisible({ timeout: 30_000 });
  });

  const testSetName = `Demo test set ${stamp}`;
  await test.step("generate a test set (mock-llm, 5 questions)", async () => {
    const testSets = section(page, "Test sets");
    await testSets.getByLabel("Name").fill(testSetName);
    // Generator model defaults to mock-llm, which is what this run needs to stay keyless.
    await testSets.getByLabel("Questions").fill("5");
    await testSets.getByRole("button", { name: "Generate test set" }).click();
    const row = testSets.getByRole("row", { name: new RegExp(testSetName) });
    await expect(row.getByText("ready", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText("5");
  });

  const wideConfigName = `wide-k5-${stamp}`;
  const narrowConfigName = `narrow-k1-${stamp}`;
  await test.step("create two configs on the fixed chunk set (topK 5 and topK 1)", async () => {
    const configs = section(page, "RAG configs");
    await configs.getByLabel("Name").fill(wideConfigName);
    await selectByOptionText(configs.getByLabel("Chunk set"), /^fixed /);
    // Selecting the chunk set auto-fills Embedding model with the one model it has vectors for
    // (mock-embedding); Top K is left at its default of 5.
    await configs.getByRole("button", { name: "Create config" }).click();
    await expect(configs.getByRole("row", { name: new RegExp(wideConfigName) })).toBeVisible();

    await configs.getByLabel("Name").fill(narrowConfigName);
    await selectByOptionText(configs.getByLabel("Chunk set"), /^fixed /);
    await configs.getByLabel("Top K").fill("1");
    await configs.getByRole("button", { name: "Create config" }).click();
    await expect(configs.getByRole("row", { name: new RegExp(narrowConfigName) })).toBeVisible();
  });

  let runId = "";
  await test.step("start a full-mode run (mock judge) over both configs", async () => {
    const runs = section(page, "Evaluation runs");
    await selectByOptionText(runs.getByLabel("Test set"), new RegExp(testSetName));
    await runs.getByRole("checkbox", { name: new RegExp(`^${wideConfigName}`) }).check();
    await runs.getByRole("checkbox", { name: new RegExp(`^${narrowConfigName}`) }).check();
    // Mode "full", judge "mock-llm" and answer "mock-llm" are all already the defaults.
    await runs.getByRole("button", { name: "Start run" }).click();

    const runRow = runs.getByRole("row", { name: new RegExp(testSetName) });
    await expect(runRow).toBeVisible({ timeout: 10_000 });
    const runLink = runRow.getByRole("link", { name: "View" });
    const href = await runLink.getAttribute("href");
    if (!href) throw new Error("run row has no View link");
    runId = href.split("/").pop() ?? "";
    await runLink.click();
    await page.waitForURL(/\/runs\/[0-9a-f-]+$/);
  });

  await test.step("wait for the run to finish and the grid to fill in", async () => {
    // 2 configs x 5 questions = 10 cells. pg-boss polls at ~2s and the mock providers evaluate in
    // well under a second each, but CI runners are slower, hence the generous budget.
    await expect(page.getByRole("button", { name: /: (hit|miss) —/ })).toHaveCount(10, { timeout: 90_000 });
  });

  await test.step("screenshot the run grid", async () => {
    const path = join(SCREENSHOT_DIR, "run-grid.png");
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach("run-grid", { path, contentType: "image/png" });
  });

  await test.step("open the miss, diagnose it, see the verdict badge", async () => {
    // The fixture guarantees exactly one miss cell, on the topK-1 ("narrow") config.
    const missCell = page.getByRole("button", { name: /: miss —/ }).first();
    await expect(missCell).toBeVisible();
    await missCell.click();

    const drawer = page.getByRole("region", { name: "Result detail" });
    await expect(drawer.getByRole("heading", { name: "Retrieved chunks" })).toBeVisible();

    await drawer.getByRole("button", { name: "Diagnose" }).click();
    await expect(drawer.getByText(/^(chunking|embedding|retrieval|unanswerable)$/)).toBeVisible({
      timeout: 30_000,
    });

    await drawer.getByRole("link", { name: /Evidence/ }).click();
    await page.waitForURL(/\/results\/[0-9a-f-]+$/);
  });

  await test.step("evidence page shows the gold mark and a chunk-boundary tick", async () => {
    await expect(page.locator("mark")).toHaveCount(1, { timeout: 10_000 });
    // A boundary tick renders as a span with the `rb-tick` class and a "chunk N starts here"
    // title -- present as long as the window contains at least one chunk start, which it does
    // here (the fixture chunks into 6 pieces and the whole ~5.4kB document fits inside the
    // +/-2000 char window around any gold span in it).
    await expect(page.locator(".rb-tick").first()).toHaveAttribute("title", /chunk \d+ starts here/);
    await expect(page.getByText(/^(chunking|embedding|retrieval|unanswerable)$/)).toBeVisible();
  });

  await test.step("screenshot the evidence page", async () => {
    const path = join(SCREENSHOT_DIR, "evidence.png");
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach("evidence", { path, contentType: "image/png" });
  });

  // Sanity: the run id captured off the grid's "View" link is the same one the evidence page's
  // own "back to run" link points at, i.e. the whole story stayed on one run throughout.
  await test.step("evidence page links back to the same run", async () => {
    await expect(page.getByRole("link", { name: /Back to run/ })).toHaveAttribute("href", `/runs/${runId}`);
  });
});
