// Creates the lab's two stacks on Cycle, pointed at this repo on GitHub so
// every build uses the stack files from the latest commit on the branch.
// Safe to re-run: a stack that already exists is left alone.
//
// Creating a stack only registers it; nothing is built or deployed and it
// costs nothing.
//
// Run: npm run stacks

import { must } from "./lib/api.js";
import { API_URL, cycle } from "./lib/config.js";
import { loadLab } from "./lib/lab.js";

async function findStack(identifier: string): Promise<{ id: string } | undefined> {
  const existing = await must(
    `look up stack ${identifier}`,
    cycle().GET("/v1/stacks", { params: { query: { filter: { identifier } } } }),
  );
  return existing.data.find(
    (s) => s.identifier === identifier && s.state.current !== "deleted" && s.state.current !== "deleting",
  );
}

async function main(): Promise<void> {
  const lab = loadLab();
  console.log(`Stacks on ${API_URL} from ${lab.repo.url} (${lab.repo.branch})\n`);

  for (const stack of Object.values(lab.stacks)) {
    // A create isn't safe to repeat blindly: if Cycle made the stack but the
    // response was lost, a second create would duplicate it. So after any
    // failure, look again before creating again.
    const deadline = Date.now() + 5 * 60_000;
    while (true) {
      const found = await findStack(stack.identifier);
      if (found !== undefined) {
        console.log(`  exists   ${stack.identifier}  ${found.id}`);
        break;
      }
      try {
        const created = await must(
          `create stack ${stack.identifier}`,
          cycle().POST("/v1/stacks", {
            body: {
              name: stack.name,
              identifier: stack.identifier,
              variables: stack.variables,
              source: {
                type: "git-repo",
                details: {
                  url: lab.repo.url,
                  branch: lab.repo.branch,
                  stack_file: stack.file,
                },
              },
            },
          }),
        );
        console.log(`  created  ${stack.identifier}  ${created.data.id}`);
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          throw err;
        }
        console.log(`  create ${stack.identifier} failed (${err instanceof Error ? err.message : String(err)}); checking again in 10s`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  console.log("\nNext: build and deploy them into their environments (Claude does this through the MCP for now).");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
