import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PLUGIN_ID } from "./server/config";
import { createTitleEngine } from "./server/engine";
import { describeBinaries } from "./server/generate";
import { autoTitleSettings, scanRpc } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  console.log(`[${PLUGIN_ID}] 启动，外部命令 ${describeBinaries()}`);

  const settings = server.registerSettings(autoTitleSettings);
  const engine = createTitleEngine(settings);

  const offCreateBefore = server.addHook("agent.create.before", async ({ request }) => {
    engine.onCreateBefore(request);
    return undefined;
  });

  const offCreateAfter = server.addHook("agent.create.after", async ({ agent }) => {
    engine.onCreateAfter(agent);
  });

  const offTurnBefore = server.addHook("agent.turn.before", async ({ agent }) => {
    engine.onTurnBefore(agent);
  });

  const offTurnAfter = server.addHook(
    "agent.turn.after",
    async ({ agent, turnId, outcome }, context) => {
      await engine.onTurnAfter(agent, turnId, outcome, context.paseo);
    },
  );

  const offArchive = server.addHook("agent.archive.after", async ({ agent }) => {
    engine.onArchive(agent);
  });

  server.handle(scanRpc, async (input, context) => engine.scan(context.paseo, input));

  return () => {
    engine.dispose();
    offCreateBefore();
    offCreateAfter();
    offTurnBefore();
    offTurnAfter();
    offArchive();
  };
}
