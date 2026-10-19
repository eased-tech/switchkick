import { CLIENTS, type Client, clientEnv } from "./clients.js";
import {
  CommandError,
  type CommandIo,
  configEndpoint,
  loadCommandConfig,
  parseCommand,
} from "./command.js";

export const ENV_HELP = `Usage: switchkick env <client> [--config <path>]

Prints shell commands that point a client at switchkick for the current shell only:

  eval "$(switchkick env openai)"

Clients:
  openai   OPENAI_BASE_URL and OPENAI_API_KEY, for OpenAI SDK apps
  claude   ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_MAX_OUTPUT_TOKENS
  codex    an alias that passes switchkick as Codex's model provider

The address comes from the config file's server settings. The API key is a placeholder that
switchkick ignores, or SWITCHKICK_TOKEN when it is set.
`;

/** `switchkick env <client>`. */
export async function envCommand(argv: string[], io: CommandIo): Promise<number> {
  const { values, positionals } = parseCommand(argv, { config: { type: "string" } }, ENV_HELP);
  if (values.help) {
    io.stdout(ENV_HELP);
    return 0;
  }
  const [client, ...extra] = positionals;
  if (
    client === undefined ||
    extra.length > 0 ||
    !(CLIENTS as readonly string[]).includes(client)
  ) {
    throw new CommandError(
      `${client === undefined ? "name a client" : `unknown client: ${[client, ...extra].join(" ")}`}` +
        ` (one of ${CLIENTS.join(", ")})\n\n${ENV_HELP}`,
    );
  }
  const loaded = await loadCommandConfig(values.config, io.env);
  io.stdout(clientEnv(client as Client, configEndpoint(loaded, io.env)));
  return 0;
}
